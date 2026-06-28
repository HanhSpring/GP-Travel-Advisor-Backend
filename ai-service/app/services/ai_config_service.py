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

ALGO_ID = "c9300e9b-878e-4e31-bc66-85c684afd8be"
ALGO_NAME = "hybrid_recommender"
PARAM_DISTANCE_WEIGHT = "distance_weight"
PARAM_CANDIDATE_COUNT = "candidate_count"
DEFAULT_CANDIDATE_COUNT = 10
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
        "algorithms", {"id": f"eq.{ALGO_ID}", "select": "*", "limit": 1}
    )
    if rows:
        return rows[0]

    rows = _db().select(
        "algorithms", {"name": f"eq.{name}", "select": "*", "limit": 1}
    )
    if not rows:
        raise AiConfigError(f"Không tìm thấy algorithm '{name}' trong DB")
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
        raise AiConfigError(f"Không tìm thấy tham số '{name}'")
    return rows[0]


def _ensure_candidate_count_param(algorithm_id: str) -> dict:
    try:
        param = _get_param(algorithm_id, PARAM_CANDIDATE_COUNT)
        default_value = int(float(param.get("default_value") or 0))
        min_value = int(float(param.get("min_value") or 0))
        max_value = int(float(param.get("max_value") or 0))
        if (
            default_value != DEFAULT_CANDIDATE_COUNT
            or min_value != 1
            or max_value != 50
        ):
            _db().patch(
                "algorithm_parameters",
                {
                    "algorithm_id": f"eq.{algorithm_id}",
                    "parameter_name": f"eq.{PARAM_CANDIDATE_COUNT}",
                },
                {
                    "default_value": DEFAULT_CANDIDATE_COUNT,
                    "min_value": 1,
                    "max_value": 50,
                    "description": "So ket qua goi y mac dinh cho Hybrid Recommender",
                    "updated_at": "now",
                },
            )
            return _get_param(algorithm_id, PARAM_CANDIDATE_COUNT)
        return param
    except AiConfigError:
        _db().insert(
            "algorithm_parameters",
            {
                "algorithm_id": algorithm_id,
                "parameter_name": PARAM_CANDIDATE_COUNT,
                "default_value": DEFAULT_CANDIDATE_COUNT,
                "current_value": DEFAULT_CANDIDATE_COUNT,
                "description": "So ket qua goi y mac dinh cho Hybrid Recommender",
                "min_value": 1,
                "max_value": 50,
            },
        )
        return _get_param(algorithm_id, PARAM_CANDIDATE_COUNT)


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
    """Đọc trọng số hiện tại của Hybrid Recommender từ DB."""
    algo = _get_algorithm()
    param = _get_param(algo["id"], PARAM_DISTANCE_WEIGHT)
    candidate_param = _ensure_candidate_count_param(algo["id"])
    dw = float(param["current_value"])
    default = param.get("default_value")
    candidate_count = int(float(candidate_param["current_value"]))
    default_candidate_count = candidate_param.get("default_value")
    return {
        "algorithm": algo["name"],
        "is_active": bool(algo.get("is_active", True)),
        "distance_weight": round(dw, 6),
        "model_weight": round(1.0 - dw, 6),
        "default_distance_weight": float(default) if default is not None else None,
        "candidate_count": candidate_count,
        "default_candidate_count": int(float(default_candidate_count))
        if default_candidate_count is not None
        else None,
    }


def _apply_to_engine(distance_weight: float) -> bool:
    """Áp dụng trọng số vào engine đang chạy in-memory. True nếu engine đã load."""
    engine = get_model("hybrid_recommender")
    if engine is None or not getattr(engine, "ready", False):
        return False
    engine.set_distance_weight(distance_weight)
    return True


def update_hybrid_config(
    distance_weight: float | None = None,
    candidate_count: int | None = None,
    actor: str | None = None,
) -> dict:
    """Ghi config mới vào DB và áp dụng ngay vào engine."""
    if distance_weight is None and candidate_count is None:
        raise AiConfigError("Cần truyền distance_weight hoặc candidate_count")
    if distance_weight is not None and not (0.0 <= distance_weight <= 1.0):
        raise AiConfigError("distance_weight phải nằm trong [0, 1]")
    if candidate_count is not None and not (1 <= candidate_count <= 50):
        raise AiConfigError("candidate_count phải nằm trong [1, 50]")

    algo = _get_algorithm()
    changes: list[str] = []

    if distance_weight is not None:
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
        changes.append(f"distance_weight={distance_weight:.4f}")

    if candidate_count is not None:
        _ensure_candidate_count_param(algo["id"])
        updated = _db().patch(
            "algorithm_parameters",
            {
                "algorithm_id": f"eq.{algo['id']}",
                "parameter_name": f"eq.{PARAM_CANDIDATE_COUNT}",
            },
            {"current_value": int(candidate_count), "updated_at": "now"},
        )
        if not updated:
            raise AiConfigError(f"Không có tham số '{PARAM_CANDIDATE_COUNT}' để cập nhật")
        changes.append(f"candidate_count={int(candidate_count)}")

    weights = get_weights()
    applied = _apply_to_engine(weights["distance_weight"])
    who = f" bởi {actor}" if actor else ""
    _log(
        algo["id"],
        "success",
        f"Cập nhật {', '.join(changes)} "
        f"(model_weight={weights['model_weight']:.4f}){who}; "
        f"engine={'đã áp dụng' if applied else 'chưa load — sẽ áp dụng khi khởi động'}",
    )
    logger.info(
        "hybrid config updated (distance_weight=%.4f, default_k=%d, engine applied=%s)",
        weights["distance_weight"],
        weights["candidate_count"],
        applied,
    )
    return weights


def update_distance_weight(distance_weight: float, actor: str | None = None) -> dict:
    """Backward-compatible wrapper."""
    return update_hybrid_config(distance_weight=distance_weight, actor=actor)


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
