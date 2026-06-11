from fastapi import APIRouter, HTTPException, Query
from app.schemas.recommend import (
    RecommendRequest,
    RecommendResponse,
    PlaceRecommendationsResponse,
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
    user_id: int | None = Query(default=None, description="UserID (số nguyên); bỏ trống nếu khách chưa đăng nhập"),
    k: int = Query(default=10, ge=1, le=50),
):
    try:
        items = recommend_service.recommend_for_place(place_id, user_id, k)
    except RuntimeError as e:
        raise HTTPException(status_code=503, detail=str(e))
    return {"place_id": place_id, "count": len(items), "items": items}
