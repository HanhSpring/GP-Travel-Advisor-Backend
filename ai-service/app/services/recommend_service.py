from app.api.deps import get_model
from app.core.logger import get_logger

logger = get_logger(__name__)


def recommend_two_tower(user_id: str, top_k: int) -> tuple[list[str], list[float]]:
    model = get_model("two_tower")
    if model is None:
        raise RuntimeError("Two Tower model chưa được load")
    # TODO: truyền user embedding vào model, lấy top_k items
    # item_ids, scores = model.recommend(user_id, top_k)
    raise NotImplementedError("Implement sau khi có weights")


def recommend_content_based(user_id: str, top_k: int) -> tuple[list[str], list[float]]:
    model = get_model("content_based")
    if model is None:
        raise RuntimeError("Content-Based model chưa được load")
    raise NotImplementedError("Implement sau khi có weights")


def recommend_cf(user_id: str, top_k: int) -> tuple[list[str], list[float]]:
    model = get_model("collaborative")
    if model is None:
        raise RuntimeError("CF model chưa được load")
    raise NotImplementedError("Implement sau khi có weights")
