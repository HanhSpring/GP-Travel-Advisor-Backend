"""API điều chỉnh cấu hình thuật toán gợi ý (hệ số khoảng cách của Hybrid Recommender).

model_weight luôn = 1 - distance_weight, nên chỉ cần truyền distance_weight.
"""

import httpx
from fastapi import APIRouter, HTTPException

from app.schemas.ai_config import UpdateDistanceWeightRequest, WeightsResponse
from app.services import ai_config_service as svc

router = APIRouter()


@router.get(
    "/hybrid/weights",
    response_model=WeightsResponse,
    summary="Xem trọng số hiện tại của Hybrid Recommender",
)
def get_hybrid_weights():
    try:
        return svc.get_weights()
    except svc.AiConfigError as e:
        raise HTTPException(status_code=503, detail=str(e))
    except httpx.HTTPError as e:
        raise HTTPException(status_code=502, detail=f"Lỗi gọi Supabase: {e}")


@router.put(
    "/hybrid/weights",
    response_model=WeightsResponse,
    summary="Điều chỉnh hệ số khoảng cách (model = 1 - distance)",
)
def update_hybrid_weights(req: UpdateDistanceWeightRequest):
    try:
        return svc.update_distance_weight(req.distance_weight, req.actor)
    except svc.AiConfigError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except httpx.HTTPError as e:
        raise HTTPException(status_code=502, detail=f"Lỗi gọi Supabase: {e}")
