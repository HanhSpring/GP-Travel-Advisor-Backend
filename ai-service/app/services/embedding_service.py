from app.api.deps import get_model
from app.core.logger import get_logger

logger = get_logger(__name__)


def encode_texts(texts: list[str], normalize: bool = True) -> tuple[list[list[float]], str]:
    import numpy as np
    model = get_model("bge_m3")
    if model is None:
        raise RuntimeError("BGE-M3 model chưa được load")

    vectors = model.encode(texts, normalize_embeddings=normalize, batch_size=32)
    return vectors.tolist(), "BAAI/bge-m3"
