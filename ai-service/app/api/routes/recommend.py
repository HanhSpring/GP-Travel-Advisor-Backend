from fastapi import APIRouter, HTTPException, Query
from app.api.deps import get_model
from app.schemas.recommend import (
    RecommendRequest,
    RecommendResponse,
    PlaceRecommendationsResponse,
    EncodeQueryRequest,
    EncodeQueryResponse,
    SessionRerankRequest,
    SessionRerankResponse,
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


@router.get(
    "/places/{place_id}/recommendations",
    response_model=PlaceRecommendationsResponse,
    summary='Gợi ý "Có thể bạn sẽ thích" cho địa điểm đang xem',
)
def place_recommendations(
    place_id: str,
    user_id: str | None = Query(
        default=None,
        description="Tourist UUID hoặc id số (Foody lịch sử); bỏ trống nếu khách chưa đăng nhập",
    ),
    k: int | None = Query(default=None, ge=1, le=50),
):
    try:
        items = recommend_service.recommend_for_place(place_id, user_id, k)
    except RuntimeError as e:
        raise HTTPException(status_code=503, detail=str(e))
    return {"place_id": place_id, "count": len(items), "items": items}


@router.post(
    "/itinerary/session-rerank",
    response_model=SessionRerankResponse,
    summary="Rerank Two-Tower Top-100 candidates bằng Session-Aware CF (session-based)",
)
def session_rerank(req: SessionRerankRequest):
    """Rerank candidates từ Two-Tower diversifyTopK bằng session-aware CF.

    Graceful degrade: nếu engine chưa đăng ký hoặc chưa load được artifact
    (ready=False), trả nguyên candidates gốc — KHÔNG lỗi, để NestJS luôn nhận
    được response hợp lệ và giữ nguyên thứ tự Two-Tower."""
    candidates = [c.model_dump() for c in req.candidates]
    engine = get_model("session_cf_reranker")
    if engine is None or not engine.ready:
        return {"candidates": candidates}
    reranked = engine.rerank(req.user_id, candidates)
    return {"candidates": reranked}


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
