from app.core.logger import get_logger

logger = get_logger(__name__)
_models: dict = {}


def load_all_models():
    """Gọi trong lifespan của FastAPI. Load toàn bộ model vào memory."""
    _load_bge_m3()
    _load_two_tower()
    _load_content_based()
    _load_collaborative()
    _load_review_classifier()
    logger.info("✅ All models loaded successfully")


def _load_bge_m3():
    try:
        from sentence_transformers import SentenceTransformer
        _models["bge_m3"] = SentenceTransformer("BAAI/bge-m3")
        logger.info("Loaded: BGE-M3")
    except Exception as e:
        logger.warning(f"BGE-M3 load failed: {e}")


def _load_two_tower():
    import os
    from app.core.config import settings

    vocab_path   = settings.two_tower_vocab_path
    weights_path = settings.two_tower_weights_path

    if not os.path.exists(vocab_path):
        logger.warning(f"Two Tower vocab not found at {vocab_path!r} — skipping")
        return
    if not os.path.exists(weights_path):
        logger.warning(f"Two Tower weights not found at {weights_path!r} — skipping")
        return

    try:
        from app.models.two_tower import build_inference_model
        query_tower = build_inference_model(vocab_path, weights_path)
        _models["two_tower"] = query_tower
        logger.info("Loaded: Two Tower (QueryTower ready for inference)")
    except Exception as e:
        logger.error(f"Two Tower load failed: {e}")


def _load_content_based():
    import os, pickle
    path = "weights/content_based.pkl"
    if os.path.exists(path):
        with open(path, "rb") as f:
            _models["content_based"] = pickle.load(f)
        logger.info("Loaded: Content-Based")
    else:
        logger.warning("Content-Based weights not found — skipping")


def _load_collaborative():
    import os, pickle
    path = "weights/collaborative.pkl"
    if os.path.exists(path):
        with open(path, "rb") as f:
            _models["collaborative"] = pickle.load(f)
        logger.info("Loaded: Collaborative Filtering")
    else:
        logger.warning("Collaborative Filtering weights not found — skipping")


def _load_review_classifier():
    import os
    path = "weights/review_classifier.pt"
    if os.path.exists(path):
        import torch
        from app.models.review_classifier import ReviewClassifier
        model = ReviewClassifier()
        model.load_state_dict(torch.load(path, map_location="cpu"))
        model.eval()
        _models["review_classifier"] = model
        logger.info("Loaded: Review Classifier")
    else:
        logger.warning("Review Classifier weights not found — skipping")


def get_model(name: str):
    return _models.get(name)
