"""
session_cf_training.py

FastAPI endpoint để admin trigger train lại Session-Aware CF Reranker (Funk-SVD) từ
GP-Travel-Advisor-Web/src/pages/admin/AlgorithmRunner — theo đúng khuôn mẫu
review_pipeline.py (chạy in-process qua run_in_executor, KHÔNG spawn subprocess/script riêng).

Logic train thật nằm ở ai-service/scripts/train_session_cf.py::run_training() — file này chỉ
là lớp mỏng gọi lại đúng hàm đó (tách sys.path để import 1 file trong scripts/, vốn không phải
package) và hot-reload SessionCfReranker đang serving sau khi export xong, không cần restart
ai-service. Xem docs/create-data/04-execution-runbook-and-demo-script.md Bước 2-3.
"""

from __future__ import annotations

import asyncio
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

from fastapi import APIRouter, HTTPException

from app.core.logger import get_logger
from app.schemas.session_cf_training import (
    SessionCfTrainingRequest,
    SessionCfTrainingResponse,
)

logger = get_logger(__name__)

router = APIRouter(prefix="/session-cf-training", tags=["Session CF Training"])

# Lưu lịch sử chạy trong bộ nhớ (tồn tại trong session, reset khi restart) — cùng kiểu với
# review_pipeline.py, KHÔNG phải nguồn sự thật (ai_config.algorithm_logs bên NestJS mới là).
_run_history: list[dict] = []

_SCRIPTS_DIR = Path(__file__).resolve().parents[4] / "scripts"


def _utc_now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _run_sync(request: SessionCfTrainingRequest) -> dict:
    """Chạy đồng bộ (blocking) trong thread executor — KHÔNG async, vì Supabase fetch (phân
    trang) + Funk-SVD fit đều là code đồng bộ. Import trễ (lazy) để không tải scripts/ lúc
    ai-service khởi động nếu chưa ai gọi endpoint này."""
    if str(_SCRIPTS_DIR) not in sys.path:
        sys.path.insert(0, str(_SCRIPTS_DIR))
    from train_session_cf import run_training  # type: ignore[import-not-found]

    result = run_training(
        lookback_days=request.lookback_days,
        export=not request.dry_run,
        upload_r2=request.upload_r2 and not request.dry_run,
    )

    # Hot-reload đúng instance đang serving live traffic — không cần restart ai-service để
    # thấy hiệu ứng ngay. An toàn vì SessionCfReranker.load() chỉ đọc lại file/gán thuộc tính,
    # không có state nào khác phụ thuộc thứ tự khởi tạo.
    if result["exported"]:
        from app.api.deps import get_model

        engine = get_model("session_cf_reranker")
        if engine is not None:
            engine.load()
            logger.info("✓ Đã hot-reload SessionCfReranker sau khi train lại — không cần restart.")

    return result


@router.post(
    "/run",
    response_model=SessionCfTrainingResponse,
    summary="Train lại Session-Aware CF Reranker (Funk-SVD) từ dữ liệu Supabase thật",
)
async def run_session_cf_training(
    request: SessionCfTrainingRequest,
) -> SessionCfTrainingResponse:
    """
    Kích hoạt lại toàn bộ pipeline train (xem scripts/train_session_cf.py):
    - Đọc travel.activity_logs + review_ai.reviews từ Supabase (đã seed hoặc production thật)
    - Gộp explicit (review) + implicit (activity_logs), train Funk-SVD
    - Export 8 file artifact, upload R2 (tuỳ chọn), hot-reload model đang serving
    """
    start_time = time.time()
    started_at = _utc_now_iso()
    logger.info(
        f"[endpoint] Session-CF training requested: lookback_days={request.lookback_days}, "
        f"upload_r2={request.upload_r2}, dry_run={request.dry_run}"
    )

    try:
        loop = asyncio.get_event_loop()
        result = await loop.run_in_executor(None, _run_sync, request)

        completed_at = _utc_now_iso()
        duration = round(time.time() - start_time, 2)
        record = {
            **result,
            "run_id": f"session_cf_{started_at}",
            "success": True,
            "started_at": started_at,
            "completed_at": completed_at,
            "duration_seconds": duration,
            "error": None,
        }
        _run_history.insert(0, record)
        logger.info(f"[endpoint] Session-CF training completed in {duration}s")
        return SessionCfTrainingResponse(**record)

    except Exception as exc:
        completed_at = _utc_now_iso()
        duration = round(time.time() - start_time, 2)
        logger.error(f"[endpoint] Session-CF training failed after {duration}s: {exc}", exc_info=True)
        raise HTTPException(status_code=500, detail=str(exc)) from exc
