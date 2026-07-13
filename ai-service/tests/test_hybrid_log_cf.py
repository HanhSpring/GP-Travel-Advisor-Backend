from app.models.hybrid_recommender import HybridRecommender


def _engine(rating, log_cf, confidence=1.0):
    engine = HybridRecommender("unused", "unused")
    engine.cf_k = 10
    engine.max_log_cf_weight = 0.35
    engine.log_user_confidence = {7: confidence}
    engine._cf_topk_in_city = lambda *_args: list(rating)
    engine._log_cf_topk_in_city = lambda *_args: list(log_cf)
    return engine


def test_combined_cf_keeps_rating_when_log_is_missing():
    engine = _engine(["rating-a", "rating-b"], [])
    assert engine._combined_cf_topk_in_city(7, "Da Nang", 10) == [
        "rating-a", "rating-b"
    ]


def test_combined_cf_supports_log_only_user():
    engine = _engine([], ["log-a", "log-b"])
    assert engine._combined_cf_topk_in_city(7, "Da Nang", 10) == ["log-a", "log-b"]


def test_log_confidence_controls_effective_blend_weight():
    # Opposite rankings. With zero confidence, rating order must be untouched.
    no_confidence = _engine(["a", "b", "c"], ["c", "b", "a"], confidence=0.0)
    assert no_confidence._combined_cf_topk_in_city(7, "Da Nang", 3) == ["a", "b", "c"]

    # Full confidence allows the log branch to influence scores, but rating remains
    # the stronger source because its configured share is 65%.
    full_confidence = _engine(["a", "b", "c"], ["c", "b", "a"], confidence=1.0)
    result = full_confidence._combined_cf_topk_in_city(7, "Da Nang", 3)
    assert result[0] == "a"
    assert set(result) == {"a", "b", "c"}
