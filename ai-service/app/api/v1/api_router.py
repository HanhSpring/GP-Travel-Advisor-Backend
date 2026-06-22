from fastapi import APIRouter

from app.api.v1.endpoints.itinerary import router as itinerary_router
from app.api.v1.endpoints.review_pipeline import router as review_pipeline_router

api_router = APIRouter(prefix="/api/v1")

# Itinerary (optimize, validate)
api_router.include_router(itinerary_router)

# Review pipeline
api_router.include_router(review_pipeline_router)