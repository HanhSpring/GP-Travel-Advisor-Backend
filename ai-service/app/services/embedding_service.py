from app.api.deps import get_model
from app.core.logger import get_logger
from app.core.model_resources import heavy_model_lock

logger = get_logger(__name__)


def encode_texts(texts: list[str], normalize: bool = True) -> tuple[list[list[float]], str]:
    with heavy_model_lock:
        # Evict review-filter weights only when switching to the BGE workload.
        # Repeated embedding requests continue to reuse the loaded BGE model.
        from app.api.v1.endpoints.review_pipeline import discard_pipeline_executor
        discard_pipeline_executor()

        model = get_model("bge_m3")
        if model is None:
            raise RuntimeError("BGE-M3 model chưa được load")

        vectors = model.encode(texts, normalize_embeddings=normalize, batch_size=32)
        return vectors.tolist(), "BAAI/bge-m3"
