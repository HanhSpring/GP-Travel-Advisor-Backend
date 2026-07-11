"""
two_tower_training.py

FastAPI endpoint cho Phase 1 "Admin trigger retrain" (docs/trigger/02-target-architecture.md):
- POST /prepare-dataset: chạy scripts/export_training_data.py::run_export() qua run_in_executor,
  upload lên R2, trả về manifest — NestJS ghi vào ai_config.training_datasets.
- POST /reload: hot-reload Two-Tower đang serving sau khi admin bấm "Kích hoạt" 1 model_version
  mới (KHÔNG train ở đây — train chạy trên Modal GPU, xem ai-service/modal_training/).

Việc trigger job GPU trên Modal do NestJS gọi thẳng (không qua ai-service) — ai-service chỉ chịu
trách nhiệm phần cần chạy Python/pandas/TensorFlow (export dữ liệu, build + swap model mới), theo
đúng khuôn mẫu app/api/v1/endpoints/session_cf_training.py (run_in_executor, không block event loop).
"""
from __future__ import annotations

import asyncio
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

from fastapi import APIRouter, HTTPException

from app.core.logger import get_logger
from app.schemas.two_tower_training import (
    PrepareDatasetRequest,
    PrepareDatasetResponse,
    ReloadRequest,
    ReloadResponse,
    TrainRequest,
    TrainResponse,
)

logger = get_logger(__name__)

router = APIRouter(prefix="/two-tower-training", tags=["Two-Tower Training"])

_SCRIPTS_DIR = Path(__file__).resolve().parents[4] / "scripts"


def _utc_now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _run_prepare_dataset_sync(run_id: str | None) -> dict:
    """Import trễ (lazy) để không tải scripts/ + pandas/supabase lúc ai-service khởi động nếu
    chưa ai gọi endpoint này — cùng lý do với session_cf_training.py."""
    if str(_SCRIPTS_DIR) not in sys.path:
        sys.path.insert(0, str(_SCRIPTS_DIR))
    from export_training_data import run_export  # type: ignore[import-not-found]

    return run_export(run_id=run_id)


@router.post(
    "/prepare-dataset",
    response_model=PrepareDatasetResponse,
    summary="Export dữ liệu Supabase thật ra JSONL + upload R2 (Phase 0)",
)
async def prepare_dataset(request: PrepareDatasetRequest) -> PrepareDatasetResponse:
    start_time = time.time()
    started_at = _utc_now_iso()
    logger.info(f"[endpoint] Two-Tower prepare-dataset requested: run_id={request.run_id}")

    try:
        loop = asyncio.get_event_loop()
        result = await loop.run_in_executor(None, _run_prepare_dataset_sync, request.run_id)

        completed_at = _utc_now_iso()
        duration = round(time.time() - start_time, 2)
        logger.info(f"[endpoint] Two-Tower prepare-dataset completed in {duration}s")
        return PrepareDatasetResponse(
            **result,
            started_at=started_at,
            completed_at=completed_at,
            duration_seconds=duration,
        )
    except Exception as exc:
        duration = round(time.time() - start_time, 2)
        logger.error(
            f"[endpoint] Two-Tower prepare-dataset failed after {duration}s: {exc}", exc_info=True
        )
        raise HTTPException(status_code=500, detail=str(exc)) from exc


@router.post(
    "/train",
    response_model=TrainResponse,
    summary="Spawn job GPU train Two-Tower thật trên Modal (Phase 2 — docs/trigger/06-modal-primary-plan.md)",
)
async def train(request: TrainRequest) -> TrainResponse:
    """Proxy MONG toi Modal Web Endpoint (trigger_training trong modal_app.py) -- KHONG dung
    run_in_executor vi ban than lenh goi Modal chi mat vai tram ms (Modal tu spawn job GPU o phia
    ho), khac voi prepare-dataset/reload (can chay dong bo pandas/TensorFlow nang trong thread
    executor). Modal se tu goi lai webhook training-callback (NestJS) khi train xong."""
    from app.core.config import settings

    if not settings.modal_trigger_training_url or not settings.modal_trigger_secret:
        raise HTTPException(
            status_code=500,
            detail="Chua cau hinh MODAL_TRIGGER_TRAINING_URL/MODAL_TRIGGER_SECRET (.env) — "
                   "xem docs/trigger/06-modal-primary-plan.md muc 2-3.",
        )

    import httpx

    try:
        async with httpx.AsyncClient(timeout=10) as client:
            resp = await client.post(
                settings.modal_trigger_training_url,
                json={
                    "run_id": request.run_id,
                    "dataset_r2_prefix": request.dataset_r2_prefix,
                    "warm_start_weights_r2_key": request.warm_start_weights_r2_key,
                    "warm_start_vocab_r2_key": request.warm_start_vocab_r2_key,
                    "include_yelp": request.include_yelp,
                    "is_demo_mode": request.is_demo_mode,
                    "secret": settings.modal_trigger_secret,
                },
            )
        resp.raise_for_status()
        return TrainResponse(**resp.json())
    except Exception as exc:
        logger.error(f"[endpoint] Two-Tower train (Modal trigger) failed: {exc}", exc_info=True)
        raise HTTPException(status_code=502, detail=str(exc)) from exc


def _run_reload_sync(request: ReloadRequest) -> None:
    """Tải weights/vocab mới vào thư mục staging riêng (KHÔNG ghi đè file đang dùng), build model
    mới, chỉ swap nếu build thành công — xem app/api/deps.py::reload_two_tower()."""
    from app.api.deps import reload_two_tower

    reload_two_tower(request.weights_r2_key, request.vocab_r2_key)


@router.post(
    "/reload",
    response_model=ReloadResponse,
    summary="Hot-reload Two-Tower đang serving sau khi promote 1 model_version mới",
)
async def reload_two_tower_endpoint(request: ReloadRequest) -> ReloadResponse:
    start_time = time.time()
    started_at = _utc_now_iso()
    logger.info(
        f"[endpoint] Two-Tower reload requested: weights={request.weights_r2_key}, "
        f"vocab={request.vocab_r2_key}"
    )

    try:
        loop = asyncio.get_event_loop()
        await loop.run_in_executor(None, _run_reload_sync, request)

        completed_at = _utc_now_iso()
        duration = round(time.time() - start_time, 2)
        logger.info(f"[endpoint] Two-Tower reload completed in {duration}s")
        return ReloadResponse(
            success=True,
            model_version_id=request.model_version_id,
            started_at=started_at,
            completed_at=completed_at,
            duration_seconds=duration,
        )
    except Exception as exc:
        duration = round(time.time() - start_time, 2)
        # reload_two_tower() chỉ swap con trỏ SAU KHI build model mới thành công -- model cũ vẫn
        # đang chạy bình thường ở đây, KHÔNG có lúc nào service rơi vào trạng thái không có model.
        logger.error(f"[endpoint] Two-Tower reload failed after {duration}s: {exc}", exc_info=True)
        raise HTTPException(status_code=500, detail=str(exc)) from exc
