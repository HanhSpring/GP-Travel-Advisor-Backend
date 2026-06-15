from fastapi import APIRouter

from app.api.v1.endpoints.itinerary import router as itinerary_router
from app.api.v1.endpoints.review_pipeline import router as review_pipeline_router
from app.api.routes.recommend import router as recommend_router

# Router cha chứa toàn bộ v1 API
api_router = APIRouter(prefix="/api/v1")

# Đăng ký các sub-router
api_router.include_router(itinerary_router)

# Review pipeline
api_router.include_router(review_pipeline_router)

# Recommender
api_router.include_router(
    recommend_router,
    prefix="/recommend",
    tags=["recommend"],
)