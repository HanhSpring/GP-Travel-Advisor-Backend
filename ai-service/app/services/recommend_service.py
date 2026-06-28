from app.api.deps import get_model
from app.core.logger import get_logger
from app.services import ai_config_service

logger = get_logger(__name__)


# ---------------------------------------------------------------------------
# Two-Tower — query encoding
# ---------------------------------------------------------------------------

def encode_query_two_tower(
    user_id:       str,
    city:          str,
    trip_intent:   str,
    intent_vibe:   str,
    history_types: list[str],
    history_vibes: list[str],
    history_biz:   list[str],
) -> list[float]:
    """
    Run QueryTower forward pass.

    Returns a 256-dim L2-normalized embedding as a plain Python list[float].
    Raises RuntimeError when the model is not loaded.
    """
    query_tower = get_model("two_tower")
    if query_tower is None:
        raise RuntimeError("Two Tower model chưa được load")

    import tensorflow as tf
    import numpy as np
    from app.models.two_tower import pad_sequence, ModelConfig

    ml = ModelConfig.MAX_HISTORY_LEN

    q_dict = {
        'user_id':             tf.constant([user_id],                           dtype=tf.string),
        'current_city':        tf.constant([city],                              dtype=tf.string),
        'trip_intent':         tf.constant([trip_intent],                       dtype=tf.string),
        'intent_vibe':         tf.constant([intent_vibe],                       dtype=tf.string),
        'history_business_id': tf.constant([pad_sequence(history_biz,   ml)],   dtype=tf.string),
        'history_types':       tf.constant([pad_sequence(history_types, ml)],   dtype=tf.string),
        'history_vibes':       tf.constant([pad_sequence(history_vibes, ml)],   dtype=tf.string),
    }

    emb: np.ndarray = query_tower(q_dict, training=False).numpy()[0]
    return emb.tolist()


# ---------------------------------------------------------------------------
# Generic strategies (stubs — implement when model weights are ready)
# ---------------------------------------------------------------------------

def recommend_two_tower(user_id: str, top_k: int) -> tuple[list[str], list[float]]:
    query_tower = get_model("two_tower")
    if query_tower is None:
        raise RuntimeError("Two Tower model chưa được load")
    # Candidate retrieval is handled by NestJS via pgvector.
    # This stub exists to keep the STRATEGY_MAP interface intact.
    raise NotImplementedError("Candidate retrieval is done in NestJS — use /recommend/encode-query")


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


def recommend_for_place(
    place_id: str, user_id: int | None, k: int | None = None
) -> list[dict]:
    """Gợi ý "Có thể bạn sẽ thích" cho 1 địa điểm đang xem (Hybrid CB + CF + khoảng cách)."""
    engine = get_model("hybrid_recommender")
    if engine is None:
        raise RuntimeError(
            "Hybrid Recommender chưa được load (thiếu artifact trong recommender_artifacts/ hoặc data/)"
        )
    if k is None:
        try:
            k = int(ai_config_service.get_weights()["candidate_count"])
        except Exception as exc:
            logger.warning("Cannot load default hybrid k from DB, using 10: %s", exc)
            k = 10
    return engine.recommend(user_id, place_id, k=k)
