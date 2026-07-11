"""Cấu hình chi phí chuyến đi dùng chung giữa ai-service và api-service.

Lưu trong cùng schema `ai_config` đã có sẵn cho hybrid recommender / two-tower
(xem `ai_config_service.py`), dưới một algorithm riêng tên `trip_cost_config`.
Mục đích: tránh lệch số giữa tỷ lệ giá trẻ em / bảng chi phí VND-km / sức chứa
xe của ai-service (Python) và api-service (NestJS) — cả hai đọc từ cùng các
dòng `algorithm_parameters` này thay vì mỗi bên tự hardcode một bản.

Chi phí xăng xe (transport_cost_per_km_*) là giá xăng thực tế cho **1 xe tự
lái** (không phải chi phí thuê xe dịch vụ). Vì 1 xe chở được nhiều người
(xe máy ~2 người, ô tô ~4 người), tổng chi phí của cả đoàn phải nhân theo
**số xe cần dùng** = ceil(số người / sức chứa mỗi xe) — xem
`vehicles_needed()`. Đừng nhân theo đầu người trực tiếp như child_price_ratio,
vì xăng xe là chi phí theo CHUYẾN/XE chứ không phải theo NGƯỜI.

Tự seed nếu thiếu, và tự đồng bộ lại nếu giá trị mặc định trong code đổi khác
với DB (giống `_ensure_candidate_count_param` trong `ai_config_service.py`) —
chỉ ghi đè `current_value` nếu nó đang bằng default cũ (chưa bị admin chỉnh
tay), để không mất tùy chỉnh thủ công.
"""

from __future__ import annotations

import math

import httpx

from app.core.config import settings
from app.core.logger import get_logger

logger = get_logger(__name__)

ALGO_NAME = "trip_cost_config"
ALGO_DESCRIPTION = "Tham so chi phi chuyen di dung chung ai-service/api-service"

PARAM_CHILD_PRICE_RATIO = "child_price_ratio"

# Canonical vehicle-mode keys shared with api-service's trip-cost-config.service.ts.
# api-service's TransportMode.ROAD maps onto "car" (SELF_DRIVE_TRANSPORT_COST_PER_KM
# already treated ROAD and CAR as the same rate before this consolidation).
TRANSPORT_MODES = ("motorbike", "car", "taxi", "truck")
# Only motorbike/car are reachable in practice (ai-service's travel_vehicle
# field only accepts "car"/"bike"); taxi/truck stay in the table for
# forward-compat but aren't user-selectable today.
CAPACITY_MODES = ("motorbike", "car")
PARAM_TRANSPORT_COST_PREFIX = "transport_cost_per_km_"
PARAM_TRANSPORT_COST_DEFAULT = "transport_cost_per_km_default"
PARAM_VEHICLE_CAPACITY_PREFIX = "vehicle_capacity_"

_DEFAULTS: dict[str, float] = {
    PARAM_CHILD_PRICE_RATIO: 0.7,
    # Giá xăng thực tế trung bình (7/2026): E5 RON92 ~19.730đ/l, tiêu hao
    # 2.0-2.5l/100km -> ~395-493đ/km, lấy ~450đ/km. RON95 ~20.410đ/l, ô tô
    # tiêu hao 7-10l/100km -> ~428-612đ/km, lấy ~520đ/km.
    "transport_cost_per_km_motorbike": 450,
    "transport_cost_per_km_car": 520,
    "transport_cost_per_km_taxi": 18_000,
    "transport_cost_per_km_truck": 20_000,
    PARAM_TRANSPORT_COST_DEFAULT: 10_000,
    "vehicle_capacity_motorbike": 2,
    "vehicle_capacity_car": 4,
}
_DESCRIPTIONS: dict[str, str] = {
    PARAM_CHILD_PRICE_RATIO: "Ty le gia tre em so voi nguoi lon (ve/an uong va khach san)",
    "transport_cost_per_km_motorbike": "VND/km xang xe may tu lai (1 xe)",
    "transport_cost_per_km_car": "VND/km xang o to tu lai (1 xe)",
    "transport_cost_per_km_taxi": "VND/km cho taxi",
    "transport_cost_per_km_truck": "VND/km cho xe tai",
    PARAM_TRANSPORT_COST_DEFAULT: "VND/km mac dinh khi khong ro phuong tien",
    "vehicle_capacity_motorbike": "So nguoi toi da moi xe may",
    "vehicle_capacity_car": "So nguoi toi da moi o to (xe 4 cho)",
}
_MIN_MAX: dict[str, tuple[float | None, float | None]] = {
    PARAM_CHILD_PRICE_RATIO: (0.0, 1.0),
    "vehicle_capacity_motorbike": (1, None),
    "vehicle_capacity_car": (1, None),
}

_TIMEOUT = 8.0
_CACHE_TTL_SECONDS = 60.0


class TripCostConfigError(RuntimeError):
    """Lỗi nghiệp vụ khi đọc/ghi cấu hình chi phí chuyến đi."""


class _PostgREST:
    """Client PostgREST tối giản (giống ai_config_service._PostgREST)."""

    def __init__(self, base_url: str, key: str, schema: str):
        if not base_url or not key:
            raise TripCostConfigError(
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

    def insert(self, table: str, body: dict) -> list[dict]:
        headers = {
            **self._auth,
            "Content-Profile": self.schema,
            "Prefer": "return=representation",
        }
        r = httpx.post(
            f"{self.endpoint}/{table}", json=body, headers=headers, timeout=_TIMEOUT
        )
        r.raise_for_status()
        return r.json()


_client: _PostgREST | None = None


def _db() -> _PostgREST:
    global _client
    if _client is None:
        _client = _PostgREST(
            settings.supabase_url, settings.supabase_key, settings.ai_config_schema
        )
    return _client


def _ensure_algorithm() -> dict:
    rows = _db().select(
        "algorithms", {"name": f"eq.{ALGO_NAME}", "select": "*", "limit": 1}
    )
    if rows:
        return rows[0]
    inserted = _db().insert(
        "algorithms",
        {"name": ALGO_NAME, "description": ALGO_DESCRIPTION, "is_active": True},
    )
    if inserted:
        return inserted[0]
    # Race with another process seeding concurrently: re-select.
    rows = _db().select(
        "algorithms", {"name": f"eq.{ALGO_NAME}", "select": "*", "limit": 1}
    )
    if not rows:
        raise TripCostConfigError(f"Không thể tạo/tìm algorithm '{ALGO_NAME}'")
    return rows[0]


def _ensure_param(algorithm_id: str, name: str) -> dict:
    rows = _db().select(
        "algorithm_parameters",
        {
            "algorithm_id": f"eq.{algorithm_id}",
            "parameter_name": f"eq.{name}",
            "select": "*",
            "limit": 1,
        },
    )
    code_default = _DEFAULTS[name]

    if rows:
        row = rows[0]
        db_default = row.get("default_value")
        # Reconcile: if the code's default changed since this row was seeded
        # (e.g. we corrected the fuel-price estimate), refresh the DB default,
        # and only follow through on current_value if nobody has customized
        # it away from the old default (preserve manual admin overrides).
        try:
            db_default_num = float(db_default) if db_default is not None else None
        except (TypeError, ValueError):
            db_default_num = None
        if db_default_num is None or abs(db_default_num - float(code_default)) > 1e-9:
            try:
                current_value_num = float(row.get("current_value"))
            except (TypeError, ValueError):
                current_value_num = None
            patch_body = {"default_value": code_default}
            if current_value_num is None or (
                db_default_num is not None
                and abs(current_value_num - db_default_num) < 1e-9
            ):
                patch_body["current_value"] = code_default
            patched = _db().patch(
                "algorithm_parameters",
                {
                    "algorithm_id": f"eq.{algorithm_id}",
                    "parameter_name": f"eq.{name}",
                },
                patch_body,
            )
            if patched:
                return patched[0]
        return row

    min_value, max_value = _MIN_MAX.get(name, (None, None))
    body = {
        "algorithm_id": algorithm_id,
        "parameter_name": name,
        "default_value": code_default,
        "current_value": code_default,
        "description": _DESCRIPTIONS.get(name, ""),
    }
    if min_value is not None:
        body["min_value"] = min_value
    if max_value is not None:
        body["max_value"] = max_value
    inserted = _db().insert("algorithm_parameters", body)
    if inserted:
        return inserted[0]
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
        raise TripCostConfigError(f"Không thể tạo/tìm tham số '{name}'")
    return rows[0]


_cache: dict | None = None
_cache_loaded_at = 0.0


def get_trip_cost_config(force_refresh: bool = False) -> dict:
    """Trả về cấu hình dùng chung:
    {
      "child_price_ratio": float,
      "transport_cost_per_km": {mode: float},   # giá xăng/km cho 1 xe
      "transport_cost_per_km_default": float,
      "vehicle_capacity": {mode: int},           # so nguoi toi da moi xe
    }

    Cache trong tiến trình theo `_CACHE_TTL_SECONDS` để tránh gọi PostgREST mỗi
    lần lập lịch trình. Nếu DB lỗi/chưa cấu hình, fallback về `_DEFAULTS` và
    log cảnh báo — không được làm hỏng luồng lập lịch trình chính.
    """
    global _cache, _cache_loaded_at
    import time

    now = time.monotonic()
    if not force_refresh and _cache is not None and (now - _cache_loaded_at) < _CACHE_TTL_SECONDS:
        return _cache

    try:
        algo = _ensure_algorithm()
        param_names = (
            [PARAM_CHILD_PRICE_RATIO, PARAM_TRANSPORT_COST_DEFAULT]
            + [f"{PARAM_TRANSPORT_COST_PREFIX}{mode}" for mode in TRANSPORT_MODES]
            + [f"{PARAM_VEHICLE_CAPACITY_PREFIX}{mode}" for mode in CAPACITY_MODES]
        )
        params = {name: _ensure_param(algo["id"], name) for name in param_names}

        child_price_ratio = float(
            params[PARAM_CHILD_PRICE_RATIO].get("current_value")
            or _DEFAULTS[PARAM_CHILD_PRICE_RATIO]
        )
        transport_cost_per_km = {
            mode: float(
                params[f"{PARAM_TRANSPORT_COST_PREFIX}{mode}"].get("current_value")
                or _DEFAULTS[f"{PARAM_TRANSPORT_COST_PREFIX}{mode}"]
            )
            for mode in TRANSPORT_MODES
        }
        transport_cost_default = float(
            params[PARAM_TRANSPORT_COST_DEFAULT].get("current_value")
            or _DEFAULTS[PARAM_TRANSPORT_COST_DEFAULT]
        )
        vehicle_capacity = {
            mode: max(
                1,
                int(
                    float(
                        params[f"{PARAM_VEHICLE_CAPACITY_PREFIX}{mode}"].get(
                            "current_value"
                        )
                        or _DEFAULTS[f"{PARAM_VEHICLE_CAPACITY_PREFIX}{mode}"]
                    )
                ),
            )
            for mode in CAPACITY_MODES
        }

        config = {
            "child_price_ratio": child_price_ratio,
            "transport_cost_per_km": transport_cost_per_km,
            "transport_cost_per_km_default": transport_cost_default,
            "vehicle_capacity": vehicle_capacity,
        }
        _cache = config
        _cache_loaded_at = now
        return config
    except Exception as e:  # noqa: BLE001 - config must never break planning
        logger.warning(
            "Không tải được trip_cost_config từ DB, dùng giá trị mặc định: %s", e
        )
        fallback = {
            "child_price_ratio": _DEFAULTS[PARAM_CHILD_PRICE_RATIO],
            "transport_cost_per_km": {
                mode: _DEFAULTS[f"{PARAM_TRANSPORT_COST_PREFIX}{mode}"]
                for mode in TRANSPORT_MODES
            },
            "transport_cost_per_km_default": _DEFAULTS[PARAM_TRANSPORT_COST_DEFAULT],
            "vehicle_capacity": {
                mode: int(_DEFAULTS[f"{PARAM_VEHICLE_CAPACITY_PREFIX}{mode}"])
                for mode in CAPACITY_MODES
            },
        }
        if _cache is None:
            _cache = fallback
            _cache_loaded_at = now
        return fallback


def vehicles_needed(headcount: int, mode: str, config: dict | None = None) -> int:
    """Số xe cần dùng cho cả đoàn = ceil(số người / sức chứa mỗi xe).

    Xăng xe là chi phí theo XE, không phải theo NGƯỜI — 5 người đi xe máy cần
    3 xe (ceil(5/2)), không phải 1 xe tính x5 hay x1.
    """
    cfg = config or get_trip_cost_config()
    capacity = cfg.get("vehicle_capacity", {}).get(mode)
    if not capacity:
        capacity = int(_DEFAULTS.get(f"{PARAM_VEHICLE_CAPACITY_PREFIX}{mode}", 1))
    return max(1, math.ceil(max(1, int(headcount)) / capacity))


def sync_transport_cost_into_planner(force_refresh: bool = True) -> None:
    """Overwrite `planner.TRANSPORT_COST_PER_KM`/`TRANSPORT_COST_DEFAULT`/
    `VEHICLE_CAPACITY` in place with the shared config so ai-service and
    api-service can never diverge on VND/km or seats-per-vehicle.
    `planner.py`/`scheduler_v2.py` keep reading these same module-level names
    — no call-site changes needed, so a DB read failure here just means they
    keep whatever value was already loaded (module defaults on first boot).

    Call at process startup (see `app/main.py` lifespan, alongside
    `ai_config_service.sync_engine_from_db()`).
    """
    from app.services.itinerary import planner  # local import: avoid import cycle

    config = get_trip_cost_config(force_refresh=force_refresh)
    per_km = config["transport_cost_per_km"]
    capacity = config["vehicle_capacity"]
    # planner.py's own key is "bike" (not "motorbike") for the same vehicle —
    # historical naming in ai-service, kept as-is to avoid touching every
    # travel_vehicle="bike" call site across the codebase.
    planner.TRANSPORT_COST_PER_KM.clear()
    planner.TRANSPORT_COST_PER_KM.update(
        {
            "bike": per_km["motorbike"],
            "car": per_km["car"],
            "taxi": per_km["taxi"],
            "truck": per_km["truck"],
        }
    )
    planner.TRANSPORT_COST_DEFAULT = config["transport_cost_per_km_default"]
    planner.VEHICLE_CAPACITY.clear()
    planner.VEHICLE_CAPACITY.update(
        {
            "bike": capacity["motorbike"],
            "car": capacity["car"],
        }
    )
