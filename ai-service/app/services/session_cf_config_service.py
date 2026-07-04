"""Quản lý cấu hình Session-Aware CF Reranker lưu trong Supabase (schema `ai_config`).

Copy cấu trúc từ `ai_config_service.py` (Hybrid Recommender của Ngọc) — điểm khác biệt:
- ALGO_NAME = "session_cf_reranker" (seed ở Phase A của
  docs/two-tower/session-aware-cf-reranker-plan.md bằng gen_random_uuid(), không có
  ALGO_ID cố định biết trước như hybrid_recommender — tra theo tên).
- 6 tham số tunable thay vì 2: weight_two_tower, weight_historical_cf, weight_session,
  weight_popularity, session_window_minutes, top_n_rerank.

Luồng:
  - Khởi động  -> sync_engine_from_db(): nạp trọng số hiện tại từ DB vào engine.
  - Admin chỉnh -> update_session_cf_config(): ghi DB + áp dụng ngay vào engine
                  đang chạy (in-memory) + ghi `algorithm_logs`.

Dùng PostgREST trực tiếp qua httpx (đã có sẵn trong requirements) — không thêm
dependency. Chọn schema bằng header Accept-Profile / Content-Profile.
"""

from __future__ import annotations

import httpx

from app.api.deps import get_model
from app.core.config import settings
from app.core.logger import get_logger

logger = get_logger(__name__)

ALGO_NAME = "session_cf_reranker"
PARAM_NAMES = [
    "weight_two_tower",
    "weight_historical_cf",
    "weight_session",
    "weight_popularity",
    "session_window_minutes",
    "top_n_rerank",
]
_TIMEOUT = 8.0


class SessionCfConfigError(RuntimeError):
    """Lỗi nghiệp vụ cấu hình (thiếu cấu hình / không tìm thấy bản ghi / sai giá trị)."""


# ----------------------------------------------------------------- PostgREST
class _PostgREST:
    """Client PostgREST tối giản, hỗ trợ chọn schema qua *-Profile header."""

    def __init__(self, base_url: str, key: str, schema: str):
        if not base_url or not key:
            raise SessionCfConfigError(
                "Chưa cấu hình SUPABASE_URL / SUPABASE_KEY cho ai-service (.env)"
            )
        self.endpoint = f"{base_url.rstrip('/')}/rest/v1"
        self.schema = schema
        self._auth = {"apikey": key, "Authorization": f"Bearer {key}"}

    def select(self, table: str, params: dict) -> list[dict]:
        headers = {**self._auth, "Accept-Profile": self.schema}
        r = httpx.get(
            f"{self.endpoint}/{table}", params=params, headers=headers, timeout=_TIMEOUT
        )
        r.raise_for_status()
        return r.json()

    def patch(self, table: str, params: dict, body: dict) -> list[dict]:
        headers = {
            **self._auth,
            "Content-Profile": self.schema,
            "Prefer": "return=representation",
        }
        r = httpx.patch(
            f"{self.endpoint}/{table}",
            params=params,
            json=body,
            headers=headers,
            timeout=_TIMEOUT,
        )
        r.raise_for_status()
        return r.json()

    def insert(self, table: str, body: dict) -> None:
        headers = {**self._auth, "Content-Profile": self.schema}
        r = httpx.post(
            f"{self.endpoint}/{table}", json=body, headers=headers, timeout=_TIMEOUT
        )
        r.raise_for_status()


_client: _PostgREST | None = None


def _db() -> _PostgREST:
    global _client
    if _client is None:
        _client = _PostgREST(
            settings.supabase_url, settings.supabase_key, settings.ai_config_schema
        )
    return _client


# ------------------------------------------------------------------ queries
def _get_algorithm(name: str = ALGO_NAME) -> dict:
    rows = _db().select(
        "algorithms", {"name": f"eq.{name}", "select": "*", "limit": 1}
    )
    if not rows:
        raise SessionCfConfigError(f"Không tìm thấy algorithm '{name}' trong DB")
    return rows[0]


def _get_param(algorithm_id: str, name: str) -> dict:
    rows = _db().select(
        "algorithm_parameters",
        {
            "algorithm_id": f"eq.{algorithm_id}",
            "parameter_name": f"eq.{name}",
            "select": "*",
            "limit": 1,
        },
    )
    if not rows:
        raise SessionCfConfigError(f"Không tìm thấy tham số '{name}'")
    return rows[0]


def _log(algorithm_id: str | None, status: str, action: str) -> None:
    try:
        _db().insert(
            "algorithm_logs",
            {"algorithm_id": algorithm_id, "status": status, "action": action},
        )
    except Exception as e:  # ghi log thất bại không được làm hỏng request chính
        logger.warning("Ghi algorithm_logs thất bại: %s", e)


# --------------------------------------------------------------- public API
def get_weights() -> dict:
    """Đọc trọng số hiện tại của Session-Aware CF Reranker từ DB."""
    algo = _get_algorithm()
    weights: dict = {
        "algorithm": algo["name"],
        "is_active": bool(algo.get("is_active", True)),
    }
    for name in PARAM_NAMES:
        param = _get_param(algo["id"], name)
        weights[name] = float(param["current_value"])
    return weights


def _apply_to_engine(weights: dict) -> bool:
    """Áp dụng trọng số vào engine đang chạy in-memory. True nếu engine đã load."""
    engine = get_model("session_cf_reranker")
    if engine is None or not getattr(engine, "ready", False):
        return False
    engine.set_weights(**{name: weights[name] for name in PARAM_NAMES})
    return True


def update_session_cf_config(actor: str | None = None, **updates) -> dict:
    """Ghi các tham số truyền vào (chỉ trong PARAM_NAMES) vào DB và áp dụng ngay vào engine."""
    changes_input = {k: v for k, v in updates.items() if k in PARAM_NAMES and v is not None}
    if not changes_input:
        raise SessionCfConfigError(f"Cần truyền ít nhất 1 trong: {', '.join(PARAM_NAMES)}")

    algo = _get_algorithm()
    changes: list[str] = []
    for name, value in changes_input.items():
        updated = _db().patch(
            "algorithm_parameters",
            {
                "algorithm_id": f"eq.{algo['id']}",
                "parameter_name": f"eq.{name}",
            },
            {"current_value": value, "updated_at": "now"},
        )
        if not updated:
            raise SessionCfConfigError(
                f"Không có tham số '{name}' để cập nhật (hãy chạy migration seed dữ liệu)"
            )
        changes.append(f"{name}={value}")

    weights = get_weights()
    applied = _apply_to_engine(weights)
    who = f" bởi {actor}" if actor else ""
    _log(
        algo["id"],
        "success",
        f"Cập nhật {', '.join(changes)}{who}; "
        f"engine={'đã áp dụng' if applied else 'chưa load — sẽ áp dụng khi khởi động'}",
    )
    logger.info(
        "session_cf_reranker config updated (%s, engine applied=%s)",
        ", ".join(changes), applied,
    )
    return weights


def sync_engine_from_db() -> bool:
    """Gọi lúc khởi động: nạp trọng số hiện tại từ DB vào engine.

    Nếu DB chưa cấu hình hoặc lỗi mạng -> bỏ qua, engine giữ default trong
    __init__ (không làm hỏng quá trình khởi động service).
    """
    try:
        weights = get_weights()
    except Exception as e:
        logger.warning(
            "Không đồng bộ được trọng số session_cf_reranker từ DB (giữ default): %s", e
        )
        return False
    ok = _apply_to_engine(weights)
    if ok:
        logger.info("✅ Đồng bộ trọng số session_cf_reranker từ DB vào engine")
    else:
        logger.info("Engine session_cf_reranker chưa load — bỏ qua đồng bộ trọng số từ DB")
    return ok
