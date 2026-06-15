"""Quản lý cấu hình thuật toán gợi ý lưu trong Supabase (schema `ai_config`).

Tính năng: điều chỉnh "hệ số khoảng cách" (distance_weight) của Hybrid
Recommender. Quy ước **model_weight = 1 - distance_weight**, nên chỉ lưu duy
nhất `distance_weight` trong bảng `algorithm_parameters`.

Luồng:
  - Khởi động  -> sync_engine_from_db(): nạp giá trị hiện tại từ DB vào engine.
  - Admin chỉnh -> update_distance_weight(): ghi DB + áp dụng ngay vào engine
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

ALGO_NAME = "hybrid_recommender"
PARAM_DISTANCE_WEIGHT = "distance_weight"
_TIMEOUT = 8.0


class AiConfigError(RuntimeError):
    """Lỗi nghiệp vụ cấu hình (thiếu cấu hình / không tìm thấy bản ghi / sai giá trị)."""


# ----------------------------------------------------------------- PostgREST
class _PostgREST:
    """Client PostgREST tối giản, hỗ trợ chọn schema qua *-Profile header."""

    def __init__(self, base_url: str, key: str, schema: str):
        if not base_url or not key:
            raise AiConfigError(
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
        raise AiConfigError(f"Không tìm thấy algorithm '{name}' trong DB")
    return rows[0]


def _get_param(algorithm_id: int, name: str) -> dict:
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
        raise AiConfigError(f"Không tìm thấy tham số '{name}'")
    return rows[0]


def _log(algorithm_id: int | None, status: str, action: str) -> None:
    try:
        _db().insert(
            "algorithm_logs",
            {"algorithm_id": algorithm_id, "status": status, "action": action},
        )
    except Exception as e:  # ghi log thất bại không được làm hỏng request chính
        logger.warning("Ghi algorithm_logs thất bại: %s", e)


# --------------------------------------------------------------- public API
def get_weights() -> dict:
    """Đọc trọng số hiện tại của Hybrid Recommender từ DB."""
    algo = _get_algorithm()
    param = _get_param(algo["id"], PARAM_DISTANCE_WEIGHT)
    dw = float(param["current_value"])
    default = param.get("default_value")
    return {
        "algorithm": algo["name"],
        "is_active": bool(algo.get("is_active", True)),
        "distance_weight": round(dw, 6),
        "model_weight": round(1.0 - dw, 6),
        "default_distance_weight": float(default) if default is not None else None,
    }


def _apply_to_engine(distance_weight: float) -> bool:
    """Áp dụng trọng số vào engine đang chạy in-memory. True nếu engine đã load."""
    engine = get_model("hybrid_recommender")
    if engine is None or not getattr(engine, "ready", False):
        return False
    engine.set_distance_weight(distance_weight)
    return True


def update_distance_weight(distance_weight: float, actor: str | None = None) -> dict:
    """Ghi distance_weight mới vào DB và áp dụng ngay vào engine. Trả về trọng số mới."""
    if not (0.0 <= distance_weight <= 1.0):
        raise AiConfigError("distance_weight phải nằm trong [0, 1]")

    algo = _get_algorithm()
    updated = _db().patch(
        "algorithm_parameters",
        {
            "algorithm_id": f"eq.{algo['id']}",
            "parameter_name": f"eq.{PARAM_DISTANCE_WEIGHT}",
        },
        {"current_value": distance_weight, "updated_at": "now"},
    )
    if not updated:
        raise AiConfigError(
            f"Không có tham số '{PARAM_DISTANCE_WEIGHT}' để cập nhật "
            "(hãy chạy migration seed dữ liệu)"
        )

    applied = _apply_to_engine(distance_weight)
    who = f" bởi {actor}" if actor else ""
    _log(
        algo["id"],
        "success",
        f"Cập nhật distance_weight={distance_weight:.4f} "
        f"(model_weight={1 - distance_weight:.4f}){who}; "
        f"engine={'đã áp dụng' if applied else 'chưa load — sẽ áp dụng khi khởi động'}",
    )
    logger.info(
        "distance_weight -> %.4f (engine applied=%s)", distance_weight, applied
    )
    return get_weights()


def sync_engine_from_db() -> bool:
    """Gọi lúc khởi động: nạp distance_weight hiện tại từ DB vào engine.

    Nếu DB chưa cấu hình hoặc lỗi mạng -> bỏ qua, engine giữ default trong
    serve_manifest.json (không làm hỏng quá trình khởi động service).
    """
    try:
        weights = get_weights()
    except Exception as e:
        logger.warning(
            "Không đồng bộ được trọng số từ DB (giữ default trong manifest): %s", e
        )
        return False
    ok = _apply_to_engine(weights["distance_weight"])
    if ok:
        logger.info(
            "✅ Đồng bộ distance_weight=%.4f từ DB vào engine",
            weights["distance_weight"],
        )
    else:
        logger.info("Engine chưa load — bỏ qua đồng bộ trọng số từ DB")
    return ok
