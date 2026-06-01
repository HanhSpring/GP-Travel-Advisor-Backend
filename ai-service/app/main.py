from contextlib import asynccontextmanager
from fastapi import FastAPI
from app.api.deps import load_all_models
from app.api.routes import recommend, embedding, review
from app.core.config import settings
from app.core.logger import get_logger

logger = get_logger(__name__)


@asynccontextmanager
async def lifespan(app: FastAPI):
    logger.info("🚀 Starting AI Service — loading models...")
    load_all_models()
    yield
    logger.info("🛑 AI Service shutting down")


app = FastAPI(
    title="AI Service",
    description="Recommendation & NLP microservice cho đồ án tốt nghiệp",
    version="1.0.0",
    lifespan=lifespan,
)

app.include_router(recommend.router, prefix="/recommend", tags=["Recommend"])
app.include_router(embedding.router, prefix="/embedding", tags=["Embedding"])
app.include_router(review.router,    prefix="/review",    tags=["Review"])


@app.get("/health", tags=["System"])
def health_check():
    return {"status": "ok", "env": settings.app_env}
