"""
review_pipeline.py

FastAPI endpoints để kích hoạt và theo dõi pipeline phân loại review ngắn hạn.
"""

from __future__ import annotations

import asyncio
import time
from datetime import datetime, timezone
from typing import List

from fastapi import APIRouter, HTTPException

from app.core.logger import get_logger
from app.schemas.review_pipeline import (
    PipelineHistoryItem,
    PipelineHistoryResponse,
    PipelineRunRequest,
    PipelineRunResponse,
)

logger = get_logger(__name__)

router = APIRouter(prefix="/review-pipeline", tags=["Review Pipeline"])

# Lưu lịch sử chạy trong bộ nhớ (tồn tại trong session, reset khi restart service)
_run_history: List[dict] = []


def _utc_now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


@router.post("/run", response_model=PipelineRunResponse, summary="Chạy pipeline phân loại review")
async def run_review_pipeline(request: PipelineRunRequest) -> PipelineRunResponse:
    """
    Kích hoạt pipeline lọc đánh giá ngắn hạn:
    - Lấy các review pending từ Supabase
    - Phân loại topic, time_label, sentiment (3 thuật toán)
    - Ghi kết quả về review_ai.review_contents và review_ai.review_conflicts
    """
    from app.services.review_filter_service import run_pipeline

    start_time = time.time()
    started_at = _utc_now_iso()
    logger.info(f"[endpoint] Pipeline run requested: limit={request.limit}, pretrained={not request.no_pretrained}")

    try:
        loop = asyncio.get_event_loop()
        result = await loop.run_in_executor(None, run_pipeline, request)

        completed_at = _utc_now_iso()
        duration = round(time.time() - start_time, 2)

        record = {
            **result,
            "started_at": started_at,
            "completed_at": completed_at,
            "duration_seconds": duration,
            "success": True,
            "error": None,
        }
        _run_history.insert(0, record)
        logger.info(f"[endpoint] Pipeline completed in {duration}s — {result['total_reviews']} reviews")
        return PipelineRunResponse(**record)

    except Exception as exc:
        completed_at = _utc_now_iso()
        duration = round(time.time() - start_time, 2)
        logger.error(f"[endpoint] Pipeline failed after {duration}s: {exc}", exc_info=True)

        record = {
            "run_id": f"failed_{started_at}",
            "total_reviews": 0,
            "contents_processed": 0,
            "conflicts_detected": 0,
            "long_term_summaries": 0,
            "hidden_reviews": 0,
            "output_dir": "",
            "started_at": started_at,
            "completed_at": completed_at,
            "duration_seconds": duration,
            "embedding_model_active": False,
            "sentiment_model_active": False,
            "zeroshot_model_active": False,
            "phobert_model_active": False,
            "success": False,
            "error": str(exc),
        }
        _run_history.insert(0, record)
        raise HTTPException(status_code=500, detail=str(exc))


@router.get("/history", response_model=PipelineHistoryResponse, summary="Lịch sử chạy pipeline")
async def get_pipeline_history(limit: int = 20) -> PipelineHistoryResponse:
    """Trả về danh sách các lần chạy pipeline gần nhất (trong session hiện tại)."""
    items = _run_history[:max(1, limit)]
    return PipelineHistoryResponse(
        history=[PipelineHistoryItem(**item) for item in items],
        total=len(_run_history),
    )
