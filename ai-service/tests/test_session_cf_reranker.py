import numpy as np
import pytest
from fastapi.testclient import TestClient

from app.main import app
from app.models.session_cf_reranker import SessionCfReranker

client = TestClient(app)


# ---------------------------------------------------------------------------
# Helpers — fake Supabase client (chỉ cần hỗ trợ đúng chain method dùng trong
# _live_session_factor: schema().table().select().eq().gte().not_.is_()
# .order().limit().execute())
# ---------------------------------------------------------------------------

class _FakeExecResult:
    def __init__(self, data):
        self.data = data


class _FakeSupabaseQuery:
    def __init__(self, rows):
        self._rows = rows

    def schema(self, *_a, **_kw):
        return self

    def table(self, *_a, **_kw):
        return self

    def select(self, *_a, **_kw):
        return self

    def eq(self, *_a, **_kw):
        return self

    def gte(self, *_a, **_kw):
        return self

    def order(self, *_a, **_kw):
        return self

    def limit(self, *_a, **_kw):
        return self

    @property
    def not_(self):
        return self

    def is_(self, *_a, **_kw):
        return self

    def execute(self):
        return _FakeExecResult(self._rows)


def _make_fake_engine(session_rows=None) -> SessionCfReranker:
    """Tạo SessionCfReranker với artifact giả nhồi thẳng vào thuộc tính,
    bỏ qua load() thật (chưa có file .npy/.csv thật lúc test — đúng yêu cầu
    'artifact thật chưa cần có lúc này')."""
    engine = SessionCfReranker(
        artifact_dir="does-not-exist",
        supabase_client=_FakeSupabaseQuery(session_rows or []),
    )
    engine.ready = True
    engine.global_mean = 3.0
    n_factors = 4
    rng = np.random.RandomState(0)
    engine.P = np.zeros((1, n_factors), dtype=np.float32)          # 1 known user, factor = 0
    engine.Q = rng.rand(2, n_factors).astype(np.float32)            # 2 items
    engine.b_u = np.zeros(1, dtype=np.float32)
    engine.b_i = np.zeros(2, dtype=np.float32)
    q_norms = np.clip(np.linalg.norm(engine.Q, axis=1, keepdims=True), 1e-9, None)
    engine._unit_Q = (engine.Q / q_norms).astype(np.float32)
    engine.user_id_to_idx = {"known-user": 0}
    engine.item_id_to_idx = {"place-a": 0, "place-b": 1}
    engine.city_to_item_idx = {}
    return engine


def _sample_candidates():
    return [
        {"place_id": "place-a", "cosine_score": 0.9, "average_rating": 4.5, "is_top20_visited": True},
        {"place_id": "place-b", "cosine_score": 0.5, "average_rating": 3.0, "is_top20_visited": False},
    ]


# ---------------------------------------------------------------------------
# 1) Chưa có artifact (ready=False, chưa đăng ký trong _models) -> route trả
#    nguyên candidates gốc, không lỗi (graceful degrade).
# ---------------------------------------------------------------------------

def test_session_rerank_route_returns_input_unchanged_when_engine_not_ready():
    payload = {
        "user_id": "some-user",
        "candidates": [
            {"place_id": "place-a", "cosine_score": 0.9},
            {"place_id": "place-b", "cosine_score": 0.5},
        ],
    }
    response = client.post("/recommend/itinerary/session-rerank", json=payload)

    assert response.status_code == 200
    body = response.json()
    returned_ids = [c["place_id"] for c in body["candidates"]]
    assert returned_ids == ["place-a", "place-b"]
    # graceful degrade: không có field rerank nào bị thêm vào (predict_ranking không có)
    assert "predict_ranking" not in body["candidates"][0]


def test_rerank_noop_when_engine_not_ready():
    engine = SessionCfReranker(artifact_dir="does-not-exist", supabase_client=None)
    assert engine.ready is False

    candidates = _sample_candidates()
    result = engine.rerank("any-user", candidates)

    assert result is candidates
    assert "predict_ranking" not in result[0]


# ---------------------------------------------------------------------------
# 2) Artifact giả (mock nhỏ, nhồi trực tiếp attribute) -> verify công thức
#    is_fully_cold hoạt động đúng như Phase C mô tả.
# ---------------------------------------------------------------------------

def test_rerank_fully_cold_start_uses_popularity_blend_formula():
    """user không có trong vocab CF (user_idx=None) và không có session gần đây
    (query trả về rỗng) -> is_fully_cold=True -> final = (1-w)*tt_norm + w*popularity,
    dùng weight_popularity_cold_start, KHÔNG dùng weight_two_tower/historical_cf/session."""
    engine = _make_fake_engine(session_rows=[])
    candidates = _sample_candidates()

    result = engine.rerank("brand-new-user", candidates)

    by_id = {c["place_id"]: c for c in result}
    assert by_id["place-a"]["is_cold_start"] is True
    assert by_id["place-b"]["is_cold_start"] is True
    # cold-start: historical/session phải là 0 vì user_idx=None và session_vec=None
    assert by_id["place-a"]["historical_cf_score"] == 0.0
    assert by_id["place-a"]["session_score"] == 0.0

    w_pop = engine.weight_popularity_cold_start
    tt_scores = np.array([c["cosine_score"] for c in candidates])
    tt_min, tt_max = tt_scores.min(), tt_scores.max()
    tt_norm = {
        c["place_id"]: (c["cosine_score"] - tt_min) / (tt_max - tt_min)
        for c in candidates
    }
    for pid, row in by_id.items():
        expected = (1.0 - w_pop) * tt_norm[pid] + w_pop * row["popularity_score"]
        assert row["predict_ranking"] == pytest.approx(expected, abs=1e-6)


def test_popularity_score_boosts_only_places_inside_top20_of_their_category():
    """is_top20_visited là boost RỜI RẠC (không còn liên tục theo visit_count):
    2 candidate cùng rating nhưng khác is_top20_visited phải cho popularity_score
    khác nhau đúng 0.7 (trọng số của tín hiệu Top-20 trong công thức)."""
    engine = _make_fake_engine(session_rows=[])
    place_meta = {
        "place-a": {"average_rating": 4.0, "is_top20_visited": True},
        "place-b": {"average_rating": 4.0, "is_top20_visited": False},
    }

    scores = engine._popularity_score(place_meta)

    rating_norm = 4.0 / 5.0
    assert scores["place-a"] == pytest.approx(0.7 * 1.0 + 0.3 * rating_norm, abs=1e-6)
    assert scores["place-b"] == pytest.approx(0.3 * rating_norm, abs=1e-6)
    assert scores["place-a"] - scores["place-b"] == pytest.approx(0.7, abs=1e-6)


def test_rerank_not_cold_start_when_user_in_vocab_even_without_session():
    """user_idx hợp lệ (có lịch sử dài hạn) nhưng không có session gần đây
    -> is_fully_cold PHẢI là False (chỉ cold khi thiếu CẢ 2), dùng bộ trọng số
    thường thay vì bộ trọng số cold-start."""
    engine = _make_fake_engine(session_rows=[])
    candidates = _sample_candidates()

    result = engine.rerank("known-user", candidates)

    for c in result:
        assert c["is_cold_start"] is False
        # P[user] = 0 -> historical_cf_score chỉ còn global_mean, không nhất thiết = 0
        assert c["historical_cf_score"] == pytest.approx(0.5, abs=1e-6)  # (3.0-1)/4
        assert c["session_score"] == 0.0  # không có session query trả về


def test_rerank_not_cold_start_when_session_present_even_without_vocab():
    """user chưa từng có trong vocab CF (user_idx=None) nhưng VỪA có tương tác
    trong cửa sổ session -> is_fully_cold PHẢI là False, session_score có tác dụng
    ngay cả với candidate khác place_id đã tương tác (tổng quát hoá latent space)."""
    engine = _make_fake_engine(
        session_rows=[
            {"place_id": "place-a", "action_type": "save", "created_at": "2026-07-04T10:00:00"}
        ]
    )
    candidates = _sample_candidates()

    result = engine.rerank("never-seen-user", candidates)

    for c in result:
        assert c["is_cold_start"] is False
        assert c["historical_cf_score"] == 0.0  # user_idx vẫn None -> historical = 0
    # candidate place-b (chưa từng tương tác) vẫn nhận session_score > 0 nhờ
    # cosine similarity trong latent space — đây là điểm khác biệt cốt lõi so
    # với chỉ match nguyên place_id.
    by_id = {c["place_id"]: c for c in result}
    assert by_id["place-b"]["session_score"] > 0.0


def test_rerank_does_not_truncate_pool_to_top_n_rerank():
    """candidates ở luồng itinerary là pool cấp cho GA planner (calcRetrievalTopK
    trả 60-200 tuỳ số ngày), KHÔNG phải danh sách hiển thị cuối — rerank() chỉ được
    phép sắp xếp lại, không được cắt còn top_n_rerank (default 30), nếu không GA
    planner sẽ luôn thiếu chỗ cho trip nhiều ngày."""
    engine = _make_fake_engine(session_rows=[])
    engine.item_id_to_idx = {f"place-{i}": i for i in range(50)}
    engine.Q = np.random.RandomState(1).rand(50, 4).astype(np.float32)
    engine.b_i = np.zeros(50, dtype=np.float32)
    q_norms = np.clip(np.linalg.norm(engine.Q, axis=1, keepdims=True), 1e-9, None)
    engine._unit_Q = (engine.Q / q_norms).astype(np.float32)
    assert engine.top_n_rerank < 50  # default 30 < pool size giả lập

    candidates = [
        {"place_id": f"place-{i}", "cosine_score": float(i) / 50}
        for i in range(50)
    ]

    result = engine.rerank("brand-new-user", candidates)

    assert len(result) == 50
