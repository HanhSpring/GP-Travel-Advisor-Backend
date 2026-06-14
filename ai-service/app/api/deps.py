from app.core.logger import get_logger

logger = get_logger(__name__)
_models: dict = {}


def load_all_models():
    """Gọi trong lifespan của FastAPI. Load toàn bộ model vào memory."""
    # Download artifact từ Cloudflare R2 nếu chưa có local.
    _ensure_remote_artifacts()

    _load_bge_m3()
    _load_two_tower()
    _load_content_based()
    _load_collaborative()
    _load_review_classifier()
    _load_hybrid_recommender()
    logger.info("✅ All models loaded successfully")


def _ensure_remote_artifacts():
    """Download data + recommender_artifacts từ R2 (nếu được cấu hình)."""
    try:
        from app.core.config import settings
        from app.core.r2_downloader import ensure_artifacts

        artifact_dir, data_dir = ensure_artifacts(settings)
        _models["_artifact_dir"] = str(artifact_dir)
        _models["_data_dir"] = str(data_dir)
    except Exception as e:
        logger.warning("Không thể đồng bộ R2 artifacts: %s — dùng local path", e)


def _load_hybrid_recommender():
    try:
        from app.core.config import settings
        from app.models.hybrid_recommender import HybridRecommender

        # Ưu tiên path đã download từ R2, fallback sang local setting
        artifact_dir = _models.get("_artifact_dir", settings.reco_artifact_dir)
        data_dir = _models.get("_data_dir", settings.reco_data_dir)

        engine = HybridRecommender(artifact_dir, data_dir)
        if engine.load():
            _models["hybrid_recommender"] = engine
            logger.info("Loaded: Hybrid Recommender")
        else:
            logger.warning("Hybrid Recommender artifacts not found — skipping")
    except Exception as e:
        logger.warning(f"Hybrid Recommender load failed: {e}")


def _load_bge_m3():
    try:
        from sentence_transformers import SentenceTransformer
        _models["bge_m3"] = SentenceTransformer("BAAI/bge-m3")
        logger.info("Loaded: BGE-M3")
    except Exception as e:
        logger.warning(f"BGE-M3 load failed: {e}")


def _load_two_tower():
    import os
    path = "weights/two_tower.pt"
    if os.path.exists(path):
        import torch
        from app.models.two_tower import TwoTowerModel
        model = TwoTowerModel()
        model.load_state_dict(torch.load(path, map_location="cpu"))
        model.eval()
        _models["two_tower"] = model
        logger.info("Loaded: Two Tower")
    else:
        logger.warning("Two Tower weights not found — skipping")


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
