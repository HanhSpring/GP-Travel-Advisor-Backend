from app.api.deps import get_model
from app.core.logger import get_logger
from app.core.config import settings
from app.core.model_resources import heavy_model_coordinator

logger = get_logger(__name__)


def encode_texts(texts: list[str], normalize: bool = True) -> tuple[list[list[float]], str]:
    # Multiple BGE requests may encode concurrently. The gate only excludes the
    # incompatible review-transformer workload and has a bounded wait.
    with heavy_model_coordinator.embedding(settings.embedding_wait_timeout_seconds):
        model = get_model("bge_m3")
        if model is None:
            raise RuntimeError("BGE-M3 model chưa được load")

        vectors = model.encode(texts, normalize_embeddings=normalize, batch_size=32)
        return vectors.tolist(), "BAAI/bge-m3"
