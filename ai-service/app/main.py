from contextlib import asynccontextmanager
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from app.api.deps import load_all_models
from app.api.routes import recommend, embedding, review, ai_config, itinerary
from app.api.v1.api_router import api_router as v1_api_router
from app.core.config import settings
from app.core.logger import get_logger

logger = get_logger(__name__)


@asynccontextmanager
async def lifespan(app: FastAPI):
    logger.info("🚀 Starting AI Service — loading models...")
    load_all_models()
    from app.services import ai_config_service
    ai_config_service.sync_engine_from_db()
    
    if settings.goong_api_key:
        logger.info("✅ Goong Maps API configured for itinerary routing")
    else:
        logger.warning("⚠️ Goong Maps API NOT configured — falling back to Haversine distance")
        
    logger.info("✅ AI Service ready")
    yield
    logger.info("🛑 AI Service shutting down")


app = FastAPI(
    title="AI Service",
    description="Recommendation & NLP microservice cho đồ án tốt nghiệp",
    version="1.0.0",
    lifespan=lifespan,
)

# Routes không có prefix /api/v1 — NestJS gọi trực tiếp
app.add_middleware(
    CORSMiddleware,
    allow_origin_regex=(
        r"https?://("
        r"localhost|"
        r"127\.0\.0\.1|"
        r"192\.168\.\d{1,3}\.\d{1,3}|"
        r"10\.\d{1,3}\.\d{1,3}\.\d{1,3}|"
        r"172\.(1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}"
        r"):\d+"
    ),
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(recommend.router,   prefix="/recommend",   tags=["Recommend"])
app.include_router(embedding.router,   prefix="/embedding",   tags=["Embedding"])
app.include_router(review.router,      prefix="/review",      tags=["Review"])
app.include_router(ai_config.router,   prefix="/ai-config",   tags=["AI Config"])
app.include_router(itinerary.router,   prefix="/itinerary",   tags=["Itinerary Plan"])

# Routes v1: /api/v1/itinerary/optimize|validate, /api/v1/review-pipeline/*
app.include_router(v1_api_router)


@app.get("/health", tags=["System"])
def health_check():
    return {
        "status": "ok",
        "env": settings.app_env,
        "goong_configured": bool(settings.goong_api_key),
    }
