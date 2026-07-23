from types import SimpleNamespace

import pytest

from app.services.review_filter_pipeline import apply_algorithm3_db_updates


class FakeQuery:
    def __init__(self, client, table):
        self.client = client
        self.table = table
        self.action = None
        self.payload = None
        self.filters = []

    def select(self, columns):
        self.action = "select"
        self.payload = columns
        return self

    def update(self, payload):
        self.action = "update"
        self.payload = payload
        return self

    def eq(self, column, value):
        self.filters.append(("eq", column, value))
        return self

    def lte(self, column, value):
        self.filters.append(("lte", column, value))
        return self

    def in_(self, column, values):
        self.filters.append(("in", column, values))
        return self

    def range(self, start, end):
        self.filters.append(("range", start, end))
        return self

    def execute(self):
        self.client.calls.append((self.table, self.action, self.payload, self.filters))
        if self.action != "select":
            return SimpleNamespace(data=[])

        in_filter = next(
            (item for item in self.filters if item[0] == "in" and item[1] == "id"),
            None,
        )
        if in_filter:
            return SimpleNamespace(
                data=[
                    {"id": content_id, "review_id": self.client.content_reviews[content_id]}
                    for content_id in in_filter[2]
                    if content_id in self.client.content_reviews
                ]
            )
        return SimpleNamespace(data=self.client.expired_rows)


class FakeClient:
    def __init__(self):
        self.calls = []
        self.expired_rows = [{"review_id": "review-expired"}]
        self.content_reviews = {
            "content-old": "review-old",
            "content-promoted": "review-promoted",
        }

    def schema(self, schema):
        assert schema == "review_ai"
        return self

    def from_(self, table):
        return FakeQuery(self, table)


def test_apply_algorithm3_db_updates_persists_all_three_rules():
    client = FakeClient()

    counts = apply_algorithm3_db_updates(
        client,
        {
            "hidden_long_term_review_ids": ["content-old"],
            "promoted_review_content_ids": ["content-promoted"],
        },
        "2026-07-16T12:00:00+00:00",
    )

    updates = [call for call in client.calls if call[1] == "update"]
    assert (
        "review_contents",
        "update",
        {
            "time_label": "long-term",
            "expiration_date": None,
            "is_temporary": False,
        },
        [("in", "id", ["content-promoted"])],
    ) in updates
    assert (
        "reviews",
        "update",
        {
            "status": "hidden",
            "hidden_reason": "Đánh giá ngắn hạn đã hết hiệu lực",
            "hidden_at": "2026-07-16T12:00:00+00:00",
        },
        [("eq", "status", "approved"), ("in", "id", ["review-expired"])],
    ) in updates
    assert (
        "reviews",
        "update",
        {
            "status": "hidden",
            "hidden_reason": "Đánh giá dài hạn đã được thay thế bởi thông tin mới hơn",
            "hidden_at": "2026-07-16T12:00:00+00:00",
        },
        [("in", "id", ["review-old"])],
    ) in updates
    assert (
        "reviews",
        "update",
        {
            "status": "approved",
            "hidden_reason": None,
            "hidden_at": None,
        },
        [("eq", "status", "hidden"), ("in", "id", ["review-promoted"])],
    ) in updates
    assert (
        "review_contents",
        "select",
        "review_id,reviews!inner(status)",
        [
            ("eq", "time_label", "short-term"),
            ("lte", "expiration_date", "2026-07-16T12:00:00+00:00"),
            ("eq", "reviews.status", "approved"),
            ("range", 0, 49),
        ],
    ) in client.calls
    assert counts == {
        "expired_reviews_hidden": 1,
        "long_term_reviews_hidden": 1,
        "contents_promoted": 1,
        "promoted_reviews_checked": 1,
    }


def test_apply_algorithm3_db_updates_fails_if_hidden_long_term_has_no_review():
    client = FakeClient()

    with pytest.raises(RuntimeError, match="content-missing"):
        apply_algorithm3_db_updates(
            client,
            {"hidden_long_term_review_ids": ["content-missing"]},
            "2026-07-16T12:00:00+00:00",
        )
