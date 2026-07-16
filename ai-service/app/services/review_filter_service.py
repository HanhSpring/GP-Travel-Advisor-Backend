"""
review_filter_service.py

Thin wrapper: nhận PipelineRunRequest, kết nối Supabase, chạy pipeline,
ghi kết quả về DB và trả về dict summary cho endpoint.
"""

from __future__ import annotations

from pathlib import Path
from threading import Lock
from typing import Any, Dict

from app.core.config import settings
from app.core.logger import get_logger
from app.core.r2_downloader import ensure_r2_prefix
from app.schemas.review_pipeline import PipelineRunRequest
from app.services.review_filter_pipeline import (
    DEFAULT_EMBEDDING_MODEL,
    DEFAULT_SENTIMENT_MODEL,
    DEFAULT_TOPIC_MODEL,
    DEFAULT_ZEROSHOT_MODEL,
    PipelineConfig,
    ReviewFilteringPipeline,
    _create_supabase_client,
    apply_algorithm3_db_updates,
    fetch_pending_reviews,
    mark_conflicted_contents,
    utc_now,
    write_conflicts_to_db,
    write_contents_to_db,
)

logger = get_logger(__name__)

_PIPELINE_RUN_LOCK = Lock()
_MODEL_PROVIDER_CACHE: Dict[str, tuple[Any, Any]] = {}

_AI_SERVICE_DIR = Path(__file__).resolve().parents[2]


def _resolve_ai_service_path(path_value: str) -> Path:
    path = Path(path_value)
    if path.is_absolute():
        return path
    return _AI_SERVICE_DIR / path


def _is_valid_phobert_checkpoint(path: Path) -> bool:
    if not path.exists() or not path.is_dir():
        return False
    has_config = (path / "config.json").is_file()
    has_weights = any(
        (path / name).is_file()
        for name in ("model.safetensors", "pytorch_model.bin", "tf_model.h5")
    )
    has_tokenizer = any(
        (path / name).is_file()
        for name in ("tokenizer_config.json", "vocab.txt", "bpe.codes")
    )
    return has_config and has_weights and has_tokenizer


def _resolve_phobert_time_model_path() -> str | None:
    """Return a local filesystem path for the PhoBERT time-label model."""
    r2_prefix = (settings.phobert_time_model_r2_prefix or "").strip()
    if r2_prefix:
        cache_dir = _resolve_ai_service_path(settings.phobert_time_model_cache_dir)
        logger.info(
            "[pipeline] Sync PhoBERT time model from R2 prefix '%s' to '%s'",
            r2_prefix,
            cache_dir,
        )
        try:
            synced_path = ensure_r2_prefix(settings, r2_prefix, cache_dir)
            if _is_valid_phobert_checkpoint(synced_path):
                return str(synced_path)
            logger.warning(
                "[pipeline] PhoBERT R2 cache is incomplete at '%s'. Fallback to local path.",
                synced_path,
            )
        except Exception as exc:
            logger.warning(
                "[pipeline] Cannot sync PhoBERT model from R2: %s. Fallback to local path.",
                exc,
            )

    local_path = (settings.phobert_time_model_path or "").strip()
    if not local_path:
        return None

    path = _resolve_ai_service_path(local_path)
    if not _is_valid_phobert_checkpoint(path):
        logger.warning("[pipeline] PhoBERT local checkpoint is missing or incomplete: %s", path)
        return None
    return str(path)


def run_pipeline(request: PipelineRunRequest) -> Dict[str, Any]:
    # Transformer initialization and inference are memory intensive. Serialize
    # runs so a manual trigger and the scheduler cannot load duplicate models.
    with _PIPELINE_RUN_LOCK:
        return _run_pipeline(request)


def _run_pipeline(request: PipelineRunRequest) -> Dict[str, Any]:
    """Thực thi pipeline phân loại review. Trả về dict summary."""

    now = utc_now()
    batch_label = f"supabase_batch_{now.strftime('%Y%m%d_%H%M%S')}"
    batch_output_dir = Path(settings.pipeline_output_dir) / batch_label
    use_pretrained = not request.no_pretrained

    logger.info(f"[pipeline] Khởi động batch '{batch_label}', pretrained={use_pretrained}")

    supabase = _create_supabase_client()

    reviews = fetch_pending_reviews(supabase, limit=request.limit)
    logger.info(f"[pipeline] Fetched {len(reviews)} pending reviews")

    empty_result: Dict[str, Any] = {
        "run_id": batch_label,
        "total_reviews": 0,
        "contents_processed": 0,
        "conflicts_detected": 0,
        "long_term_summaries": 0,
        "hidden_reviews": 0,
        "output_dir": str(batch_output_dir),
        "embedding_model_active": False,
        "sentiment_model_active": False,
        "zeroshot_model_active": False,
        "phobert_model_active": False,
    }

    if not reviews:
        if not request.dry_run:
            algorithm3_updates = apply_algorithm3_db_updates(
                supabase,
                {},
                now.isoformat(),
            )
            empty_result["hidden_reviews"] = algorithm3_updates[
                "expired_reviews_hidden"
            ]
            logger.info(
                "[pipeline] Không có review pending; đã cập nhật short-term hết hạn: %s",
                algorithm3_updates,
            )
        else:
            logger.info("[pipeline] Không có review pending; dry_run bỏ qua ghi DB.")
        return empty_result

    phobert_time_model_path = _resolve_phobert_time_model_path()

    config = PipelineConfig(
        input_label=batch_label,
        output_dir=batch_output_dir,
        now=now,
        use_pretrained_model=use_pretrained,
        embedding_model_name=DEFAULT_EMBEDDING_MODEL,
        use_pretrained_classifiers=use_pretrained,
        sentiment_model_name=DEFAULT_SENTIMENT_MODEL,
        zeroshot_model_name=DEFAULT_ZEROSHOT_MODEL,
        topic_model_name=DEFAULT_TOPIC_MODEL,
        classifier_confidence_threshold=request.classifier_confidence_threshold,
        classifier_ambiguity_margin=request.classifier_ambiguity_margin,
        topic_other_threshold=request.topic_other_threshold,
        old_lookback_multiplier=6,
        promotion_mode=request.promotion_mode,
        conflict_score_threshold=request.conflict_score_threshold,
        max_candidates_per_review=request.max_candidates_per_review or None,
        ttl_hours_by_topic=request.ttl_hours_by_topic,
        observation_rules=request.observation_rules,
        lookback_multiplier_by_topic=request.lookback_multiplier_by_topic,
        phobert_time_model_path=phobert_time_model_path,
        save_json=settings.pipeline_save_json,
    )

    cache_key = "|".join([
        str(use_pretrained),
        config.embedding_model_name,
        config.sentiment_model_name,
        str(config.zeroshot_model_name),
        config.topic_model_name,
        str(config.phobert_time_model_path),
    ])
    cached_providers = _MODEL_PROVIDER_CACHE.get(cache_key)
    logger.info(
        "[pipeline] Model providers: %s",
        "reuse cached providers" if cached_providers else "initialize providers",
    )
    pipeline = ReviewFilteringPipeline(
        config,
        supabase_client=supabase,
        embedding_provider=cached_providers[0] if cached_providers else None,
        classifier_provider=cached_providers[1] if cached_providers else None,
    )
    if cached_providers is None:
        _MODEL_PROVIDER_CACHE.clear()
        _MODEL_PROVIDER_CACHE[cache_key] = (
            pipeline.embedding_provider,
            pipeline.classifier_provider,
        )
    if not pipeline.classifier_provider.phobert_time_active:
        logger.warning(
            "[pipeline] PhoBERT time-label model is not active. path=%s error=%s",
            phobert_time_model_path,
            pipeline.classifier_provider.phobert_time_error,
        )
    report, contents, conflicts = pipeline.run(reviews)

    algorithm3_updates = None
    if not request.dry_run:
        contents_to_write = [*contents, *pipeline.algorithm3_historical_updates]
        contents_to_write = list(
            {str(item["id"]): item for item in contents_to_write}.values()
        )
        logger.info(
            "[pipeline] Ghi %d contents về Supabase (%d cập nhật lịch sử từ Algorithm 3)...",
            len(contents_to_write),
            len(pipeline.algorithm3_historical_updates),
        )
        write_contents_to_db(supabase, contents_to_write)
        logger.info(f"[pipeline] Ghi {len(conflicts)} conflicts về Supabase...")
        write_conflicts_to_db(supabase, conflicts)
        mark_conflicted_contents(supabase, conflicts)
        algorithm3_updates = apply_algorithm3_db_updates(
            supabase,
            pipeline.algorithm3_result,
            now.isoformat(),
        )
        logger.info(
            "[pipeline] Da ap dung ket qua Algorithm 3 vao Supabase: %s",
            algorithm3_updates,
        )
    else:
        logger.info("[pipeline] dry_run=True — bỏ qua ghi DB.")

    return {
        "run_id": batch_label,
        "total_reviews": report["total_reviews"],
        "contents_processed": report["algorithm1_total_contents"],
        "conflicts_detected": report["algorithm2_total_conflicts"],
        "long_term_summaries": report["algorithm3_total_long_term_summaries"],
        "hidden_reviews": (
            algorithm3_updates["expired_reviews_hidden"]
            + algorithm3_updates["long_term_reviews_hidden"]
            if algorithm3_updates is not None
            else report["algorithm3_total_hidden_reviews"]
        ),
        "output_dir": str(batch_output_dir),
        "embedding_model_active": report["embedding_model"]["active"],
        "sentiment_model_active": report["classifier_models"]["sentiment"]["active"],
        "zeroshot_model_active": report["classifier_models"]["zeroshot"]["active"],
        "phobert_model_active": report["classifier_models"]["phobert_time"]["active"],
    }
