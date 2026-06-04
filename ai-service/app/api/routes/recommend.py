from fastapi import APIRouter, HTTPException
from app.schemas.recommend import (
    RecommendRequest,
    RecommendResponse,
    EncodeQueryRequest,
    EncodeQueryResponse,
)
from app.services import recommend_service

router = APIRouter()

STRATEGY_MAP = {
    "two_tower":     recommend_service.recommend_two_tower,
    "content_based": recommend_service.recommend_content_based,
    "cf":            recommend_service.recommend_cf,
}


@router.post("/", response_model=RecommendResponse)
def get_recommendations(req: RecommendRequest):
    """Generic recommend endpoint — dùng strategy_map để chọn model."""
    fn = STRATEGY_MAP.get(req.strategy)
    if fn is None:
        raise HTTPException(status_code=400, detail=f"Strategy không hợp lệ: {req.strategy}")
    try:
        item_ids, scores = fn(req.user_id, req.top_k)
        return RecommendResponse(
            user_id=req.user_id,
            item_ids=item_ids,
            scores=scores,
            strategy=req.strategy,
        )
    except NotImplementedError:
        raise HTTPException(status_code=501, detail="Model chưa được implement")
    except RuntimeError as e:
        raise HTTPException(status_code=503, detail=str(e))


@router.post("/encode-query", response_model=EncodeQueryResponse)
def encode_query(req: EncodeQueryRequest):
    """
    Two-Tower query encoding.

    Nhận user context → trả về 256-dim embedding vector.
    NestJS dùng vector này để query pgvector trên Supabase.
    """
    try:
        embedding = recommend_service.encode_query_two_tower(
            user_id=req.user_id,
            city=req.city,
            trip_intent=req.trip_intent,
            intent_vibe=req.intent_vibe,
            history_types=req.history_types,
            history_vibes=req.history_vibes,
            history_biz=req.history_biz,
        )
        return EncodeQueryResponse(embedding=embedding, dim=len(embedding))
    except RuntimeError as e:
        raise HTTPException(status_code=503, detail=str(e))
