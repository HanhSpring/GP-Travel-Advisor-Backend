from fastapi import APIRouter

from app.api.v1.endpoints.itinerary import router as itinerary_router
from app.api.v1.endpoints.review_pipeline import router as review_pipeline_router
from app.api.v1.endpoints.retrain import router as retrain_router
from app.api.v1.endpoints.session_cf_training import router as session_cf_training_router
from app.api.v1.endpoints.two_tower_training import router as two_tower_training_router

api_router = APIRouter(prefix="/api/v1")

# Itinerary (optimize, validate)
api_router.include_router(itinerary_router)

# Review pipeline
api_router.include_router(review_pipeline_router)

# Local Admin-triggered recommender retraining (Colab remains independent)
api_router.include_router(retrain_router)

# Session-Aware CF Reranker training (docs/create-data)
api_router.include_router(session_cf_training_router)

# Two-Tower training (docs/trigger — Phase 0/1: prepare-dataset + hot-reload)
api_router.include_router(two_tower_training_router)
