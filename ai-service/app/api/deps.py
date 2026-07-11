import threading

from app.core.logger import get_logger

logger = get_logger(__name__)
_models: dict = {}
_models_lock = threading.RLock()


def load_all_models():
    """Gọi trong lifespan của FastAPI. Load toàn bộ model vào memory."""
    # Download artifact từ Cloudflare R2 nếu chưa có local.
    _ensure_remote_artifacts()

    _load_bge_m3()
    _load_two_tower()
    _load_content_based()
    _load_collaborative()
    _load_session_cf_reranker()
    _load_review_classifier()
    _load_hybrid_recommender()
    logger.info("✅ All models loaded successfully")


def _ensure_remote_artifacts():
    """Download data + recommender_artifacts từ R2 (nếu được cấu hình)."""
    try:
        from app.core.config import settings
        from app.core.r2_downloader import ensure_artifacts

        artifact_dir, data_dir = ensure_artifacts(settings)
        _models["_artifact_dir"] = str(artifact_dir)
        _models["_data_dir"] = str(data_dir)
    except Exception as e:
        logger.warning("Không thể đồng bộ R2 artifacts: %s — dùng local path", e)


def _load_hybrid_recommender():
    try:
        from app.core.config import settings
        from app.models.hybrid_recommender import HybridRecommender

        # Ưu tiên path đã download từ R2, fallback sang local setting
        artifact_dir = _models.get("_artifact_dir", settings.reco_artifact_dir)
        data_dir = _models.get("_data_dir", settings.reco_data_dir)

        engine = HybridRecommender(artifact_dir, data_dir)
        if engine.load():
            _models["hybrid_recommender"] = engine
            logger.info("Loaded: Hybrid Recommender")
        else:
            logger.warning("Hybrid Recommender artifacts not found — skipping")
    except Exception as e:
        logger.warning(f"Hybrid Recommender load failed: {e}")


def reload_hybrid_recommender() -> bool:
    """Load a fresh engine and atomically swap it in after successful retraining."""
    try:
        _ensure_remote_artifacts()
        from app.core.config import settings
        from app.models.hybrid_recommender import HybridRecommender

        artifact_dir = _models.get("_artifact_dir", settings.reco_artifact_dir)
        data_dir = _models.get("_data_dir", settings.reco_data_dir)
        fresh = HybridRecommender(artifact_dir, data_dir)
        if not fresh.load():
            logger.error("Hot reload rejected: new recommender artifact is incomplete")
            return False
        _models["hybrid_recommender"] = fresh
        logger.info("✅ Hybrid Recommender hot-reloaded")
        return True
    except Exception as exc:
        logger.exception("Hybrid Recommender hot reload failed: %s", exc)
        return False


def _load_bge_m3():
    try:
        from sentence_transformers import SentenceTransformer
        _models["bge_m3"] = SentenceTransformer("BAAI/bge-m3")
        logger.info("Loaded: BGE-M3")
    except Exception as e:
        logger.warning(f"BGE-M3 load failed: {e}")


def _download_two_tower_weights(vocab_path: str, weights_path: str) -> None:
    """Download Two-Tower weights từ R2 về local nếu chưa có."""
    import os
    try:
        from app.core.config import settings
        from app.core.r2_downloader import _r2_configured, _make_client

        if not _r2_configured(settings):
            logger.warning("R2 chưa cấu hình — bỏ qua download Two-Tower weights")
            return

        client = _make_client(settings)
        bucket = settings.r2_bucket_name

        for local_path, r2_key in [
            (vocab_path, settings.two_tower_vocab_r2_key),
            (weights_path, settings.two_tower_weights_r2_key),
        ]:
            if os.path.exists(local_path):
                logger.info("  ✓ Dùng cache local: %s", local_path)
                continue
            os.makedirs(os.path.dirname(local_path) or ".", exist_ok=True)
            logger.info("⬇ Downloading r2://%s/%s → %s", bucket, r2_key, local_path)
            client.download_file(bucket, r2_key, local_path)
            logger.info("  ✓ Download hoàn tất: %s", local_path)
    except Exception as e:
        logger.error("Không thể download Two-Tower weights từ R2: %s", e)


def _load_two_tower():
    import os
    from app.core.config import settings

    vocab_path   = settings.two_tower_vocab_path
    weights_path = settings.two_tower_weights_path

    # Nếu file chưa có local → thử download từ R2
    # if not os.path.exists(vocab_path) or not os.path.exists(weights_path):
    _download_two_tower_weights(vocab_path, weights_path)

    if not os.path.exists(vocab_path):
        logger.warning(f"Two Tower vocab not found at {vocab_path!r} — skipping")
        return
    if not os.path.exists(weights_path):
        logger.warning(f"Two Tower weights not found at {weights_path!r} — skipping")
        return

    try:
        from app.models.two_tower import build_inference_model
        query_tower = build_inference_model(vocab_path, weights_path)
        _models["two_tower"] = query_tower
        logger.info("Loaded: Two Tower (QueryTower ready for inference)")
    except Exception as e:
        logger.error(f"Two Tower load failed: {e}")


def _load_content_based():
    import os, pickle
    path = "weights/content_based.pkl"
    if os.path.exists(path):
        with open(path, "rb") as f:
            _models["content_based"] = pickle.load(f)
        logger.info("Loaded: Content-Based")
    else:
        logger.warning("Content-Based weights not found — skipping")


def _load_collaborative():
    import os, pickle
    path = "weights/collaborative.pkl"
    if os.path.exists(path):
        with open(path, "rb") as f:
            _models["collaborative"] = pickle.load(f)
        logger.info("Loaded: Collaborative Filtering")
    else:
        logger.warning("Collaborative Filtering weights not found — skipping")


def _sync_session_cf_artifacts_from_r2() -> None:
    """Download artifacts_session_cf/ từ R2 nếu đã cấu hình — mirror _download_two_tower_weights().

    Trước đây SessionCfReranker là model DUY NHẤT trong 3 hệ (Two-Tower, HybridRecommender của
    Ngọc, SessionCfReranker) KHÔNG nằm trong luồng tự đồng bộ R2 — _ensure_remote_artifacts()
    chỉ sync đúng 2 prefix "recommender_artifacts/" và "data/" (dùng cho HybridRecommender), nên
    dù R2 đã cấu hình, SessionCfReranker vẫn chỉ đọc local. Hàm này vá đúng lỗ hổng đó, dùng lại
    ensure_r2_prefix() (đã có sẵn trong r2_downloader.py, vốn dùng cho HuggingFace checkpoint) —
    tải THẲNG vào settings.session_cf_artifact_dir (không qua artifact_cache_dir riêng như
    HybridRecommender), để load() bên dưới đọc đúng path đã cấu hình, không cần đổi gì thêm."""
    try:
        from pathlib import Path

        from app.core.config import settings
        from app.core.r2_downloader import _r2_configured, ensure_r2_prefix

        if not _r2_configured(settings):
            logger.info(
                "R2 chưa cấu hình — SessionCfReranker dùng local path: %s",
                settings.session_cf_artifact_dir,
            )
            return

        ensure_r2_prefix(settings, "artifacts_session_cf", Path(settings.session_cf_artifact_dir))
        logger.info("✓ Đã đồng bộ artifacts_session_cf/ từ R2")
    except Exception as e:
        logger.warning("Không thể đồng bộ artifacts_session_cf từ R2: %s — dùng local nếu có", e)


def _load_session_cf_reranker():
    try:
        from app.core.config import settings
        from app.models.session_cf_reranker import SessionCfReranker

        _sync_session_cf_artifacts_from_r2()

        try:
            from supabase import create_client
            supabase_client = create_client(settings.supabase_url, settings.supabase_key)
        except Exception as e:
            logger.warning(
                "Không tạo được Supabase client cho SessionCfReranker "
                "(live session sẽ bỏ qua): %s", e
            )
            supabase_client = None

        engine = SessionCfReranker(settings.session_cf_artifact_dir, supabase_client)
        if engine.load():
            # Tận dụng item-level CF của Ngọc (b_i + global_mean từ 73k user Foody)
            # làm prior cho cold-start users — không cần map user_id giữa 2 hệ thống.
            # Dùng đúng path artifact_dir mà HybridRecommender đã sync từ R2
            # (_ensure_remote_artifacts() chạy trước _load_session_cf_reranker() trong
            # load_all_models() nên _models["_artifact_dir"] đã sẵn sàng ở đây).
            ngoc_dir = _models.get("_artifact_dir", settings.reco_artifact_dir)
            if ngoc_dir:
                ok = engine.load_ngoc_item_prior(ngoc_dir)
                if ok:
                    logger.info("✅ Ngọc item prior đã được gắn vào SessionCfReranker")
                else:
                    logger.info("Ngọc item prior không load được — dùng zero fallback cho cold-start")
            _models["session_cf_reranker"] = engine
            logger.info("Loaded: Session-Aware CF Reranker")
        else:
            logger.warning("Session-Aware CF Reranker artifacts not found — skipping")
    except Exception as e:
        logger.warning(f"Session-Aware CF Reranker load failed: {e}")


def _load_review_classifier():
    import os
    path = "weights/review_classifier.pt"
    if os.path.exists(path):
        import torch
        from app.models.review_classifier import ReviewClassifier
        model = ReviewClassifier()
        model.load_state_dict(torch.load(path, map_location="cpu"))
        model.eval()
        _models["review_classifier"] = model
        logger.info("Loaded: Review Classifier")
    else:
        logger.warning("Review Classifier weights not found — skipping")


def get_model(name: str):
    return _models.get(name)


def reload_two_tower(weights_r2_key: str, vocab_r2_key: str) -> None:
    """Hot-reload Two-Tower đang serving sau khi admin promote 1 model_version mới (docs/trigger/
    02-target-architecture.md mục 2.5). Tải weights/vocab MỚI vào thư mục staging riêng (KHÔNG
    ghi đè file đang dùng), build model mới hoàn toàn độc lập (build_inference_model() tự chạy 1
    forward-pass warmup — nếu vocab/shape sai, exception raise NGAY ĐÂY, _models["two_tower"] cũ
    không hề bị đụng tới), CHỈ swap con trỏ nếu build thành công. Request đang xử lý dở dùng model
    cũ vẫn chạy bình thường (Python giữ reference cũ tới khi garbage collect), request MỚI sau
    swap dùng model mới ngay — không downtime, không tăng latency."""
    import shutil
    from pathlib import Path

    from app.core.config import settings
    from app.core.r2_downloader import _make_client, _r2_configured
    from app.models.two_tower import build_inference_model

    if not _r2_configured(settings):
        raise RuntimeError("R2 chưa cấu hình — không thể tải weights mới (xem app/core/config.py)")

    staging_dir = Path(settings.artifact_cache_dir) / "two_tower_staging"
    staging_dir.mkdir(parents=True, exist_ok=True)
    staging_vocab = staging_dir / "vocab.pkl"
    staging_weights = staging_dir / "best_model.weights.h5"

    client = _make_client(settings)
    bucket = settings.r2_bucket_name
    logger.info("⬇ [reload] Downloading r2://%s/%s -> %s", bucket, vocab_r2_key, staging_vocab)
    client.download_file(bucket, vocab_r2_key, str(staging_vocab))
    logger.info("⬇ [reload] Downloading r2://%s/%s -> %s", bucket, weights_r2_key, staging_weights)
    client.download_file(bucket, weights_r2_key, str(staging_weights))

    new_model = build_inference_model(str(staging_vocab), str(staging_weights))

    with _models_lock:
        _models["two_tower"] = new_model
    logger.info("✅ [reload] Đã swap Two-Tower sang model mới (weights=%s)", weights_r2_key)

    # Persist ra canonical local path để lần restart process tiếp theo cũng dùng đúng bản này --
    # chỉ làm SAU KHI swap in-memory thành công, tránh canonical path bị hỏng dở nếu build lỗi.
    try:
        import os

        os.makedirs(os.path.dirname(settings.two_tower_vocab_path) or ".", exist_ok=True)
        shutil.copyfile(staging_vocab, settings.two_tower_vocab_path)
        shutil.copyfile(staging_weights, settings.two_tower_weights_path)
    except Exception as e:
        logger.warning(
            "[reload] Model mới đã hoạt động (in-memory) nhưng ghi canonical local path thất "
            "bại (%s) -- lần restart process tiếp theo có thể quay lại bản cũ, cần kiểm tra thủ "
            "công thư mục %s.", e, settings.two_tower_vocab_path,
        )
