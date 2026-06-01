from app.api.deps import get_model
from app.core.logger import get_logger

logger = get_logger(__name__)

LABELS = ["short_term", "long_term"]


def classify_reviews(reviews: list[str]) -> list[dict]:
    import torch
    model = get_model("review_classifier")
    if model is None:
        raise RuntimeError("Review Classifier chưa được load")

    results = []
    # TODO: tokenize + forward pass qua model
    # Placeholder trả về dummy khi chưa có weights
    for text in reviews:
        results.append({
            "text": text,
            "label": "short_term",
            "confidence": 0.0,
        })
    return results
