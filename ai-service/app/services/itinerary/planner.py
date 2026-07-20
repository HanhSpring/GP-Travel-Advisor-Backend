"""
TSP-TW: Travelling Salesman Problem with Time Windows
Solved with a Genetic Algorithm (GA).

Algorithm overview:
  - Chromosome  : permutation of POI indices, e.g. [2, 0, 3, 1]
  - Fitness     : |available_time - invested_time|
                  + 0.1 * travel_time + 0.2 * wait_time  (lower = better)
                  where invested_time = visit_time + buffered_travel_time
                                        + time-window penalty.
  - Selection   : Roulette Wheel (inverse-fitness weighted)
  - Crossover   : PMX – Partially Mapped Crossover
  - Mutation    : Swap two random positions

Restaurants are handled as lunch candidates: at most one per day, scheduled in
the 11:30-13:30 lunch window.
"""

import os
import re
import csv
import json
import math
import random
import time
import argparse
import datetime
import unicodedata
import hashlib
import requests
from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import dataclass, field
from typing import Dict, List, Optional, Tuple
from urllib.parse import urljoin

from app.services.itinerary.assignment import (
    AssignmentConfig,
    AssignmentResult,
    ConstrainedKMeansAssignment,
)

try:
    from dotenv import load_dotenv
    _dotenv_available = True
except ImportError:
    _dotenv_available = False

try:
    from supabase import create_client
    _supabase_available = True
except ImportError:
    _supabase_available = False


# ──────────────────────────────────────────────────────────────────────────────
# Constants
# ──────────────────────────────────────────────────────────────────────────────

SERVICE_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", ".."))
BACKEND_ROOT = os.path.abspath(os.path.join(SERVICE_DIR, ".."))
PROJECT_ROOT = os.path.abspath(os.path.join(BACKEND_ROOT, ".."))
DEFAULT_DATA_DIR = os.getenv(
    "ITINERARY_DATA_DIR",
    os.path.join(PROJECT_ROOT, "GPTravelAdvisorDataLab", "data", "itinerary"),
)

DEMO_PLACE_COUNT = 50
DEMO_DATA_SOURCE = "csv"
DEMO_CSV_PATH = os.getenv("ITINERARY_PLACES_CSV", os.path.join(DEFAULT_DATA_DIR, "places_rows (2).csv"))
DEMO_TYPES_CSV_PATH = os.getenv("ITINERARY_TYPES_CSV", os.path.join(DEFAULT_DATA_DIR, "types_rows (1).csv"))
DEMO_CITY_ID = "8a10b8b8-6875-58e0-9bee-27f67e54376e"  # Đà Nẵng
DEMO_ALLOWED_SOURCES = {"foody", "trip"}
MEAL_TYPE_IDS = {
    "e86f76e5-66af-56aa-89ca-d097cd873391",
    "08aab715-7167-529a-ada1-cdc3cad11ba3",
    "a01526b0-8e9b-59a7-bfdf-e22c42f616f1",
    "f4a969f9-768f-5d08-82e8-8e67536f1046",
}
MEAL_TYPE_NAME_KEYWORDS = ("nha hang", "quan an", "quan chay", "buffet", "khu am thuc")
EXCLUDED_DEMO_TYPE_NAMES = {
    "cua hang tien loi",
    "pub/bar",
    "cafe & do uong",
    "rap phim",
    "homestay & villa",
    "tiem banh & trang mieng",
    "khac",
    "billiards",
    "tour co huong dan",
    "nha nghi",
    "khach san & resort",
    "the thao ngoai troi",
    "karaoke",
    "the thao trong nha",
    "buffet & khu am thuc",
    "spa & thu gian",
    "trung tam thuong mai",
    "cua hang dac san/qua luu niem",
    "dich vu du lich",
}
MEAL_NAME_KEYWORDS = (
    "quán", "nhà hàng", "restaurant", "cơm", "mì", "mỳ", "bún", "phở",
    "lẩu", "nướng", "hải sản", "gà", "vịt", "bánh mì", "bánh xèo",
    "pizza", "burger", "bbq", "steak", "sushi", "ramen", "cháo",
    "hủ tiếu", "cao lầu", "đặc sản",
)
NON_MEAL_NAME_KEYWORDS = (
    "chè", "trà sữa", "milk tea", "cafe", "coffee", "juice", "smoothie",
    "sinh tố", "spa", "homestay", "villa", "hotel", "shop", "coworking",
    "bar", "club",
)
TRAVEL_CACHE_PATH = os.getenv(
    "ITINERARY_TRAVEL_CACHE",
    os.path.join(SERVICE_DIR, "data", "travel_matrix_cache.json"),
)
LUNCH_START = 10 * 60 + 30  # 10:30 — nguồn duy nhất cho khung giờ ăn trưa trong ai-service
LUNCH_END = 14 * 60  # 14:00
# Infeasibility penalty cho hard constraint an trua.
# Gia tri nay lon hon can tren cac thanh phan fitness mem trong mot ngay tour,
# nen chromosome thieu an trua gan nhu khong duoc chon lam parent.
MISSING_LUNCH_PENALTY = 10_000
DAILY_TYPE_LIMITS = {
    "restaurant": 1,
    "cafe": 1,
    "entertainment": 1,
}
SOFT_TYPE_LIMIT_PENALTY = 80
ATTRACTION_LATEST_START = 18 * 60
ENTERTAINMENT_EARLIEST_START = 15 * 60
LATE_ENTERTAINMENT_START = 17 * 60
CAFE_EARLIEST_START = 9 * 60
TIME_PREFERENCE_PENALTY = 80
FEASIBILITY_PENALTY = 100_000
MAX_NON_MEAL_WAIT_MINUTES = 90
UTILITY_TRAVEL_WEIGHT = 0.9
UTILITY_SCALE = 200
ALPHA_DEFAULT = 0.7
GOONG_TRAVEL_SOURCES = {"goong", "goong_cache", "goong_db"}
# Default sau thuc nghiem tren tap 50 POI co dinh.
DEFAULT_POPULATION_SIZE = 50
DEFAULT_MUTATION_RATE = 0.30
EARLY_STOP_PATIENCE = 30
TRAVEL_TIME_WEIGHT = 0.1
WAIT_TIME_WEIGHT = 0.8
BUDGET_OVERAGE_UNIT_VND = 1_000
BUDGET_PENALTY_WEIGHT = 15.0
# Real self-drive fuel cost per km for ONE vehicle (see trip_cost_config_service.py
# for the shared source of truth / seeded defaults — these module-level dicts
# are overwritten in place by sync_transport_cost_into_planner() at startup).
TRANSPORT_COST_PER_KM = {
    "bike": 450,
    "car": 520,
    "taxi": 18_000,
    "truck": 20_000,
}
TRANSPORT_COST_DEFAULT = 10_000
# Seats per vehicle, used to compute how many vehicles the group actually
# needs (ceil(headcount / capacity)) — fuel cost is per VEHICLE, not per
# person, so a family of 5 on motorbikes needs 3 bikes' worth of fuel, not 1.
VEHICLE_CAPACITY = {
    "bike": 2,
    "car": 4,
}
POI_TARGET_MIN_PER_DAY = 4
POI_TARGET_MAX_PER_DAY = 10
POI_TARGET_TIME_SLICE_MINUTES = 90
# Child pricing discount actually affecting money lives in api-service
# (recommendation.service.ts / trip-cost-config.service.ts), applied before
# place/hotel prices ever reach this planner. There used to be a
# CHILD_COST_FACTOR constant here feeding into adult_equivalent, but
# adult_equivalent is never read by any cost function (_poi_cost/_poi_utility)
# -- it was dead code, removed to avoid implying this scheduler discounts
# children internally.
ROOM_CAPACITY = 2
FALLBACK_HOTEL_COST_PER_NIGHT = 400_000
DEFAULT_TRAVEL_BUFFER_PERCENT = 0.20
DEFAULT_TRAVEL_BUFFER_MIN = 5
DEFAULT_TRAVEL_BUFFER_MAX = 15
P90_MIN_HISTORY_SAMPLES = 31
P95_MIN_HISTORY_SAMPLES = 36

# Runtime config.
# Fill these values here if you want to run this script without a .env file.
# Values from .env still override these constants when present.
API_BASE_URL = "http://localhost:3000"
PLACES_ENDPOINT = "/explore/places"
GOONG_API_KEY = ""
SUPABASE_URL = ""
SUPABASE_KEY = ""

_DAY_IDX = {"Mon": 0, "Tue": 1, "Wed": 2, "Thu": 3, "Fri": 4, "Sat": 5, "Sun": 6}
_DAY_JSON_KEYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"]
_SEG_RE = re.compile(r'\[([^\]]+)\]:\[([^\]]+)\]')
TYPE_BY_ID: Dict[str, dict] = {}


# ──────────────────────────────────────────────────────────────────────────────
# Utilities
# ──────────────────────────────────────────────────────────────────────────────

def minutes_to_time(minutes: int) -> str:
    """Convert minutes-from-midnight to 'HH:MM' string."""
    h = (minutes // 60) % 24
    m = minutes % 60
    return f"{h:02d}:{m:02d}"


def time_to_minutes(time_str: str) -> int:
    """Convert 'HH:MM' string to minutes from midnight."""
    h, m = map(int, time_str.split(":"))
    return h * 60 + m


def normalize_text(value: str) -> str:
    """Lowercase and remove Vietnamese accents for robust type matching."""
    value = (value or "").replace(chr(0x0110), "D").replace(chr(0x0111), "d")
    text = unicodedata.normalize("NFD", value or "")
    text = "".join(ch for ch in text if unicodedata.category(ch) != "Mn")
    return text.lower().strip()


def synthetic_poi_score(poi: "POI") -> float:
    """
    Diem S_i du phong khi can quay lai objective profit-based.
    Gia tri nam trong [4.5, 5.0] va on dinh theo poi.id de ket qua co the lap lai.
    """
    digest = hashlib.sha256(str(poi.id).encode("utf-8")).hexdigest()
    bucket = int(digest[:8], 16) % 501
    return 4.5 + bucket / 1000.0


def overlaps_lunch_window(start_minute: int, end_minute: int) -> bool:
    """Return True if the actual visit interval overlaps the lunch window."""
    return start_minute < LUNCH_END and end_minute > LUNCH_START


def load_env_file(path: str) -> None:
    """Load simple KEY=VALUE pairs without requiring python-dotenv."""
    if not os.path.exists(path):
        return
    with open(path, "r", encoding="utf-8") as env_file:
        for raw_line in env_file:
            line = raw_line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, value = line.split("=", 1)
            key = key.strip()
            value = value.strip().strip('"').strip("'")
            if key and key not in os.environ:
                os.environ[key] = value


def is_lunch_restaurant_row(row: dict) -> bool:
    """Return True for Foody rows that look suitable as a lunch meal."""
    if (row.get("source") or "").lower() != "foody":
        return False

    name = normalize_text(row.get("name") or "")
    type_id = row.get("type_id") or ""
    type_info = TYPE_BY_ID.get(type_id) or {}
    type_name = normalize_text(type_info.get("name") or "")

    if any(keyword in name for keyword in NON_MEAL_NAME_KEYWORDS):
        return False
    if type_name:
        return any(keyword in type_name for keyword in MEAL_TYPE_NAME_KEYWORDS)
    if type_id in MEAL_TYPE_IDS:
        return True
    return any(keyword in name for keyword in MEAL_NAME_KEYWORDS)


def is_allowed_demo_type(row: dict) -> bool:
    """Filter demo candidates to food POIs and visit-worthy place types."""
    type_id = row.get("type_id") or ""
    if not TYPE_BY_ID or not type_id:
        return True
    type_name = normalize_text((TYPE_BY_ID.get(type_id) or {}).get("name") or "")
    return type_name not in EXCLUDED_DEMO_TYPE_NAMES


def _fetch_goong_distance_batch(
    url: str,
    coords: Dict[str, Tuple[float, float]],
    origin_batch: List[str],
    dest_batch: List[str],
    api_key: str,
    vehicle: str,
) -> Tuple[Dict[Tuple[str, str], int], Dict[Tuple[str, str], float]]:
    """Fetch one Goong Distance Matrix batch."""
    def to_latlng(place_id: str) -> str:
        lon, lat = coords[place_id]
        return f"{lat},{lon}"

    resp = requests.get(
        url,
        params={
            "origins": "|".join(to_latlng(i) for i in origin_batch),
            "destinations": "|".join(to_latlng(d) for d in dest_batch),
            "vehicle": vehicle,
            "api_key": api_key,
        },
        timeout=10,
    )
    if not resp.ok:
        raise RuntimeError(
            "Goong HTTP "
            f"{resp.status_code}: {_safe_console_text(resp.text[:300])}"
        )
    data = resp.json()

    if "rows" not in data:
        raise RuntimeError(f"Goong Distance Matrix API error: {data.get('message', data)}")

    times: Dict[Tuple[str, str], int] = {}
    distances: Dict[Tuple[str, str], float] = {}
    for row_idx, row in enumerate(data["rows"]):
        from_id = origin_batch[row_idx]
        for col_idx, element in enumerate(row["elements"]):
            to_id = dest_batch[col_idx]
            if from_id == to_id:
                continue
            if element["status"] == "OK":
                minutes = max(1, math.ceil(element["duration"]["value"] / 60))
                distance_km = max(0.0, float(element.get("distance", {}).get("value", 0)) / 1000)
                times[(from_id, to_id)] = minutes
                distances[(from_id, to_id)] = distance_km
    return times, distances


def _fetch_goong_distance_batch_resilient(
    url: str,
    coords: Dict[str, Tuple[float, float]],
    origin_batch: List[str],
    dest_batch: List[str],
    api_key: str,
    vehicle: str,
) -> Tuple[Dict[Tuple[str, str], int], Dict[Tuple[str, str], float]]:
    """
    Goong may return NOT_FOUND for a mixed batch even when many individual
    pairs are valid. Split failed batches recursively until we isolate the
    problematic pairs and keep as many Goong results as possible.
    """
    try:
        return _fetch_goong_distance_batch(
            url,
            coords,
            origin_batch,
            dest_batch,
            api_key,
            vehicle,
        )
    except Exception:
        if len(origin_batch) == 1 and len(dest_batch) == 1:
            raise

    if len(origin_batch) >= len(dest_batch) and len(origin_batch) > 1:
        split_at = max(1, len(origin_batch) // 2)
        origin_groups = [origin_batch[:split_at], origin_batch[split_at:]]
        dest_groups = [dest_batch]
    else:
        split_at = max(1, len(dest_batch) // 2)
        origin_groups = [origin_batch]
        dest_groups = [dest_batch[:split_at], dest_batch[split_at:]]

    times: Dict[Tuple[str, str], int] = {}
    distances: Dict[Tuple[str, str], float] = {}
    for origins in origin_groups:
        if not origins:
            continue
        for destinations in dest_groups:
            if not destinations:
                continue
            child_times, child_distances = _fetch_goong_distance_batch_resilient(
                url,
                coords,
                origins,
                destinations,
                api_key,
                vehicle,
            )
            times.update(child_times)
            distances.update(child_distances)
    return times, distances



def build_travel_data_goong(
    coords: Dict[str, Tuple[float, float]],
    api_key: str,
    vehicle: str = "car",
    batch_size: int = 5,
    max_workers: int = 1,
) -> Tuple[Dict[Tuple[str, str], int], Dict[Tuple[str, str], float]]:
    """
    Lấy thời gian di chuyển thực tế từ Goong Distance Matrix API.

    Parameters
    ----------
    coords     : dict id -> (longitude, latitude)
    api_key    : Goong API key (biến môi trường GOONG_API_KEY)
    vehicle    : "car" | "bike" | "taxi" | "truck"
    batch_size : số origins mỗi request (khuyến nghị ≤ 10)

    Returns
    -------
    Dict[(from_id, to_id)] -> thời gian di chuyển (phút)
    """
    url = "https://rsapi.goong.io/v2/distancematrix"
    ids = list(coords.keys())

    # Goong expects coordinates as "latitude,longitude" while coords are stored
    # as (longitude, latitude), so swap before sending.
    def to_latlng(place_id: str) -> str:
        lon, lat = coords[place_id]
        return f"{lat},{lon}"

    times: Dict[Tuple[str, str], int] = {}
    distances: Dict[Tuple[str, str], float] = {}
    max_workers = max(1, int(max_workers))

    if max_workers > 1:
        jobs: List[Tuple[List[str], List[str]]] = []
        for origin_start in range(0, len(ids), batch_size):
            origin_batch = ids[origin_start:origin_start + batch_size]
            for dest_start in range(0, len(ids), batch_size):
                dest_batch = ids[dest_start:dest_start + batch_size]
                jobs.append((origin_batch, dest_batch))

        failed_batches = 0
        with ThreadPoolExecutor(max_workers=max_workers) as executor:
            futures = [
                executor.submit(
                    _fetch_goong_distance_batch_resilient,
                    url,
                    coords,
                    origin_batch,
                    dest_batch,
                    api_key,
                    vehicle,
                )
                for origin_batch, dest_batch in jobs
            ]
            for future in as_completed(futures):
                try:
                    batch_times, batch_distances = future.result()
                except Exception as e:
                    failed_batches += 1
                    print(f"  [WARNING] One Goong branch failed: {_safe_console_text(e)}")
                    continue
                times.update(batch_times)
                distances.update(batch_distances)

        if failed_batches and not times:
            raise RuntimeError("Tat ca Goong batch deu that bai.")
        return times, distances

    for origin_start in range(0, len(ids), batch_size):
        origin_batch = ids[origin_start:origin_start + batch_size]
        origins_str = "|".join(to_latlng(i) for i in origin_batch)

        for dest_start in range(0, len(ids), batch_size):
            dest_batch = ids[dest_start:dest_start + batch_size]
            destinations_str = "|".join(to_latlng(d) for d in dest_batch)

            resp = requests.get(
                url,
                params={
                    "origins": origins_str,
                    "destinations": destinations_str,
                    "vehicle": vehicle,
                    "api_key": api_key,
                },
                timeout=10,
            )
            if not resp.ok:
                raise RuntimeError(
                    "Goong HTTP "
                    f"{resp.status_code}: {_safe_console_text(resp.text[:300])}"
                )
            data = resp.json()

            if "rows" not in data:
                raise RuntimeError(
                    f"Goong Distance Matrix API error: {data.get('message', data)}"
                )

            for row_idx, row in enumerate(data["rows"]):
                from_id = origin_batch[row_idx]
                for col_idx, element in enumerate(row["elements"]):
                    to_id = dest_batch[col_idx]
                    if from_id == to_id:
                        continue
                    if element["status"] == "OK":
                        minutes = max(1, math.ceil(element["duration"]["value"] / 60))
                        distance_km = max(0.0, float(element.get("distance", {}).get("value", 0)) / 1000)
                    else:
                        # Không tìm được đường → dùng fallback 30 phút
                        minutes = 30
                        distance_km = 0.0
                    times[(from_id, to_id)] = minutes
                    distances[(from_id, to_id)] = distance_km
                    if element["status"] != "OK":
                        times.pop((from_id, to_id), None)
                        distances.pop((from_id, to_id), None)

            # Tránh vượt rate limit giữa các sub-batch
            time.sleep(0.2)

    return times, distances


def build_travel_times_goong(
    coords: Dict[str, Tuple[float, float]],
    api_key: str,
    vehicle: str = "car",
    batch_size: int = 10,
    max_workers: int = 1,
) -> Dict[Tuple[str, str], int]:
    """Backward-compatible wrapper returning only Goong raw minutes."""
    times, _ = build_travel_data_goong(
        coords,
        api_key,
        vehicle=vehicle,
        batch_size=batch_size,
        max_workers=max_workers,
    )
    return times


# ──────────────────────────────────────────────────────────────────────────────
# Opening hours parser (open_hour_compressed format)
# ──────────────────────────────────────────────────────────────────────────────

def _expand_days(day_spec: str) -> List[int]:
    """'Mon-Fri' → [0,1,2,3,4]   'Mon,Wed,Fri' → [0,2,4]   'Sun' → [6]"""
    day_spec = day_spec.strip()
    if "-" in day_spec and "," not in day_spec:
        a, b = [d.strip() for d in day_spec.split("-", 1)]
        start = _DAY_IDX.get(a, 0)
        end = _DAY_IDX.get(b, 6)
        return list(range(start, end + 1)) if start <= end else list(range(start, 7)) + list(range(0, end + 1))
    return [_DAY_IDX[d.strip()] for d in day_spec.split(",") if d.strip() in _DAY_IDX]


def get_time_for_day(compressed: str, day_idx: int) -> Optional[Tuple[int, int]]:
    """
    Parse open_hour_compressed và trả về (open_minutes, close_minutes) cho ngày day_idx.
    Format: '[Mon-Sun]:[08:00-22:00] | [Sat,Sun]:[09:00-23:00]'
    Trả về None nếu không mở cửa ngày đó.
    """
    if not compressed:
        return None
    for seg in compressed.split(" | "):
        m = _SEG_RE.search(seg)
        if not m:
            continue
        if day_idx not in _expand_days(m.group(1)):
            continue
        first_slot = m.group(2).split(",")[0].strip()
        parts = first_slot.split("-")
        if len(parts) == 2:
            try:
                return time_to_minutes(parts[0].strip()), time_to_minutes(parts[1].strip())
            except Exception:
                continue
    return None


def get_time_for_day_json(open_hour: str, day_idx: int) -> Optional[Tuple[int, int]]:
    """Parse CSV open_hour JSON and return the first open/close slot for day_idx."""
    if not open_hour:
        return None
    try:
        data = json.loads(open_hour)
    except (TypeError, json.JSONDecodeError):
        return None

    slots = data.get(_DAY_JSON_KEYS[day_idx])
    if not slots:
        return None

    first_slot = slots[0]
    if not isinstance(first_slot, list) or len(first_slot) < 2:
        return None

    try:
        return time_to_minutes(first_slot[0][:5]), time_to_minutes(first_slot[1][:5])
    except Exception:
        return None


def is_day_explicitly_closed(open_hour: str, day_idx: int) -> bool:
    """True if the JSON explicitly lists an empty slot array for day_idx —
    i.e. the place is closed that day — as opposed to the key being absent
    entirely (no data recorded, which should fall back to "hours unknown"
    instead of "closed")."""
    if not open_hour:
        return False
    try:
        data = json.loads(open_hour)
    except (TypeError, json.JSONDecodeError):
        return False
    key = _DAY_JSON_KEYS[day_idx]
    return key in data and data[key] == []


# ──────────────────────────────────────────────────────────────────────────────
# Haversine travel time (fallback khi không dùng Goong API)
# ──────────────────────────────────────────────────────────────────────────────

def _haversine_km(lon1: float, lat1: float, lon2: float, lat2: float) -> float:
    R = 6371.0
    dLat = math.radians(lat2 - lat1)
    dLon = math.radians(lon2 - lon1)
    a = (math.sin(dLat / 2) ** 2
         + math.cos(math.radians(lat1)) * math.cos(math.radians(lat2)) * math.sin(dLon / 2) ** 2)
    return R * 2 * math.atan2(math.sqrt(a), math.sqrt(1 - a))


def build_travel_times_haversine(
    coords: Dict[str, Tuple[float, float]],
    speed_kmh: float = 30.0,
) -> Dict[Tuple[str, str], int]:
    """Ước tính thời gian di chuyển theo đường chim bay ở tốc độ speed_kmh km/h."""
    times: Dict[Tuple[str, str], int] = {}
    ids = list(coords.keys())
    for from_id in ids:
        lon1, lat1 = coords[from_id]
        for to_id in ids:
            if from_id == to_id:
                continue
            lon2, lat2 = coords[to_id]
            km = _haversine_km(lon1, lat1, lon2, lat2)
            times[(from_id, to_id)] = max(1, round(km / speed_kmh * 60))
    return times


def build_distances_haversine(
    coords: Dict[str, Tuple[float, float]],
) -> Dict[Tuple[str, str], float]:
    """Estimate pairwise distances in kilometers using Haversine."""
    distances: Dict[Tuple[str, str], float] = {}
    ids = list(coords.keys())
    for from_id in ids:
        lon1, lat1 = coords[from_id]
        for to_id in ids:
            if from_id == to_id:
                continue
            lon2, lat2 = coords[to_id]
            distances[(from_id, to_id)] = _haversine_km(lon1, lat1, lon2, lat2)
    return distances


def _load_travel_cache(cache_path: str) -> dict:
    if not os.path.exists(cache_path):
        return {}
    try:
        with open(cache_path, "r", encoding="utf-8") as cache_file:
            return json.load(cache_file)
    except (OSError, json.JSONDecodeError):
        return {}


def _save_travel_cache(cache_path: str, cache: dict) -> None:
    cache_dir = os.path.dirname(cache_path) or "."
    os.makedirs(cache_dir, exist_ok=True)
    temp_path = f"{cache_path}.{os.getpid()}.tmp"
    with open(temp_path, "w", encoding="utf-8") as cache_file:
        json.dump(cache, cache_file, ensure_ascii=False, indent=2)
        cache_file.flush()
        os.fsync(cache_file.fileno())
    os.replace(temp_path, cache_path)


def _database_travel_mode(vehicle: str) -> str:
    return "MOTORBIKE" if str(vehicle).lower() == "bike" else "DRIVING"


def _load_distance_matrix_db(
    place_ids: List[str],
    vehicle: str,
) -> Dict[Tuple[str, str], dict]:
    supabase_url = os.getenv("SUPABASE_URL", "").strip()
    supabase_key = os.getenv("SUPABASE_KEY", "").strip()
    if not supabase_url or not supabase_key or not place_ids:
        return {}

    headers = {
        "apikey": supabase_key,
        "Authorization": f"Bearer {supabase_key}",
        "Accept-Profile": "travel",
    }
    rows: Dict[Tuple[str, str], dict] = {}
    unique_ids = list(dict.fromkeys(place_ids))
    chunk_size = 30
    url = supabase_url.rstrip("/") + "/rest/v1/distance_matrix"
    for origin_start in range(0, len(unique_ids), chunk_size):
        origins = unique_ids[origin_start:origin_start + chunk_size]
        for destination_start in range(0, len(unique_ids), chunk_size):
            destinations = unique_ids[destination_start:destination_start + chunk_size]
            response = requests.get(
                url,
                headers=headers,
                params={
                    "select": (
                        "origin_place_id,destination_place_id,"
                        "distance_meters,duration_seconds"
                    ),
                    "travel_mode": f"eq.{_database_travel_mode(vehicle)}",
                    "origin_place_id": f"in.({','.join(origins)})",
                    "destination_place_id": f"in.({','.join(destinations)})",
                },
                timeout=10,
            )
            if not response.ok:
                raise RuntimeError(
                    f"distance_matrix HTTP {response.status_code}: "
                    f"{_safe_console_text(response.text[:200])}"
                )
            for row in response.json():
                pair = (row["origin_place_id"], row["destination_place_id"])
                rows[pair] = {
                    "minutes": max(
                        1, math.ceil(float(row["duration_seconds"]) / 60)
                    ),
                    "distance_km": max(
                        0.0, float(row["distance_meters"]) / 1000
                    ),
                    "distance_source": "goong_db",
                }
    return rows


def _upsert_distance_matrix_db(
    pairs: Dict[Tuple[str, str], int],
    distances: Dict[Tuple[str, str], float],
    vehicle: str,
) -> None:
    supabase_url = os.getenv("SUPABASE_URL", "").strip()
    supabase_key = os.getenv("SUPABASE_KEY", "").strip()
    if not supabase_url or not supabase_key or not pairs:
        return

    payload = [
        {
            "origin_place_id": pair[0],
            "destination_place_id": pair[1],
            "travel_mode": _database_travel_mode(vehicle),
            "distance_meters": max(
                0, round(float(distances.get(pair, 0.0)) * 1000)
            ),
            "duration_seconds": max(0, int(minutes) * 60),
            "updated_at": datetime.datetime.now().isoformat(timespec="seconds"),
        }
        for pair, minutes in pairs.items()
        if pair[0] != pair[1] and distances.get(pair, 0) > 0
    ]
    if not payload:
        return

    response = requests.post(
        supabase_url.rstrip("/") + "/rest/v1/distance_matrix",
        headers={
            "apikey": supabase_key,
            "Authorization": f"Bearer {supabase_key}",
            "Content-Profile": "travel",
            "Prefer": "resolution=merge-duplicates,return=minimal",
            "Content-Type": "application/json",
        },
        params={
            "on_conflict": "origin_place_id,destination_place_id,travel_mode"
        },
        json=payload,
        timeout=15,
    )
    if not response.ok:
        raise RuntimeError(
            f"distance_matrix upsert HTTP {response.status_code}: "
            f"{_safe_console_text(response.text[:200])}"
        )


def _append_travel_history(cache_entry: dict, minutes: int) -> None:
    """Append one Goong observation for later travel-time reliability estimates."""
    now = datetime.datetime.now()
    history = cache_entry.setdefault("history", [])
    history.append({
        "minutes": int(minutes),
        "weekday": now.weekday(),
        "hour": now.hour,
        "ts": now.isoformat(timespec="seconds"),
    })
    if len(history) > 100:
        del history[:-100]


def _safe_console_text(value: object) -> str:
    """Return an ASCII-safe string for Windows console/file redirection."""
    return str(value).encode("ascii", "backslashreplace").decode("ascii")


def build_travel_matrix(
    coords: Dict[str, Tuple[float, float]],
    api_key: str = "",
    vehicle: str = "bike",
    cache_path: str = TRAVEL_CACHE_PATH,
    speed_kmh: float = 30.0,
    refresh_cache: bool = False,
    goong_workers: int = 2,
    require_goong: bool = False,
) -> Tuple[Dict[Tuple[str, str], int], Dict[Tuple[str, str], float], Dict[Tuple[str, str], str], Dict[Tuple[str, str], List[dict]]]:
    """
    Build travel minutes, distance km, and source per pair.
    Cached Goong results are reused; missing/failed pairs fall back to Haversine.
    """
    distances = build_distances_haversine(coords)
    fallback_times = build_travel_times_haversine(coords, speed_kmh=speed_kmh)
    times: Dict[Tuple[str, str], int] = {}
    sources: Dict[Tuple[str, str], str] = {}
    reliability: Dict[Tuple[str, str], List[dict]] = {}
    cache = {}
    ids = list(coords.keys())
    try:
        database_cache = _load_distance_matrix_db(ids, vehicle)
        for pair, entry in database_cache.items():
            cache[f"{vehicle}:{pair[0]}:{pair[1]}"] = entry
    except Exception as exc:
        print(
            "  [WARNING] distance_matrix read failed: "
            f"{_safe_console_text(exc)}"
        )
    missing: List[Tuple[str, str]] = []

    for from_id in ids:
        for to_id in ids:
            if from_id == to_id:
                continue
            key = f"{vehicle}:{from_id}:{to_id}"
            cached = cache.get(key)
            if cached and "history" in cached:
                reliability[(from_id, to_id)] = cached.get("history") or []
            cached_is_goong = (
                cached
                and cached.get("distance_source") in {"goong", "goong_db"}
            )
            cache_is_usable = (
                cached
                and "minutes" in cached
                and not refresh_cache
                and (not api_key or cached_is_goong)
            )
            if cache_is_usable:
                times[(from_id, to_id)] = int(cached["minutes"])
                if cached_is_goong and "distance_km" in cached:
                    distances[(from_id, to_id)] = float(cached["distance_km"])
                sources[(from_id, to_id)] = (
                    cached.get("distance_source")
                    if cached.get("distance_source") == "goong_db"
                    else (
                        "goong_cache"
                        if cached.get("distance_source") == "goong"
                        else "haversine_cache"
                    )
                )
            else:
                missing.append((from_id, to_id))

    if api_key and missing:
        print(f"  Cache hit: {len(times)} cap, can goi Goong cho {len(missing)} cap con thieu.")
        try:
            goong_times, goong_distances = build_travel_data_goong(
                coords,
                api_key,
                vehicle=vehicle,
                max_workers=goong_workers,
            )
            for pair, minutes in goong_times.items():
                times[pair] = minutes
                if goong_distances.get(pair, 0) > 0:
                    distances[pair] = goong_distances[pair]
                sources[pair] = "goong"
                key = f"{vehicle}:{pair[0]}:{pair[1]}"
                cache_entry = cache.get(key) or {}
                cache_entry.update({
                    "minutes": minutes,
                    "distance_km": round(distances.get(pair, 0.0), 3),
                    "distance_source": "goong",
                })
                _append_travel_history(cache_entry, minutes)
                reliability[pair] = cache_entry.get("history") or []
                cache[key] = cache_entry
            try:
                _upsert_distance_matrix_db(
                    goong_times, goong_distances, vehicle
                )
            except Exception as exc:
                print(
                    "  [WARNING] distance_matrix upsert failed: "
                    f"{_safe_console_text(exc)}"
                )
        except Exception as e:
            print(f"  [WARNING] Goong API failed: {_safe_console_text(e)}")
            print("  Falling back to Haversine for uncached pairs.")

    for pair in distances:
        if pair not in times:
            times[pair] = fallback_times[pair]
            sources[pair] = "haversine"

    if require_goong:
        non_goong_pairs = sum(1 for source in sources.values() if source not in GOONG_TRAVEL_SOURCES)
        if non_goong_pairs:
            print(
                "  [WARNING] Goong is required for final routing, "
                f"but {non_goong_pairs} matrix pairs are non-Goong. "
                "GA will avoid non-Goong edges."
            )

    return times, distances, sources, reliability


def refresh_travel_matrix_for_day_pools(
    coords: Dict[str, Tuple[float, float]],
    day_pools: List[dict],
    hotel_id: str,
    travel_times: Dict[Tuple[str, str], int],
    travel_distances: Dict[Tuple[str, str], float],
    travel_sources: Dict[Tuple[str, str], str],
    travel_reliability: Dict[Tuple[str, str], List[dict]],
    api_key: str,
    vehicle: str = "car",
    cache_path: str = TRAVEL_CACHE_PATH,
    speed_kmh: float = 30.0,
    require_goong: bool = False,
) -> int:
    """
    Refresh Goong data only for dense per-day route pools.

    Building a full Goong matrix for 100+ candidates creates O(N^2) pairs and
    can make the planner request unstable. Daily GA only needs edges between
    the hotel and places assigned to the same day, so this function refreshes
    those smaller sub-matrices and keeps Haversine/cache values for everything
    else.
    """
    if not api_key:
        if require_goong:
            raise RuntimeError("GOONG_API_KEY is required when require_goong=True.")
        return 0

    # `coords` is still the full topK candidate set (needed by the caller for
    # clustering earlier), but the cache read below only ever gets queried
    # for pairs INSIDE a day pool's own subset (see the `for from_id in ids`
    # loop further down) — reading it for every one of the ~160 candidates
    # was pure waste (e.g. a request with 51 places actually scheduled still
    # paid for a 160x160 chunked read). Scope the read to the ids that will
    # genuinely appear in some day pool (+ hotel) instead.
    relevant_ids: set[str] = {hotel_id}
    for pool in day_pools:
        for place in (
            *(pool.get("attractions") or []),
            *(pool.get("restaurants") or []),
            *(pool.get("cafes") or []),
            *(pool.get("entertainment") or []),
        ):
            if place.id in coords:
                relevant_ids.add(place.id)

    cache = {}
    try:
        database_cache = _load_distance_matrix_db(list(relevant_ids), vehicle)
        for pair, entry in database_cache.items():
            cache[f"{vehicle}:{pair[0]}:{pair[1]}"] = entry
    except Exception as exc:
        print(
            "  [WARNING] distance_matrix read failed: "
            f"{_safe_console_text(exc)}"
        )
    refreshed_pairs: set[Tuple[str, str]] = set()
    processed_subsets: set[Tuple[str, ...]] = set()

    for pool in day_pools:
        # BUGFIX 2026-07-12: cafes were missing from this list, so any
        # cafe leg was structurally never eligible for a live Goong refresh
        # here — it stayed Haversine forever regardless of API budget.
        # BUGFIX: entertainment had the same gap — added alongside cafes.
        places = [
            *(pool.get("attractions") or []),
            *(pool.get("restaurants") or []),
            *(pool.get("cafes") or []),
            *(pool.get("entertainment") or []),
        ]
        ids = [hotel_id, *[place.id for place in places if place.id in coords]]
        ids = list(dict.fromkeys(ids))
        if len(ids) <= 1:
            continue

        subset_key = tuple(sorted(ids))
        if subset_key in processed_subsets:
            continue
        processed_subsets.add(subset_key)

        needs_refresh = False
        for from_id in ids:
            for to_id in ids:
                if from_id == to_id:
                    continue
                source = travel_sources.get((from_id, to_id), "")
                cache_key = f"{vehicle}:{from_id}:{to_id}"
                cached = cache.get(cache_key)
                if source in GOONG_TRAVEL_SOURCES:
                    continue
                if (
                    cached
                    and cached.get("distance_source") in {"goong", "goong_db"}
                    and "minutes" in cached
                ):
                    minutes = int(cached["minutes"])
                    travel_times[(from_id, to_id)] = minutes
                    travel_distances[(from_id, to_id)] = float(cached.get("distance_km") or 0.0)
                    travel_sources[(from_id, to_id)] = (
                        "goong_db"
                        if cached.get("distance_source") == "goong_db"
                        else "goong_cache"
                    )
                    travel_reliability[(from_id, to_id)] = cached.get("history") or []
                    continue
                needs_refresh = True

        if not needs_refresh:
            continue

        subset_coords = {place_id: coords[place_id] for place_id in ids}
        try:
            # max_workers>1 routes through the resilient multi-threaded path
            # (_fetch_goong_distance_batch_resilient), which retries/splits
            # failing sub-batches instead of aborting on the first bad one,
            # and only raises when EVERY batch for this day's subset failed.
            goong_times, goong_distances = build_travel_data_goong(
                subset_coords,
                api_key,
                vehicle=vehicle,
                max_workers=4,
            )
        except Exception as exc:
            if require_goong:
                raise
            # The matrix already contains Haversine/cache values for every
            # pair. Keep those values for THIS day and move on — a failure
            # here (e.g. a transient 429 on this day's specific coordinate
            # set) doesn't mean every other day's Goong call will also fail,
            # so don't disable Goong for the rest of the request.
            print(
                "  [WARNING] Goong refresh unavailable for this day pool; "
                f"using existing matrix/Haversine values: {_safe_console_text(exc)}"
            )
            continue
        for pair, minutes in goong_times.items():
            travel_times[pair] = minutes
            if goong_distances.get(pair, 0) > 0:
                travel_distances[pair] = goong_distances[pair]
            elif pair not in travel_distances:
                lon1, lat1 = coords[pair[0]]
                lon2, lat2 = coords[pair[1]]
                travel_distances[pair] = _haversine_km(lon1, lat1, lon2, lat2)
            travel_sources[pair] = "goong"
            cache_key = f"{vehicle}:{pair[0]}:{pair[1]}"
            cache_entry = cache.get(cache_key) or {}
            cache_entry.update({
                "minutes": minutes,
                "distance_km": round(travel_distances.get(pair, 0.0), 3),
                "distance_source": "goong" if goong_distances.get(pair, 0) > 0 else "haversine",
            })
            _append_travel_history(cache_entry, minutes)
            travel_reliability[pair] = cache_entry.get("history") or []
            cache[cache_key] = cache_entry
            refreshed_pairs.add(pair)
        try:
            _upsert_distance_matrix_db(
                goong_times, goong_distances, vehicle
            )
        except Exception as exc:
            print(
                "  [WARNING] distance_matrix upsert failed: "
                f"{_safe_console_text(exc)}"
            )


    if require_goong:
        required_non_goong = 0
        for pool in day_pools:
            places = [
                *(pool.get("attractions") or []),
                *(pool.get("restaurants") or []),
                *(pool.get("cafes") or []),
                *(pool.get("entertainment") or []),
            ]
            ids = [hotel_id, *[place.id for place in places if place.id in coords]]
            ids = list(dict.fromkeys(ids))
            for from_id in ids:
                for to_id in ids:
                    if from_id == to_id:
                        continue
                    if travel_sources.get((from_id, to_id)) not in GOONG_TRAVEL_SOURCES:
                        required_non_goong += 1
        if required_non_goong:
            print(
                "  [WARNING] Goong is required, but "
                f"{required_non_goong} daily route edges are non-Goong."
            )

    return len(refreshed_pairs)


# ──────────────────────────────────────────────────────────────────────────────
# Supabase data fetching
# ──────────────────────────────────────────────────────────────────────────────

def fetch_places_from_db(
    supabase_url: str,
    supabase_key: str,
    city_id: Optional[str] = None,
    limit: int = DEMO_PLACE_COUNT,
) -> List[dict]:
    """Demo: lấy ngẫu nhiên các địa điểm từ Supabase để thử thuật toán."""
    if not _supabase_available:
        raise ImportError("Cài đặt supabase-py: pip install supabase")
    client = create_client(supabase_url, supabase_key)
    query = (
        client.schema("travel")
        .table("places")
        .select("id, name, longitude, latitude, open_hour_compressed, source, type_id, visit_duration")
        .not_.is_("longitude", "null")
        .not_.is_("latitude", "null")
        .eq("is_active", True)
        .limit(limit)
    )
    if city_id:
        query = query.eq("city_id", city_id)
    return query.execute().data or []


def fetch_places_from_api(
    base_url: str,
    endpoint: str = "/explore/places",
    city_id: Optional[str] = None,
    limit: int = DEMO_PLACE_COUNT,
) -> List[dict]:
    """Fetch places from the app backend API configured by BASE_URL."""
    url = urljoin(base_url.rstrip("/") + "/", endpoint.lstrip("/"))
    params = {
        "page": 1,
        "limit": limit,
    }
    if city_id:
        params["city_id"] = city_id

    response = requests.get(url, params=params, timeout=20)
    response.raise_for_status()
    payload = response.json()

    if isinstance(payload, list):
        return payload
    if isinstance(payload, dict):
        for key in ("data", "items", "results", "places"):
            value = payload.get(key)
            if isinstance(value, list):
                return value

    raise RuntimeError(
        f"API response from {url} must be a list or contain data/items/results/places list."
    )


def fetch_places_from_supabase_rest(
    supabase_url: str,
    supabase_key: str,
    city_id: Optional[str] = None,
    limit: int = DEMO_PLACE_COUNT,
) -> List[dict]:
    """Fetch GA-ready place rows directly from Supabase REST API."""
    url = supabase_url.rstrip("/") + "/rest/v1/places"
    params = {
        "select": "id,name,longitude,latitude,open_hour_compressed,source,type_id,visit_duration",
        "longitude": "not.is.null",
        "latitude": "not.is.null",
        "is_active": "eq.true",
        "limit": str(limit),
    }
    if city_id:
        params["city_id"] = f"eq.{city_id}"

    response = requests.get(
        url,
        params=params,
        headers={
            "apikey": supabase_key,
            "Authorization": f"Bearer {supabase_key}",
            "Accept-Profile": "travel",
        },
        timeout=20,
    )
    response.raise_for_status()
    payload = response.json()
    if not isinstance(payload, list):
        raise RuntimeError(f"Supabase response from {url} must be a list.")
    return payload


def fetch_places_from_csv(
    csv_path: str,
    city_id: Optional[str] = None,
    limit: int = DEMO_PLACE_COUNT,
    seed: Optional[int] = None,
    type_filter: bool = True,
) -> List[dict]:
    """Load a random demo sample from one city/province in the local CSV export."""
    if not os.path.exists(csv_path):
        raise FileNotFoundError(f"CSV file not found: {csv_path}")

    candidates: List[dict] = []
    with open(csv_path, newline="", encoding="utf-8") as csv_file:
        reader = csv.DictReader(csv_file)
        for row in reader:
            row = {
                (key or "").lstrip("\ufeff").strip().strip('"'): (value.strip().strip('"') if isinstance(value, str) else value)
                for key, value in row.items()
            }
            if city_id and row.get("city_id") != city_id:
                continue
            if row.get("status") == "closed":
                continue
            if (row.get("is_active") or "").lower() != "true":
                continue
            if (row.get("is_approved") or "").lower() != "true":
                continue
            if (row.get("source") or "").lower() not in DEMO_ALLOWED_SOURCES:
                continue
            if type_filter and not is_allowed_demo_type(row):
                continue
            if not row.get("longitude") or not row.get("latitude"):
                continue
            candidates.append(row)

    rng = random.Random(seed)
    rng.shuffle(candidates)
    return candidates[:limit]


def load_types_from_csv(types_path: str) -> Dict[str, dict]:
    """Load place type metadata keyed by type id."""
    if not types_path:
        return {}
    if not os.path.exists(types_path):
        raise FileNotFoundError(f"Types CSV file not found: {types_path}")

    result: Dict[str, dict] = {}
    with open(types_path, newline="", encoding="utf-8-sig") as csv_file:
        reader = csv.DictReader(csv_file)
        for row in reader:
            clean_row = {
                (key or "").lstrip("\ufeff").strip().strip('"'): (value.strip().strip('"') if isinstance(value, str) else value)
                for key, value in row.items()
            }
            type_id = clean_row.get("id")
            if type_id:
                result[type_id] = clean_row
    return result


def fetch_places_by_ids(
    supabase_url: str,
    supabase_key: str,
    place_ids: List[str],
) -> List[dict]:
    """Lấy thông tin các địa điểm theo danh sách IDs từ Supabase travel.places."""
    if not _supabase_available:
        raise ImportError("Cài đặt supabase-py: pip install supabase")
    client = create_client(supabase_url, supabase_key)
    return (
        client.schema("travel")
        .table("places")
        .select("id, name, longitude, latitude, open_hour_compressed, source, type_id, visit_duration")
        .in_("id", place_ids)
        .execute()
        .data or []
    )


def fetch_place_by_id(
    supabase_url: str,
    supabase_key: str,
    place_id: str,
) -> Optional[dict]:
    """Lấy thông tin 1 địa điểm (dùng cho hotel) từ Supabase."""
    if not _supabase_available:
        raise ImportError("Cài đặt supabase-py: pip install supabase")
    client = create_client(supabase_url, supabase_key)
    rows = (
        client.schema("travel")
        .table("places")
        .select("id, name, longitude, latitude")
        .eq("id", place_id)
        .limit(1)
        .execute()
        .data or []
    )
    return rows[0] if rows else None


def row_to_place(row: dict, day_idx: int) -> Optional["Place"]:
    """
    Chuyển 1 row DB thành Place object.
    - source='foody' → restaurant (60 phút tham quan)
    - còn lại        → attraction (90 phút tham quan)
    Nếu đóng cửa hôm nay → dùng khung giờ mặc định 08:00-22:00.
    """
    try:
        lon = float(row["longitude"])
        lat = float(row["latitude"])
    except (TypeError, ValueError):
        return None

    raw_open_hour = row.get("open_hour") or ""
    time_window = get_time_for_day_json(raw_open_hour, day_idx)
    compressed = row.get("open_hour_compressed") or ""
    if time_window is None:
        time_window = get_time_for_day_json(compressed, day_idx)
    # An explicit `[]` for this weekday means "closed this day", not "no
    # data" — must not fall through to the CSV-format fallback or the
    # open-all-day default, otherwise a place with real per-weekday hours
    # (e.g. closed Mondays) gets scheduled as if it were open all day.
    explicitly_closed = time_window is None and (
        is_day_explicitly_closed(raw_open_hour, day_idx)
        or is_day_explicitly_closed(compressed, day_idx)
    )
    if time_window is None and not explicitly_closed:
        time_window = get_time_for_day(compressed, day_idx)
    unknown_hours = time_window is None and not explicitly_closed
    if time_window is None:
        open_min, close_min = (0, 0) if explicitly_closed else (0, 1440)
    else:
        open_min, close_min = time_window

    source = (row.get("source") or "").lower()
    type_id = row.get("type_id") or ""
    type_name = (TYPE_BY_ID.get(type_id) or {}).get("name") or ""
    if is_lunch_restaurant_row(row):
        place_type, default_duration = "restaurant", 60
    else:
        place_type, default_duration = "attraction", 90

    db_duration = row.get("visit_duration")
    visit_duration = int(db_duration) if db_duration else default_duration
    try:
        rating = float(row.get("average_rating") or 0)
    except (TypeError, ValueError):
        rating = 0.0

    return Place(
        id=str(row["id"]),
        name=str(row["name"]),
        place_type=place_type,
        source=source,
        type_id=type_id,
        type_name=type_name,
        longitude=lon,
        latitude=lat,
        open_time=open_min,
        close_time=close_min,
        visit_duration=visit_duration,
        rating=rating,
        unknown_hours=unknown_hours,
    )


def make_centroid_hotel(places: List["Place"]) -> "Place":
    """Tạo khách sạn giả tại tâm của tập địa điểm."""
    lons = [p.longitude for p in places]
    lats = [p.latitude for p in places]
    return Place(
        id="demo_hotel",
        name="Khách sạn Demo (tâm địa điểm)",
        place_type="hotel",
        source="demo",
        longitude=sum(lons) / len(lons),
        latitude=sum(lats) / len(lats),
    )


# ──────────────────────────────────────────────────────────────────────────────
# Data Models
# ──────────────────────────────────────────────────────────────────────────────

@dataclass
class POI:
    """A point of interest to visit during the tour (attraction or restaurant)."""
    id: str
    name: str
    place_type: str
    open_time: int        # minutes from midnight
    close_time: int       # minutes from midnight
    visit_duration: int   # minutes spent at this location
    rating: float = 0.0
    unknown_hours: bool = False
    longitude: float = 0.0
    latitude: float = 0.0
    candidate_rank: int = 0
    candidate_total: int = 1
    estimated_cost: float = 0.0
    price_basis: str = "unknown"
    price_inferred: Optional[bool] = None
    best_time: str = "ALL_DAY"
    best_time_source: str = "default_all_day"


@dataclass
class Hotel:
    """A hotel serving as the tour's base / start location."""
    id: str
    name: str
    estimated_cost: float = 0.0
    price_basis: str = "per_room_per_night"
    price_inferred: Optional[bool] = None


@dataclass
class Place:
    """
    Unified place descriptor for multi-day trip planning.

    place_type : "hotel" | "restaurant" | "cafe" | "entertainment" | "attraction"
    Restaurants are meal POIs with extra lunch-window constraints.
    Cafe and entertainment are normal POIs unless a time preference is configured.
    open_time / close_time / visit_duration are ignored for hotels.
    """
    id: str
    name: str
    place_type: str
    source: str = ""
    type_id: str = ""
    type_name: str = ""
    longitude: float = 0.0
    latitude: float = 0.0
    open_time: int = 0
    close_time: int = 1440
    visit_duration: int = 60
    rating: float = 0.0
    unknown_hours: bool = False
    candidate_rank: int = 0
    candidate_total: int = 1
    open_hour: str = ""
    open_hour_compressed: str = ""
    estimated_cost: float = 0.0
    price_basis: str = "unknown"
    price_inferred: Optional[bool] = None
    best_time: str = "ALL_DAY"
    best_time_source: str = "default_all_day"
    district_old: str = ""

    def _get_normalized_type(self) -> str:
        normalized = (self.place_type or "").strip().lower()
        if normalized in {
            "hotel",
            "restaurant",
            "cafe",
            "entertainment",
            "attraction",
        }:
            return normalized

        # Use name heuristics only for legacy rows without a DB planner role.
        cafe_keywords = ["cafe", "cà phê", "kem", "chè", "flan"]
        food_keywords = ["bánh căn", "bún", "lẩu", "ốc", "gỏi", "cơm", "phở", "quán", "nhà hàng", "ăn đêm", "buffet", "nem", "nướng"]
        name_lower = self.name.lower()
        if any(kw in name_lower for kw in cafe_keywords):
            return "cafe"
        if any(kw in name_lower for kw in food_keywords):
            return "restaurant"
        return self.place_type

    def to_poi(self) -> "POI":
        return POI(
            id=self.id,
            name=self.name,
            place_type=self._get_normalized_type(),
            open_time=self.open_time,
            close_time=self.close_time,
            visit_duration=self.visit_duration,
            rating=self.rating,
            unknown_hours=self.unknown_hours,
            longitude=self.longitude,
            latitude=self.latitude,
            candidate_rank=self.candidate_rank,
            candidate_total=self.candidate_total,
            estimated_cost=self.estimated_cost,
            price_basis=self.price_basis,
            price_inferred=self.price_inferred,
            best_time=self.best_time,
            best_time_source=self.best_time_source,
        )

    def to_poi_for_day(self, day_idx: int) -> "POI":
        time_window = get_time_for_day_json(self.open_hour, day_idx)
        if time_window is None:
            time_window = get_time_for_day_json(self.open_hour_compressed, day_idx)
        # See row_to_place: an explicit `[]` for this weekday means closed
        # that day, distinct from "no data" — must not fall back to the CSV
        # parser or the open-all-day default in that case.
        explicitly_closed = time_window is None and (
            is_day_explicitly_closed(self.open_hour, day_idx)
            or is_day_explicitly_closed(self.open_hour_compressed, day_idx)
        )
        if time_window is None and not explicitly_closed:
            time_window = get_time_for_day(self.open_hour_compressed, day_idx)

        if time_window is None:
            open_min, close_min = (0, 0) if explicitly_closed else (0, 1440)
            unknown = not explicitly_closed
        else:
            open_min, close_min = time_window
            unknown = False
            
        return POI(
            id=self.id,
            name=self.name,
            place_type=self._get_normalized_type(),
            open_time=open_min,
            close_time=close_min,
            visit_duration=self.visit_duration,
            rating=self.rating,
            unknown_hours=unknown,
            longitude=self.longitude,
            latitude=self.latitude,
            candidate_rank=self.candidate_rank,
            candidate_total=self.candidate_total,
            estimated_cost=self.estimated_cost,
            price_basis=self.price_basis,
            price_inferred=self.price_inferred,
            best_time=self.best_time,
            best_time_source=self.best_time_source,
        )

    def to_hotel(self) -> "Hotel":
        return Hotel(
            self.id,
            self.name,
            self.estimated_cost,
            self.price_basis or "per_room_per_night",
            self.price_inferred,
        )


def select_geographic_hotel(
    hotels: List[Place],
    trip_places: List[Place],
    trip_budget: float = 0.0,
    hotel_total_cost_fn=None,
) -> Place:
    """Choose a hotel in the dominant POI region before considering rank."""
    if not hotels:
        raise ValueError("No hotels found in places list.")

    all_candidates = [
        place
        for place in trip_places
        if place.place_type != "hotel"
        and -90 <= float(place.latitude) <= 90
        and -180 <= float(place.longitude) <= 180
    ]
    primary_candidates = [
        place
        for place in all_candidates
        if place.place_type in {"attraction", "cafe", "entertainment"}
    ]
    candidates = primary_candidates or all_candidates
    if not candidates:
        return min(hotels, key=lambda hotel: hotel.candidate_rank)

    def distance_km(a: Place, b: Place) -> float:
        radius_km = 6371.0
        lat1 = math.radians(float(a.latitude))
        lat2 = math.radians(float(b.latitude))
        delta_lat = lat2 - lat1
        delta_lng = math.radians(float(b.longitude) - float(a.longitude))
        value = (
            math.sin(delta_lat / 2) ** 2
            + math.cos(lat1) * math.cos(lat2) * math.sin(delta_lng / 2) ** 2
        )
        return 2 * radius_km * math.atan2(math.sqrt(value), math.sqrt(1 - value))

    def median(values: List[float]) -> float:
        ordered = sorted(values)
        middle = len(ordered) // 2
        if len(ordered) % 2:
            return ordered[middle]
        return (ordered[middle - 1] + ordered[middle]) / 2

    def hotel_key(hotel: Place) -> tuple:
        distances = sorted(distance_km(hotel, place) for place in candidates)
        nearby_15 = sum(distance <= 15.0 for distance in distances)
        nearby_35 = sum(distance <= 35.0 for distance in distances)
        nearest_count = min(12, len(distances))
        nearest_mean = sum(distances[:nearest_count]) / nearest_count
        median_distance = median(distances)
        hotel_cost = (
            float(hotel_total_cost_fn(hotel))
            if hotel_total_cost_fn is not None
            else float(hotel.estimated_cost or 0)
        )
        budget_overage = (
            max(0.0, hotel_cost - trip_budget * 0.40)
            if trip_budget > 0
            else 0.0
        )
        return (
            -nearby_15,
            -nearby_35,
            round(nearest_mean, 4),
            round(median_distance, 4),
            round(budget_overage / BUDGET_OVERAGE_UNIT_VND, 4),
            int(hotel.candidate_rank),
        )

    return min(hotels, key=hotel_key)


@dataclass
class TourConfig:
    """Global day-tour configuration."""
    start_time: int = 480    # 08:00
    end_time: int = 1080     # 18:00

    @property
    def available_time(self) -> int:
        """Total usable minutes in the tour day."""
        return self.end_time - self.start_time


@dataclass
class ScheduleEntry:
    """One stop in the day schedule."""
    location_id: str
    location_name: str
    travel_from_id: str
    travel_from_name: str
    travel_minutes: int
    raw_travel_minutes: int
    travel_buffer_minutes: int
    travel_buffer_source: str
    distance_km: float
    travel_source: str
    arrival_time: int
    departure_time: int
    wait_time: int = 0
    is_restaurant: bool = False
    unknown_hours: bool = False
    is_return_to_hotel: bool = False
    place_type: str = "attraction"
    base_duration: int = 0
    estimated_cost: float = 0.0
    price_basis: str = "unknown"
    price_inferred: Optional[bool] = None
    two_tower_score: float = 0.0
    best_time: str = "ALL_DAY"
    best_time_source: str = "default_all_day"
    best_time_applicable: bool = False

    @property
    def arrival_str(self) -> str:
        return minutes_to_time(self.arrival_time)

    @property
    def departure_str(self) -> str:
        return minutes_to_time(self.departure_time)

    @property
    def service_start_time(self) -> int:
        """Minute when the actual visit/meal starts after waiting."""
        return self.arrival_time + self.wait_time

    @property
    def service_start_str(self) -> str:
        return minutes_to_time(self.service_start_time)

    @property
    def active_duration(self) -> int:
        """Time actually spent at this location (excluding wait)."""
        return self.departure_time - self.arrival_time - self.wait_time


@dataclass
class GAResult:
    """Final result returned by TSP_TW_GA.run()."""
    best_chromosome: List[int]
    schedule: List[ScheduleEntry]
    fitness: float
    cost: float
    total_travel_time: int
    total_distance_km: float
    total_visit_time: int
    total_wait_time: int
    total_penalty: int
    total_hard_violations: int
    meal_violations: int
    restaurant_count: int
    total_activity_cost: float
    total_transport_cost: float
    total_day_cost: float
    budget_limit: float
    budget_overage: float
    budget_penalty: float
    skipped_count: int
    idle_time: int
    generation_found: int
    generations_run: int
    stopped_reason: str
    # Indices (into the GA's pois list) actually visited, in visit order.
    # Populated only when TSP_TW_GA is run with greedy_fit=True.
    visited_poi_indices: List[int] = field(default_factory=list)
    # Set by SchedulerV2Planner.solve_one_day() when this day's area has no
    # real restaurant candidate even after _ensure_restaurant_coverage()'s
    # widened search — enforce_lunch was turned off for this day, and this
    # message explains why to the traveller instead of silently missing
    # lunch with no context. Empty string when the day has normal coverage.
    lunch_unavailable_reason: str = ""


@dataclass
class DayResult:
    """Optimised schedule for one day in a multi-day trip."""
    day: int
    # All POIs passed to this day's GA (used as index base for visited_poi_indices).
    pois: List[POI]
    ga_result: GAResult

    @property
    def visited_pois(self) -> List[POI]:
        """POIs actually visited today, in visit order."""
        # Prefer the schedule's own ids: visited_poi_indices are relative to
        # whatever (possibly pre-pruned) pois list the solver actually ran on,
        # which is not always self.pois -- see scheduler_v2's PRE-PRUNING.
        # Falling back to indices only when the schedule is unexpectedly empty
        # avoids silently mis-attributing a visit to the wrong POI.
        scheduled_ids = [
            entry.location_id
            for entry in self.ga_result.schedule
            if not entry.is_return_to_hotel
        ]
        if scheduled_ids:
            by_id = {poi.id: poi for poi in self.pois}
            return [by_id[place_id] for place_id in scheduled_ids if place_id in by_id]
        if self.ga_result.visited_poi_indices:
            return [self.pois[i] for i in self.ga_result.visited_poi_indices]
        return []


@dataclass
class MultiDayResult:
    """Complete result for a multi-day trip."""
    hotel: Hotel
    num_days: int
    days: List[DayResult]
    assignment_result: Optional[AssignmentResult] = None
    validation_result: Optional[object] = None


# ──────────────────────────────────────────────────────────────────────────────
# Genetic Algorithm
# ──────────────────────────────────────────────────────────────────────────────

class TSP_TW_GA:
    """
    Genetic Algorithm for TSP with Time Windows.

    Parameters
    ----------
    pois              : list of POI objects (attractions + restaurants)
    travel_times      : dict mapping (from_id, to_id) -> travel minutes
    config            : TourConfig with day start/end time
    start_location_id : ID used as the tour's starting location (e.g. hotel)
    population_size   : number of chromosomes per generation (default 50)
    generations       : number of GA iterations (default 10)
    mutation_rate     : probability of mutating an offspring (default 0.1)
    """

    PENALTY_MULTIPLIER = 2  # extra cost per minute of time-window violation
    TRAVEL_TIME_BUFFER_PERCENT = 0.20  # 20% buffer
    MIN_TRAVEL_TIME_BUFFER = 5         # 5 minutes minimum buffer

    def __init__(
        self,
        pois: List[POI],
        travel_times: Dict[Tuple[str, str], int],
        travel_distances: Optional[Dict[Tuple[str, str], float]] = None,
        travel_sources: Optional[Dict[Tuple[str, str], str]] = None,
        travel_reliability: Optional[Dict[Tuple[str, str], List[dict]]] = None,
        config: Optional[TourConfig] = None,
        start_location_id: str = "start",
        population_size: int = 50,
        generations: int = 10,
        mutation_rate: float = 0.1,
        greedy_fit: bool = False,
        return_to_hotel: bool = False,
        travel_buffer_percent: float = DEFAULT_TRAVEL_BUFFER_PERCENT,
        travel_buffer_min: int = DEFAULT_TRAVEL_BUFFER_MIN,
        travel_buffer_max: int = DEFAULT_TRAVEL_BUFFER_MAX,
        require_goong_edges: bool = False,
        day_budget: float = 0.0,
        adult_equivalent: float = 1.0,
        travel_vehicle: str = "car",
    ):
        self.pois = pois
        self.travel_times = travel_times
        self.travel_distances = travel_distances or {}
        self.travel_sources = travel_sources or {}
        self.travel_reliability = travel_reliability or {}
        self.config = config or TourConfig()
        self.start_location_id = start_location_id
        self.population_size = population_size
        self.generations = generations
        self.mutation_rate = mutation_rate
        self.greedy_fit = greedy_fit
        self.return_to_hotel = return_to_hotel
        self.travel_buffer_percent = travel_buffer_percent
        self.travel_buffer_min = travel_buffer_min
        self.travel_buffer_max = travel_buffer_max
        self.require_goong_edges = require_goong_edges
        self.day_budget = max(0.0, float(day_budget or 0))
        self.adult_equivalent = max(0.0, float(adult_equivalent or 0))
        self.travel_vehicle = travel_vehicle if travel_vehicle in TRANSPORT_COST_PER_KM else "car"
        base_cost_per_km = TRANSPORT_COST_PER_KM.get(
            self.travel_vehicle,
            TRANSPORT_COST_DEFAULT,
        )
        # Fuel cost is per vehicle, not per person: a group needs
        # ceil(headcount / seats_per_vehicle) vehicles, each burning fuel over
        # the same distance, so total cost scales by vehicle count.
        capacity = VEHICLE_CAPACITY.get(self.travel_vehicle)
        vehicles = (
            max(1, math.ceil(max(1.0, self.adult_equivalent) / capacity))
            if capacity
            else 1
        )
        self.cost_per_km = base_cost_per_km * vehicles
        self.n = len(pois)

    # ── Helpers ───────────────────────────────────────────────────────────────

    def _travel(self, from_id: str, to_id: str) -> int:
        """Return travel time in minutes between two location IDs."""
        base_travel_time = self.travel_times.get((from_id, to_id), 0)
        buffer, _ = self._travel_buffer(from_id, to_id, base_travel_time, None)
        return base_travel_time + buffer

    def _raw_travel(self, from_id: str, to_id: str) -> int:
        return self.travel_times.get((from_id, to_id), 0)

    def _travel_buffer(
        self,
        from_id: str,
        to_id: str,
        base_travel_time: int,
        departure_time: Optional[int],
    ) -> Tuple[int, str]:
        # distance_matrix is the single source of truth. Travel time is
        # rounded once by scheduler_v2 and persisted for the winning route;
        # adding a hidden buffer here would make solver timestamps disagree
        # with the API/UI and compound again on later reads.
        return 0, "matrix"

    def _historical_travel_buffer(
        self,
        from_id: str,
        to_id: str,
        base_travel_time: int,
    ) -> Optional[Tuple[int, str]]:
        samples = self.travel_reliability.get((from_id, to_id)) or []
        all_samples = [
            int(sample["minutes"])
            for sample in samples
            if isinstance(sample, dict) and "minutes" in sample
        ]
        if len(all_samples) >= P95_MIN_HISTORY_SAMPLES:
            return self._percentile_buffer(base_travel_time, all_samples, 0.95), "p95"
        if len(all_samples) >= P90_MIN_HISTORY_SAMPLES:
            return self._percentile_buffer(base_travel_time, all_samples, 0.90), "p90"
        return None

    def _percentile_buffer(self, base_travel_time: int, samples: List[int], percentile: float) -> int:
        ordered = sorted(samples)
        idx = min(len(ordered) - 1, max(0, math.ceil(len(ordered) * percentile) - 1))
        planning_time = ordered[idx]
        return max(0, planning_time - base_travel_time)

    def _distance(self, from_id: str, to_id: str) -> float:
        return self.travel_distances.get((from_id, to_id), 0.0)

    def _travel_source(self, from_id: str, to_id: str) -> str:
        return self.travel_sources.get((from_id, to_id), "unknown")

    def _poi_utility(self, poi: POI) -> float:
        total = max(1, poi.candidate_total)
        bounded_rank = min(max(poi.candidate_rank, 0), total - 1)
        rank_score = 1.0 - (bounded_rank / total)
        rating_score = min(max(poi.rating, 0.0), 5.0) / 5.0
        return UTILITY_SCALE * (
            ALPHA_DEFAULT * rank_score + (1 - ALPHA_DEFAULT) * rating_score
        )

    def _poi_cost(self, poi: POI) -> float:
        if poi.estimated_cost <= 0:
            return 0.0
        return poi.estimated_cost

    def _is_late_entertainment(self, poi: POI) -> bool:
        text = normalize_text(f"{poi.name} {poi.place_type}")
        return any(
            keyword in text
            for keyword in (
                "karaoke", "bar", "pub", "club", "cinema", "rap phim",
                "billiard", "bida", "game", "escape", "bowling",
            )
        )

    def _earliest_service_start(self, poi: POI) -> int:
        if self._is_late_entertainment(poi):
            return LATE_ENTERTAINMENT_START
        if poi.place_type == "entertainment":
            return ENTERTAINMENT_EARLIEST_START
        if poi.place_type == "cafe":
            return CAFE_EARLIEST_START
        return 0

    def _time_preference_penalty(self, poi: POI, service_start: int) -> int:
        if poi.place_type == "attraction" and service_start >= ATTRACTION_LATEST_START:
            return TIME_PREFERENCE_PENALTY
        if service_start < self._earliest_service_start(poi):
            return TIME_PREFERENCE_PENALTY
        return 0

    # ?? Schedule simulation ???????????????????????????????????????????????

    def _objective(self, chromosome: List[int]) -> dict:
        """
        Utility-based TOPTW fitness for a single day.
        Fitness = feasibility_penalty + 0.5 * travel + 0.8 * wait - sum(utility).
        """
        config = self.config
        schedule: List[ScheduleEntry] = []
        current_time = config.start_time
        current_loc = self.start_location_id
        current_name = "Start"
        total_travel = 0
        total_distance = 0.0
        total_visit = 0
        total_wait = 0
        total_penalty = 0
        hard_violations = 0
        restaurant_count = 0
        type_counts: Dict[str, int] = {}
        soft_preference_penalty = 0
        total_utility = 0.0
        total_activity_cost = 0.0
        skipped_count = 0
        visited_indices: List[int] = []

        for pos, poi_idx in enumerate(chromosome):
            poi = self.pois[poi_idx]
            raw_t = self._raw_travel(current_loc, poi.id)
            buffer_t, buffer_source = self._travel_buffer(current_loc, poi.id, raw_t, current_time)
            travel = raw_t + buffer_t
            distance = self._distance(current_loc, poi.id)
            travel_source = self._travel_source(current_loc, poi.id)
            if self.require_goong_edges and travel_source not in GOONG_TRAVEL_SOURCES:
                if self.greedy_fit:
                    continue
                hard_violations += 1
                total_penalty += FEASIBILITY_PENALTY
            arrival = current_time + travel
            wait = max(0, poi.open_time - arrival)
            service_start = arrival + wait
            earliest_start = self._earliest_service_start(poi)

            if (
                self.greedy_fit
                and poi.place_type != "restaurant"
                and not poi.unknown_hours
                and wait > MAX_NON_MEAL_WAIT_MINUTES
            ):
                skipped_count += 1
                continue
            if self.greedy_fit and earliest_start > 0 and service_start < earliest_start:
                skipped_count += 1
                continue

            type_limit = DAILY_TYPE_LIMITS.get(poi.place_type)
            candidate_soft_penalty = 0
            if type_limit is not None and poi.place_type != "restaurant":
                over_count = max(0, type_counts.get(poi.place_type, 0) - type_limit + 1)
                candidate_soft_penalty += over_count * SOFT_TYPE_LIMIT_PENALTY

            if poi.place_type == "restaurant":
                if restaurant_count >= 1:
                    continue
                if poi.unknown_hours:
                    candidate_soft_penalty += 30
                wait = max(wait, LUNCH_START - arrival)
                if not poi.unknown_hours and arrival + wait + poi.visit_duration > LUNCH_END:
                    continue
                service_start = arrival + wait

            time_preference_penalty = self._time_preference_penalty(poi, service_start)
            candidate_soft_penalty += time_preference_penalty

            actual_duration = poi.visit_duration
            depart = arrival + wait + actual_duration
            if self.greedy_fit:
                dep_est = depart
                if self.return_to_hotel:
                    dep_est += self._travel(poi.id, self.start_location_id)
                if dep_est > config.end_time:
                    skipped_count += 1
                    continue

            total_travel += travel
            total_distance += distance
            total_visit += actual_duration
            total_wait += wait
            poi_cost = self._poi_cost(poi)
            total_activity_cost += poi_cost
            if arrival > poi.close_time:
                hard_violations += 1
                total_penalty += FEASIBILITY_PENALTY
            if depart > poi.close_time:
                hard_violations += 1
                total_penalty += FEASIBILITY_PENALTY
            soft_preference_penalty += candidate_soft_penalty
            if poi.place_type == "restaurant":
                restaurant_count += 1
            total_utility += self._poi_utility(poi)
            schedule.append(
                ScheduleEntry(
                    poi.id, poi.name, current_loc, current_name,
                    travel, raw_t, buffer_t, buffer_source, distance,
                    travel_source,
                    arrival, depart, wait,
                    poi.place_type == "restaurant", poi.unknown_hours,
                    place_type=poi.place_type,
                    base_duration=poi.visit_duration,
                    estimated_cost=poi_cost,
                    price_basis=poi.price_basis,
                    price_inferred=poi.price_inferred,
                    best_time=poi.best_time,
                    best_time_source=poi.best_time_source,
                    two_tower_score=self._poi_utility(poi) / UTILITY_SCALE,
                )
            )
            visited_indices.append(poi_idx)
            type_counts[poi.place_type] = type_counts.get(poi.place_type, 0) + 1
            current_loc = poi.id
            current_name = poi.name
            current_time = depart

        if self.return_to_hotel and schedule and current_loc != self.start_location_id:
            raw_return_travel = self._raw_travel(current_loc, self.start_location_id)
            return_buffer, return_buffer_source = self._travel_buffer(current_loc, self.start_location_id, raw_return_travel, current_time)
            return_travel = raw_return_travel + return_buffer
            return_distance = self._distance(current_loc, self.start_location_id)
            return_source = self._travel_source(current_loc, self.start_location_id)
            arrival = current_time + return_travel
            total_travel += return_travel
            total_distance += return_distance
            if self.require_goong_edges and return_source not in GOONG_TRAVEL_SOURCES:
                hard_violations += 1
                total_penalty += FEASIBILITY_PENALTY
            schedule.append(
                ScheduleEntry(
                    self.start_location_id, "Hotel", current_loc, current_name,
                    return_travel, raw_return_travel, return_buffer, return_buffer_source,
                    return_distance, return_source,
                    arrival, arrival, 0, False, False, True,
                    place_type="hotel",
                )
            )

        actual_time = total_visit + total_travel + total_wait
        idle_time = max(0, config.available_time - actual_time)

        has_restaurant_candidate = any(p.place_type == "restaurant" for p in self.pois)
        meal_violations = 1 if has_restaurant_candidate and restaurant_count == 0 else 0
        if meal_violations:
            total_penalty += FEASIBILITY_PENALTY
        total_transport_cost = total_distance * self.cost_per_km
        total_day_cost = total_activity_cost + total_transport_cost
        budget_overage = max(0.0, total_day_cost - self.day_budget) if self.day_budget > 0 else 0.0
        budget_penalty = (budget_overage / BUDGET_OVERAGE_UNIT_VND) * BUDGET_PENALTY_WEIGHT
        fitness = (
            total_penalty
            + soft_preference_penalty
            + (UTILITY_TRAVEL_WEIGHT * total_travel)
            + (WAIT_TIME_WEIGHT * total_wait)
            + budget_penalty
            + (25 * skipped_count)
            - total_utility
        )
        return {
            "schedule": schedule,
            "fitness": fitness,
            "cost": fitness,
            "total_travel": total_travel,
            "total_distance": total_distance,
            "total_visit": total_visit,
            "total_wait": total_wait,
            "total_penalty": total_penalty,
            "hard_violations": hard_violations,
            "meal_violations": meal_violations,
            "restaurant_count": restaurant_count,
            "total_activity_cost": total_activity_cost,
            "total_transport_cost": total_transport_cost,
            "total_day_cost": total_day_cost,
            "budget_limit": self.day_budget,
            "budget_overage": budget_overage,
            "budget_penalty": budget_penalty,
            "skipped_count": skipped_count,
            "idle_time": idle_time,
            "visited_indices": visited_indices,
        }

    # ?? GA operators ???????????????????????????????????????????????????????

    def _init_population(self) -> List[List[int]]:
        """Generate full POI permutations as the initial TSP-TW population."""
        indices = list(range(self.n))
        population: List[List[int]] = []
        seen = set()
        attempts = 0
        max_attempts = max(self.population_size * 20, self.population_size)
        while len(population) < self.population_size and attempts < max_attempts:
            attempts += 1
            chrom = indices[:]
            random.shuffle(chrom)
            key = tuple(chrom)
            if key not in seen:
                seen.add(key)
                population.append(chrom)
        while len(population) < self.population_size:
            chrom = indices[:]
            random.shuffle(chrom)
            population.append(chrom)
        return population

    def _roulette_select(self, population: List[List[int]], fitnesses: List[float]) -> List[int]:
        """
        Roulette-wheel selection biased toward lower fitness values.
        Selection probability ? (max_fitness - fitness).
        """
        max_f = max(fitnesses) + 1.0
        scores = [max_f - f for f in fitnesses]
        total = sum(scores)
        if total <= 0:
            return random.choice(population)[:]
        r = random.uniform(0, total)
        cumulative = 0.0
        for i, s in enumerate(scores):
            cumulative += s
            if cumulative >= r:
                return population[i][:]
        return population[-1][:]

    def _pmx_crossover(self, p1: List[int], p2: List[int]) -> Tuple[List[int], List[int]]:
        """
        Partially Mapped Crossover (PMX) for full TSP-TW permutations.
        """
        if not p1 or not p2:
            return p1[:], p2[:]
        if len(p1) != len(p2):
            min_len = min(len(p1), len(p2))
            cut = random.randint(1, min_len - 1) if min_len > 1 else 1
            child1_raw = p1[:cut] + p2[cut:]
            child2_raw = p2[:cut] + p1[cut:]
            return child1_raw, child2_raw
        n = len(p1)
        if n < 2:
            return p1[:], p2[:]
        c1, c2 = sorted(random.sample(range(n), 2))

        def make_child(base: List[int], donor: List[int]) -> List[int]:
            child: List[Optional[int]] = [None] * n
            child[c1:c2 + 1] = donor[c1:c2 + 1]
            donor_segment = set(donor[c1:c2 + 1])
            for i in list(range(0, c1)) + list(range(c2 + 1, n)):
                gene = base[i]
                guard = 0
                while gene in donor_segment and guard < n:
                    mapped_idx = donor.index(gene)
                    gene = base[mapped_idx]
                    guard += 1
                child[i] = gene
            return [int(gene) for gene in child if gene is not None]

        return make_child(p1, p2), make_child(p2, p1)

    def _mutate(self, chromosome: List[int]) -> List[int]:
        """
        Swap mutation for full TSP-TW permutations.
        """
        if len(chromosome) < 2:
            return chromosome[:]
        result = chromosome[:]
        i, j = random.sample(range(len(result)), 2)
        result[i], result[j] = result[j], result[i]
        return result

    def _refine_visit_order(self, chromosome: List[int]) -> Tuple[List[int], dict]:
        """Local route refinement for the selected POIs after GA convergence."""
        best_chrom = chromosome[:]
        best_result = self._objective(best_chrom)
        if len(best_chrom) < 3:
            return best_chrom, best_result

        improved = True
        passes = 0
        while improved and passes < 3:
            passes += 1
            improved = False

            for i in range(len(best_chrom) - 1):
                for j in range(i + 1, len(best_chrom)):
                    candidate = best_chrom[:]
                    candidate[i], candidate[j] = candidate[j], candidate[i]
                    result = self._objective(candidate)
                    if result["fitness"] < best_result["fitness"]:
                        best_chrom = candidate
                        best_result = result
                        improved = True

            for i in range(len(best_chrom) - 2):
                for j in range(i + 2, len(best_chrom) + 1):
                    candidate = best_chrom[:i] + list(reversed(best_chrom[i:j])) + best_chrom[j:]
                    result = self._objective(candidate)
                    if result["fitness"] < best_result["fitness"]:
                        best_chrom = candidate
                        best_result = result
                        improved = True

        return best_chrom, best_result

    # ?? Main run ???????????????????????????????????????????????????????????

    def run(self, seed: Optional[int] = None) -> GAResult:
        """
        Execute the full genetic algorithm.
        """
        if not self.pois:
            raise ValueError("No POIs provided.")
        if seed is not None:
            random.seed(seed)

        best_chromosome: Optional[List[int]] = None
        best_result: Optional[dict] = None
        best_fitness = float("inf")
        best_gen = 0
        generations_run = 0
        stale_generations = 0
        stopped_reason = "max_generations"
        population = self._init_population()
        if not population:
            raise ValueError("No feasible chromosome could be generated.")

        for gen in range(1, self.generations + 1):
            generations_run = gen
            evaluated = [self._objective(c) for c in population]
            fitnesses = [r["fitness"] for r in evaluated]
            improved = False
            for i, result in enumerate(evaluated):
                if result["fitness"] < best_fitness:
                    best_fitness = result["fitness"]
                    best_chromosome = population[i][:]
                    best_result = result
                    best_gen = gen
                    improved = True
            stale_generations = 0 if improved else stale_generations + 1

            if stale_generations >= EARLY_STOP_PATIENCE:
                stopped_reason = "no_improvement"
                break

            new_pop: List[List[int]] = []
            while len(new_pop) < self.population_size:
                p1 = self._roulette_select(population, fitnesses)
                p2 = self._roulette_select(population, fitnesses)
                c1, c2 = self._pmx_crossover(p1, p2)
                if random.random() < self.mutation_rate:
                    c1 = self._mutate(c1)
                if random.random() < self.mutation_rate:
                    c2 = self._mutate(c2)
                if c1:
                    new_pop.append(c1)
                if c2:
                    new_pop.append(c2)
            population = new_pop[:self.population_size]

        if best_result is None:
            best_chromosome = population[0][:]
            best_result = self._objective(best_chromosome)
            best_fitness = best_result["fitness"]

        if self.greedy_fit and best_result.get("visited_indices"):
            refined_chromosome, refined_result = self._refine_visit_order(
                best_result["visited_indices"],
            )
            if refined_result["fitness"] < best_result["fitness"]:
                best_chromosome = refined_chromosome
                best_result = refined_result
                best_fitness = refined_result["fitness"]
                stopped_reason = f"{stopped_reason}|local_refined"

        return GAResult(
            best_chromosome=best_chromosome or [],
            schedule=best_result["schedule"],
            fitness=best_fitness,
            cost=best_result["cost"],
            total_travel_time=best_result["total_travel"],
            total_distance_km=best_result["total_distance"],
            total_visit_time=best_result["total_visit"],
            total_wait_time=best_result["total_wait"],
            total_penalty=best_result["total_penalty"],
            total_hard_violations=best_result["hard_violations"],
            meal_violations=best_result["meal_violations"],
            restaurant_count=best_result["restaurant_count"],
            total_activity_cost=best_result["total_activity_cost"],
            total_transport_cost=best_result["total_transport_cost"],
            total_day_cost=best_result["total_day_cost"],
            budget_limit=best_result["budget_limit"],
            budget_overage=best_result["budget_overage"],
            budget_penalty=best_result["budget_penalty"],
            skipped_count=best_result["skipped_count"],
            idle_time=best_result["idle_time"],
            generation_found=best_gen,
            generations_run=generations_run,
            stopped_reason=stopped_reason,
            visited_poi_indices=best_result.get("visited_indices", []),
        )


# ──────────────────────────────────────────────────────────────────────────────
# Multi-day planner
# ──────────────────────────────────────────────────────────────────────────────

class MultiDayTripPlanner:
    """
    Plans a multi-day trip from a unified list of places.

    Hotels are used as the fixed starting point each day.
    Restaurants are POIs with lunch-window constraints; attractions are regular visit candidates.

    POIs are pre-allocated by hotel-centered geographic sectors before GA.
    Each day runs an independent TSP-TW GA over its assigned pool.
    """

    def __init__(
        self,
        places: List[Place],
        num_days: int,
        travel_times: Dict[Tuple[str, str], int],
        travel_distances: Optional[Dict[Tuple[str, str], float]] = None,
        travel_sources: Optional[Dict[Tuple[str, str], str]] = None,
        travel_reliability: Optional[Dict[Tuple[str, str], List[dict]]] = None,
        selected_hotel_id: Optional[str] = None,
        hotel_total_cost: float = 0.0,
        day_start_time: int = 480,
        day_end_time: int = 1080,
        population_size: int = DEFAULT_POPULATION_SIZE,
        generations: int = 200,
        mutation_rate: float = DEFAULT_MUTATION_RATE,
        return_to_hotel: bool = False,
        travel_buffer_percent: float = DEFAULT_TRAVEL_BUFFER_PERCENT,
        travel_buffer_min: int = DEFAULT_TRAVEL_BUFFER_MIN,
        travel_buffer_max: int = DEFAULT_TRAVEL_BUFFER_MAX,
        require_goong_edges: bool = False,
        trip_budget_total: float = 0.0,
        adult_count: int = 1,
        child_count: int = 0,
        travel_vehicle: str = "car",
        trip_start_date: Optional[str] = None,
    ):
        if num_days < 1:
            raise ValueError("num_days must be >= 1.")
        self.num_days = num_days
        total_candidates = max(1, len(places))
        for rank, place in enumerate(places):
            if place.candidate_total <= 1 and total_candidates > 1:
                place.candidate_rank = rank
                place.candidate_total = total_candidates
            else:
                place.candidate_rank = min(max(place.candidate_rank, 0), max(0, place.candidate_total - 1))
                place.candidate_total = max(1, place.candidate_total)
        hotels = [p for p in places if p.place_type == "hotel"]
        if not hotels:
            raise ValueError("No hotels found in places list.")
        self.adult_count = max(1, int(adult_count or 1))
        self.child_count = max(0, int(child_count or 0))
        self.full_people = self.adult_count + self.child_count
        self.adult_equivalent = self.full_people
        self.trip_budget_total = max(0.0, float(trip_budget_total or 0))
        self.trip_budget = self.trip_budget_total * 0.9
        if selected_hotel_id is not None:
            hotel_place = next((p for p in hotels if p.id == selected_hotel_id), None)
            if hotel_place is None:
                raise ValueError(f"Hotel '{selected_hotel_id}' not found in places list.")
        else:
            hotel_place = self._select_hotel(hotels, places)

        self.hotel = hotel_place.to_hotel()
        self.travel_times = travel_times
        self.travel_distances = travel_distances or {}
        self.travel_sources = travel_sources or {}
        self.travel_reliability = travel_reliability or {}
        self.day_start_time = day_start_time
        self.day_end_time = day_end_time
        self.population_size = population_size
        self.generations = generations
        self.mutation_rate = mutation_rate
        self.return_to_hotel = return_to_hotel
        self.travel_buffer_percent = travel_buffer_percent
        self.travel_buffer_min = travel_buffer_min
        self.travel_buffer_max = travel_buffer_max
        self.require_goong_edges = require_goong_edges
        self.travel_vehicle = travel_vehicle if travel_vehicle in TRANSPORT_COST_PER_KM else "car"
        try:
            self.start_date = (
                datetime.date.fromisoformat(trip_start_date)
                if trip_start_date
                else datetime.date.today()
            )
        except ValueError:
            self.start_date = datetime.date.today()
        self.hotel_place = hotel_place
        self.hotel_total_cost = (
            max(0.0, float(hotel_total_cost or 0))
            or self._hotel_total_cost(hotel_place)
        )
        residual_budget = max(0.0, self.trip_budget - self.hotel_total_cost)
        self.daily_budget = residual_budget / self.num_days if self.num_days > 0 else 0.0

        self.attractions: List[Place] = [
            p for p in places if p.place_type in {"attraction", "cafe", "entertainment"}
        ]
        self.restaurants: List[Place] = [p for p in places if p.place_type == "restaurant"]
        self.pois: List[POI] = [p.to_poi() for p in self.attractions + self.restaurants]
        self.target_pois_per_day = self._target_pois_per_day()
        self.target_nonmeal_per_day = max(1, self.target_pois_per_day - 1)
        self.assignment_result = self._preallocate_days()
        self.day_pool = self.assignment_result.day_pools

    def _hotel_total_cost(self, hotel: Place) -> float:
        per_person_nightly = (
            hotel.estimated_cost
            if hotel.estimated_cost > 0
            else FALLBACK_HOTEL_COST_PER_NIGHT / ROOM_CAPACITY
        )
        nights = max(1, self.num_days - 1)
        return per_person_nightly * nights * self.full_people

    def _select_hotel(self, hotels: List[Place], places: List[Place]) -> Place:
        return select_geographic_hotel(
            hotels,
            places,
            trip_budget=self.trip_budget,
            hotel_total_cost_fn=self._hotel_total_cost,
        )

    def _new_day_pool(self) -> List[dict]:
        return [
            {
                "attractions": [],
                "restaurants": [],
            }
            for _ in range(self.num_days)
        ]

    def _angle_from_hotel(self, place: Place) -> float:
        angle = math.atan2(
            place.latitude - self.hotel_place.latitude,
            place.longitude - self.hotel_place.longitude,
        )
        return (angle + 2 * math.pi) % (2 * math.pi)

    def _sector_index(self, place: Place) -> int:
        if self.num_days <= 1:
            return 0
        sector_size = (2 * math.pi) / self.num_days
        return min(self.num_days - 1, int(self._angle_from_hotel(place) / sector_size))

    def _sector_distance(self, place: Place, sector_idx: int) -> float:
        if self.num_days <= 1:
            return 0.0
        sector_size = (2 * math.pi) / self.num_days
        center = (sector_idx + 0.5) * sector_size
        diff = abs(self._angle_from_hotel(place) - center)
        return min(diff, 2 * math.pi - diff)

    def _distance_from_hotel(self, place: Place) -> float:
        return math.hypot(
            place.latitude - self.hotel_place.latitude,
            place.longitude - self.hotel_place.longitude,
        )

    def _estimated_place_load(self, place: Place) -> int:
        hotel_travel = self.travel_times.get((self.hotel.id, place.id), 20)
        # This load is only for pre-allocation, not final scheduling.
        # Final route still uses the full Goong matrix and DB visit_duration.
        local_travel_allowance = min(60, max(15, round(hotel_travel * 0.65)))
        return max(30, place.visit_duration) + local_travel_allowance

    def _target_pois_per_day(self) -> int:
        available_minutes = max(0, self.day_end_time - self.day_start_time)
        time_target = max(
            POI_TARGET_MIN_PER_DAY,
            math.floor(available_minutes / POI_TARGET_TIME_SLICE_MINUTES),
        )
        time_target = min(POI_TARGET_MAX_PER_DAY, time_target)
        candidate_avg = math.ceil(
            (len(self.attractions) + len(self.restaurants)) / max(1, self.num_days)
        )
        if candidate_avg <= 0:
            return POI_TARGET_MIN_PER_DAY
        return max(1, min(time_target, candidate_avg))

    def _balanced_count_targets(self, total_count: int) -> List[int]:
        if self.num_days <= 0:
            return []
        base = total_count // self.num_days
        remainder = total_count % self.num_days
        return [base + (1 if idx < remainder else 0) for idx in range(self.num_days)]

    def _assign_balanced_sweep(self, day_pool: List[dict], places: List[Place]) -> None:
        if not places:
            return
        ordered = sorted(
            places,
            key=lambda place: (
                self._angle_from_hotel(place),
                self._distance_from_hotel(place),
                place.candidate_rank,
            ),
        )
        count_targets = self._balanced_count_targets(len(ordered))
        total_load = sum(self._estimated_place_load(place) for place in ordered)
        target_load = total_load / max(1, self.num_days)
        cursor = 0

        for day_idx in range(self.num_days):
            remaining_days = self.num_days - day_idx
            remaining_places = len(ordered) - cursor
            if remaining_places <= 0:
                break

            target_count = count_targets[day_idx]
            if target_count <= 0:
                continue

            min_left_for_rest = sum(count_targets[day_idx + 1 :])
            day_load = 0
            while cursor < len(ordered):
                places_left_after_take = len(ordered) - cursor - 1
                current_count = len(day_pool[day_idx]["attractions"])
                if current_count >= target_count and places_left_after_take >= min_left_for_rest:
                    if day_load >= target_load * 0.85 or remaining_days > 1:
                        break

                place = ordered[cursor]
                cursor += 1
                day_pool[day_idx]["attractions"].append(place)
                day_load += self._estimated_place_load(place)

        # Any rounding leftovers go to the currently lightest adjacent day pool.
        while cursor < len(ordered):
            place = ordered[cursor]
            cursor += 1
            target_idx = min(
                range(self.num_days),
                key=lambda idx: (
                    len(day_pool[idx]["attractions"]),
                    sum(self._estimated_place_load(p) for p in day_pool[idx]["attractions"]),
                ),
            )
            day_pool[target_idx]["attractions"].append(place)

    def _preallocate_non_meal_places(self, day_pool: List[dict]) -> None:
        if not self.attractions:
            return

        # Role-aware hotel-centered sweep:
        # Each role is geographically swept and balanced separately. This keeps
        # every day supplied with visitable attraction/cafe/entertainment options
        # instead of accidentally giving one day mostly cafes or mostly closed POIs.
        for role in ("attraction", "cafe", "entertainment"):
            self._assign_balanced_sweep(
                day_pool,
                [place for place in self.attractions if place.place_type == role],
            )

    def _rebalance_empty_days(self, day_pool: List[dict]) -> None:
        if len(self.attractions) < self.num_days:
            return
        for idx, pool in enumerate(day_pool):
            while len(pool["attractions"]) < self.target_nonmeal_per_day:
                donors = [
                    donor_idx
                    for donor_idx, donor in enumerate(day_pool)
                    if len(donor["attractions"]) > self.target_nonmeal_per_day
                ]
                if not donors:
                    donors = [
                        donor_idx
                        for donor_idx, donor in enumerate(day_pool)
                        if len(donor["attractions"]) > 1
                    ]
                if not donors:
                    break
                donor_idx = min(
                    donors,
                    key=lambda donor_idx: (
                        -len(day_pool[donor_idx]["attractions"]),
                        min(
                            abs(idx - donor_idx),
                            self.num_days - abs(idx - donor_idx),
                        ),
                    ),
                )
                donor = day_pool[donor_idx]["attractions"]
                moved = min(donor, key=lambda p: self._sector_distance(p, idx))
                donor.remove(moved)
                pool["attractions"].append(moved)

    def _load_balance_attractions(self, day_pool: List[dict]) -> None:
        if not self.attractions or self.num_days <= 1:
            return
        avg_per_day = len(self.attractions) / self.num_days
        target_max = max(
            self.target_nonmeal_per_day + 2,
            math.ceil(avg_per_day * 1.2),
        )
        changed = True
        guard = 0
        while changed and guard < len(self.attractions) * 2:
            guard += 1
            changed = False
            for idx, pool in enumerate(day_pool):
                if len(pool["attractions"]) <= target_max:
                    continue
                neighbors = [((idx - 1) % self.num_days), ((idx + 1) % self.num_days)]
                target_idx = min(neighbors, key=lambda n: len(day_pool[n]["attractions"]))
                movable = [
                    p for p in pool["attractions"]
                    if self._sector_distance(p, target_idx) <= self._sector_distance(p, idx)
                ]
                if not movable:
                    continue
                moved = max(movable, key=lambda p: self._sector_distance(p, idx))
                pool["attractions"].remove(moved)
                day_pool[target_idx]["attractions"].append(moved)
                changed = True

    def _preallocate_days(self) -> AssignmentResult:
        assignment = ConstrainedKMeansAssignment(
            AssignmentConfig(
                num_days=self.num_days,
                daily_start_time=self.day_start_time,
                daily_end_time=self.day_end_time,
                trip_intent="",
                hotel=self.hotel_place,
                target_nonmeal_per_day=self.target_nonmeal_per_day,
            ),
            self.travel_times,
        )
        return assignment.assign(self.attractions + self.restaurants)

    def _empty_day_result(self) -> GAResult:
        return GAResult(
            best_chromosome=[],
            schedule=[],
            fitness=FEASIBILITY_PENALTY,
            cost=FEASIBILITY_PENALTY,
            total_travel_time=0,
            total_distance_km=0.0,
            total_visit_time=0,
            total_wait_time=0,
            total_penalty=0,
            total_hard_violations=0,
            meal_violations=0,
            restaurant_count=0,
            total_activity_cost=0.0,
            total_transport_cost=0.0,
            total_day_cost=0.0,
            budget_limit=self.daily_budget,
            budget_overage=0.0,
            budget_penalty=0.0,
            skipped_count=0,
            idle_time=max(0, self.day_end_time - self.day_start_time),
            generation_found=0,
            generations_run=0,
            stopped_reason="no_daily_pois",
            visited_poi_indices=[],
        )

    def run(self, seed: Optional[int] = None) -> MultiDayResult:
        """Execute independent daily GA runs over pre-allocated pools."""
        if not self.pois:
            raise ValueError("No POIs provided.")

        day_results: List[DayResult] = []
        start_day_idx = self.start_date.weekday()
        for day_idx in range(self.num_days):
            pool = self.day_pool[day_idx]
            daily_places: List[Place] = [
                *pool["attractions"],
                *pool["restaurants"],
            ]
            current_day_of_week = (start_day_idx + day_idx) % 7
            day_pois = [place.to_poi_for_day(current_day_of_week) for place in daily_places]
            if not day_pois:
                day_results.append(
                    DayResult(
                        day=day_idx + 1,
                        pois=[],
                        ga_result=self._empty_day_result(),
                    )
                )
                continue

            config = TourConfig(start_time=self.day_start_time, end_time=self.day_end_time)
            ga = TSP_TW_GA(
                pois=day_pois,
                travel_times=self.travel_times,
                travel_distances=self.travel_distances,
                travel_sources=self.travel_sources,
                travel_reliability=self.travel_reliability,
                config=config,
                start_location_id=self.hotel.id,
                population_size=self.population_size,
                generations=self.generations,
                mutation_rate=self.mutation_rate,
                greedy_fit=True,
                return_to_hotel=self.return_to_hotel,
                travel_buffer_percent=self.travel_buffer_percent,
                travel_buffer_min=self.travel_buffer_min,
                travel_buffer_max=self.travel_buffer_max,
                require_goong_edges=self.require_goong_edges,
                day_budget=self.daily_budget,
                adult_equivalent=self.adult_equivalent,
                travel_vehicle=self.travel_vehicle,
            )
            day_seed = None if seed is None else seed + day_idx
            result = ga.run(seed=day_seed)
            visited_ids = {day_pois[i].id for i in result.visited_poi_indices}
            dropped_count = 0
            for dropped in day_pois:
                if dropped.id not in visited_ids:
                    dropped_count += 1
                    print(f"[Planner] Day {day_idx + 1}: dropped {dropped.id} - reason=no_fit_daily_ga")
            if dropped_count:
                result.stopped_reason = f"{result.stopped_reason}|no_fit_daily_ga"
            day_results.append(DayResult(day=day_idx + 1, pois=day_pois, ga_result=result))

        return MultiDayResult(
            hotel=self.hotel,
            num_days=self.num_days,
            days=day_results,
            assignment_result=self.assignment_result,
        )


def debug_objective_breakdown(day_result: DayResult) -> None:
    """
    In breakdown objective function để verify và dùng trong báo cáo.
    Cơ sở: maximize Σ S_i (Vansteenwegen 2011)
    """
    ga = day_result.ga_result
    visited = day_result.visited_pois
    restaurants = [p for p in visited if p.place_type == "restaurant"]
    actual_time = ga.total_visit_time + ga.total_travel_time + ga.total_wait_time
    invested_time = ga.total_visit_time + ga.total_travel_time + ga.total_penalty
    available_time = actual_time + ga.idle_time
    fill_gap = abs(available_time - invested_time)
    travel_penalty = ga.total_travel_time * 0.1
    wait_penalty = ga.total_wait_time * 0.2
    print("\n  [DEBUG OBJECTIVE]")
    print(f"  Visited POI      : {len(visited)}")
    print(f"  Available time   : {available_time} phut")
    print(f"  Invested time    : {invested_time} phut")
    print(f"  Fill gap         : {fill_gap:.2f}")
    print(f"  TW penalty       : {ga.total_penalty} phut")
    print(f"  Travel penalty   : {travel_penalty:.2f}")
    print(f"  Wait penalty     : {wait_penalty:.2f}")
    print(f"  Fitness          : {ga.fitness:.4f}  (= fill_gap + alpha * travel + beta * wait)")
    print(f"  Travel time      : {ga.total_travel_time} phút")
    print(f"  Restaurant       : {len(restaurants)}/1")
    print(f"  Hard violations  : {ga.total_hard_violations}")
    print(f"  Meal violations  : {ga.meal_violations}")


def print_multi_day_schedule(result: MultiDayResult) -> None:
    """Pretty-print a MultiDayResult to stdout."""
    print("\n" + "=" * 62)
    print(f"  LỊCH TRÌNH {result.num_days} NGÀY")
    print(f"  Khách sạn: {result.hotel.name}")
    print("=" * 62)

    for day_result in result.days:
        print(f"\n  [ NGÀY {day_result.day} ]")
        if day_result.day == 1:
            print(f"  >> CHECK-IN: {result.hotel.name}")
        print("-" * 62)

        ga_result = day_result.ga_result
        print("  STT | Dia diem                          | Den - Roi   | Loai      | Thoi luong | Ghi chu")
        print("  " + "-" * 110)
        for idx, entry in enumerate(ga_result.schedule, start=1):
            note_parts = []
            if entry.wait_time > 0:
                note_parts.append(f"cho {entry.wait_time} phut")
            if entry.unknown_hours:
                note_parts.append("gio mo cua chua ro")
            note = "; ".join(note_parts) if note_parts else "-"

            if entry.is_return_to_hotel:
                route = f"{entry.travel_from_name} -> Hotel"
                travel = f"{entry.travel_minutes} phut, {entry.distance_km:.1f} km"
                print(f"  {idx:>3} | {travel:<34} | {entry.arrival_str:<10} | Ve KS     | {'-':<10} | {route}")
                continue
                print(
                    f"  {idx}. {entry.travel_from_name} -> "
                    f"{entry.travel_minutes} phút (raw {entry.raw_travel_minutes} + buffer {entry.travel_buffer_minutes} {entry.travel_buffer_source}) "
                    f"({entry.distance_km:.1f} km) [{entry.travel_source}] -> Hotel"
                )
                print(f"     về khách sạn lúc {entry.arrival_str}")
                continue

            type_label = "Ăn trưa" if entry.is_restaurant else "Tham quan"
            route = f"{entry.travel_from_name} -> {entry.location_name}"
            travel = f"{entry.travel_minutes} phut, {entry.distance_km:.1f} km"
            time_range = f"{entry.service_start_str}-{entry.departure_str}"
            print(f"  {idx:>3} | {travel:<34} | {time_range:<10} | {type_label:<9} | {entry.active_duration:>4} phut  | {note}")
            print(f"      {route}")
            continue
            unknown_str = " | giờ mở cửa chưa rõ" if entry.unknown_hours else ""
            wait_str = f" | chờ {entry.wait_time} phút" if entry.wait_time > 0 else ""
            print(
                f"  {idx}. {entry.travel_from_name} -> "
                f"{entry.travel_minutes} phút (raw {entry.raw_travel_minutes} + buffer {entry.travel_buffer_minutes} {entry.travel_buffer_source}) "
                f"({entry.distance_km:.1f} km) [{entry.travel_source}] -> {entry.location_name}"
            )
            print(
                f"     {entry.service_start_str} - {entry.departure_str} | {type_label}"
                f" | Thời lượng: {entry.active_duration} phút{wait_str}{unknown_str}"
            )

        visited = day_result.visited_pois
        poi_order = " -> ".join(p.name for p in visited)
        print("-" * 62)
        print(f"  Tham quan     : {len(visited)}/{len(day_result.pois)} địa điểm")
        print(f"  Thứ tự        : {poi_order}")
        print(f"  Di chuyển     : {ga_result.total_travel_time} phút | {ga_result.total_distance_km:.1f} km")
        print(f"  Tham quan     : {ga_result.total_visit_time} phút")
        print(f"  Thời gian chờ : {ga_result.total_wait_time} phút")
        print(f"  Ăn trưa       : {ga_result.restaurant_count}/1 điểm")
        print(f"  Cost/Fitness  : {ga_result.cost:.2f}")
        print(f"  Dừng tại      : {ga_result.stopped_reason}@{ga_result.generations_run}")

    print("\n" + "=" * 62)


def print_multi_day_schedule(result: MultiDayResult) -> None:
    """Pretty-print a MultiDayResult as compact human-readable tables."""
    print("\n" + "=" * 62)
    print(f"  LICH TRINH {result.num_days} NGAY")
    print(f"  Khach san: {result.hotel.name}")
    print("=" * 62)

    for day_result in result.days:
        print(f"\n  [ NGAY {day_result.day} ]")
        if day_result.day == 1:
            print(f"  >> CHECK-IN: {result.hotel.name}")
        print("-" * 110)

        ga_result = day_result.ga_result
        print("  STT | Dia diem                          | Den - Roi   | Loai      | Thoi luong | Ghi chu")
        print("  " + "-" * 110)

        for idx, entry in enumerate(ga_result.schedule, start=1):
            note_parts = []
            if entry.wait_time > 0:
                note_parts.append(f"cho {entry.wait_time} phut")
            if entry.unknown_hours:
                note_parts.append("gio mo cua chua ro")
            note = "; ".join(note_parts) if note_parts else "-"

            if entry.is_return_to_hotel:
                travel = f"{entry.travel_minutes} phut, {entry.distance_km:.1f} km"
                print(f"      Di chuyen: {travel}")
                print(f"      Ve khach san luc {entry.arrival_str}")
                continue

            type_label = "An trua" if entry.is_restaurant else "Tham quan"
            travel = f"{entry.travel_minutes} phut, {entry.distance_km:.1f} km"
            time_range = f"{entry.service_start_str}-{entry.departure_str}"
            print(f"      Di chuyen: {travel}")
            print(f"  {idx:>3} | {entry.location_name:<34} | {time_range:<10} | {type_label:<9} | {entry.active_duration:>4} phut  | {note}")

        visited = day_result.visited_pois
        poi_order = " -> ".join(p.name for p in visited)
        print("-" * 110)
        print(f"  Tham quan     : {len(visited)}/{len(day_result.pois)} dia diem")
        print(f"  Thu tu        : {poi_order}")
        print(f"  Di chuyen     : {ga_result.total_travel_time} phut | {ga_result.total_distance_km:.1f} km")
        print(f"  Tham quan     : {ga_result.total_visit_time} phut")
        print(f"  Thoi gian cho : {ga_result.total_wait_time} phut")
        print(f"  An trua       : {ga_result.restaurant_count}/1 diem")
        print(f"  Cost/Fitness  : {ga_result.cost:.2f}")
        print(f"  Dung tai      : {ga_result.stopped_reason}@{ga_result.generations_run}")

    print("\n" + "=" * 62)


if __name__ == "__main__":
    import sys

    parser = argparse.ArgumentParser(description="TSP-TW GA - lập lịch tham quan tối ưu")
    parser.add_argument("--days", type=int, required=True, help="Số ngày đi")
    parser.add_argument("--start", type=str, required=True, help="Giờ bắt đầu mỗi ngày, vd 08:00")
    parser.add_argument("--end", type=str, required=True, help="Giờ kết thúc mỗi ngày, vd 21:00")
    parser.add_argument("--source", type=str, default=DEMO_DATA_SOURCE, choices=("csv", "supabase", "api"), help="Nguồn dữ liệu")
    parser.add_argument("--csv-path", type=str, default=DEMO_CSV_PATH, help="Đường dẫn CSV local")
    parser.add_argument("--types-path", type=str, default=DEMO_TYPES_CSV_PATH, help="Đường dẫn CSV loại địa điểm")
    parser.add_argument("--no-type-filter", action="store_true", help="Không lọc bỏ type demo như cafe, homestay, karaoke, spa...")
    parser.add_argument("--city-id", type=str, default=DEMO_CITY_ID, help="Lọc địa điểm theo city_id")
    parser.add_argument("--limit", type=int, default=DEMO_PLACE_COUNT, help=f"Số địa điểm tối đa (default: {DEMO_PLACE_COUNT})")
    parser.add_argument("--speed", type=float, default=30.0, help="Tốc độ km/h cho Haversine")
    parser.add_argument("--pop", type=int, default=DEFAULT_POPULATION_SIZE, help="Kích thước quần thể GA")
    parser.add_argument("--gen", type=int, default=200, help="Số thế hệ GA")
    parser.add_argument("--mutation", type=float, default=DEFAULT_MUTATION_RATE, help="Xác suất đột biến")
    parser.add_argument("--travel-cache", type=str, default=TRAVEL_CACHE_PATH, help="File cache travel matrix")
    parser.add_argument("--no-goong", action="store_true", help="Không gọi Goong, chỉ dùng cache/Haversine")
    parser.add_argument("--return-to-hotel", action="store_true", help="Cộng thêm chặng quay về khách sạn cuối mỗi ngày")
    parser.add_argument("--travel-buffer-percent", type=float, default=DEFAULT_TRAVEL_BUFFER_PERCENT, help="Tỉ lệ buffer thời gian di chuyển")
    parser.add_argument("--travel-buffer-min", type=int, default=DEFAULT_TRAVEL_BUFFER_MIN, help="Buffer tối thiểu mỗi chặng")
    parser.add_argument("--travel-buffer-max", type=int, default=DEFAULT_TRAVEL_BUFFER_MAX, help="Buffer tối đa mỗi chặng")
    parser.add_argument("--refresh-travel-cache", action="store_true", help="Gọi lại Goong để thêm mẫu lịch sử, kể cả khi đã có cache")
    parser.add_argument("--goong-workers", type=int, default=1, help="So Goong batch request chay song song; 1 = tuan tu an toan")
    parser.add_argument("--early-stop-patience", type=int, default=EARLY_STOP_PATIENCE, help="So the he khong cai thien truoc khi dung som")
    parser.add_argument("--alpha-travel", type=float, default=TRAVEL_TIME_WEIGHT, help="Trong so phat total_travel trong fitness")
    parser.add_argument("--beta-wait", type=float, default=WAIT_TIME_WEIGHT, help="Trong so phat total_wait trong fitness")
    parser.add_argument("--seed", type=int, default=42, help="Random seed")
    args = parser.parse_args()
    EARLY_STOP_PATIENCE = args.early_stop_patience
    TRAVEL_TIME_WEIGHT = args.alpha_travel
    WAIT_TIME_WEIGHT = args.beta_wait

    run_started_at = time.perf_counter()
    phase_times: Dict[str, float] = {}

    env_path = os.path.join(SERVICE_DIR, ".env")
    load_env_file(env_path)
    if _dotenv_available:
        load_dotenv(env_path)

    base_url = os.getenv("BASE_URL_WEB") or os.getenv("BASE_URL") or API_BASE_URL
    places_endpoint = os.getenv("TSP_PLACES_ENDPOINT") or PLACES_ENDPOINT
    goong_api_key = os.getenv("GOONG_API_KEY") or GOONG_API_KEY
    if args.no_goong:
        goong_api_key = ""
    supabase_url = os.getenv("SUPABASE_URL") or SUPABASE_URL
    supabase_key = os.getenv("SUPABASE_KEY") or os.getenv("SUPABASE_ANON_KEY") or SUPABASE_KEY

    today_idx = datetime.date.today().weekday()
    print(f"\n{'='*62}")
    print("  TSP-TW Genetic Algorithm - Lập lịch tham quan tối ưu")
    print(f"{'='*62}")
    print(f"  Hôm nay   : {datetime.date.today()}")
    print(f"  Số ngày   : {args.days}")
    print(f"  Giờ tour  : {args.start} - {args.end}")
    print(f"  Data      : {args.source} | city_id={args.city_id}")
    print(f"  Type filter: {'off' if args.no_type_filter else 'on'}")
    travel_mode = "cache/Haversine only" if args.no_goong else f"Goong API workers={args.goong_workers} (fallback: Haversine {args.speed} km/h)"
    print(f"  Travel    : {travel_mode}")

    if args.source == "csv":
        TYPE_BY_ID = load_types_from_csv(args.types_path)
        meal_type_names = sorted(
            type_info.get("name", "")
            for type_info in TYPE_BY_ID.values()
            if any(keyword in normalize_text(type_info.get("name", "")) for keyword in MEAL_TYPE_NAME_KEYWORDS)
        )
        print(f"  Types     : {len(TYPE_BY_ID)} loại | meal={', '.join(meal_type_names)}")

    phase_started_at = time.perf_counter()
    if args.source == "csv":
        print(f"\nLấy ngẫu nhiên tối đa {args.limit} địa điểm từ CSV theo city_id={args.city_id}...")
        rows = fetch_places_from_csv(
            args.csv_path,
            city_id=args.city_id,
            limit=args.limit,
            seed=args.seed,
            type_filter=not args.no_type_filter,
        )
    elif args.source == "supabase":
        rows = fetch_places_from_supabase_rest(supabase_url, supabase_key, city_id=args.city_id, limit=args.limit)
    else:
        rows = fetch_places_from_api(base_url, endpoint=places_endpoint, city_id=args.city_id, limit=args.limit)
    phase_times["fetch"] = time.perf_counter() - phase_started_at
    print(f"  Tìm thấy  : {len(rows)} địa điểm")
    if not rows:
        print("Không có dữ liệu.")
        sys.exit(1)

    places: List[Place] = []
    skipped = 0
    for row in rows:
        p = row_to_place(row, today_idx)
        if p:
            places.append(p)
        else:
            skipped += 1
    restaurants = [p for p in places if p.place_type == "restaurant"]
    attractions = [p for p in places if p.place_type == "attraction"]
    print(f"  Hợp lệ    : {len(places)} (bỏ qua {skipped})")
    print(f"  Restaurant: {len(restaurants)} | Attraction: {len(attractions)}")
    if not places:
        print("No valid places.")
        sys.exit(1)

    hotel = make_centroid_hotel(places)
    places.insert(0, hotel)
    print(f"\n  Hotel     : {hotel.name}")
    print(f"  Tọa độ    : ({hotel.latitude:.4f}°N, {hotel.longitude:.4f}°E)")

    coords = {p.id: (p.longitude, p.latitude) for p in places}
    phase_started_at = time.perf_counter()
    print(f"\nBuild travel matrix ({len(places)} địa điểm, cache={args.travel_cache})...")
    travel_times, travel_distances, travel_sources, travel_reliability = build_travel_matrix(
        coords,
        api_key=goong_api_key,
        vehicle="bike",
        cache_path=args.travel_cache,
        speed_kmh=args.speed,
        refresh_cache=args.refresh_travel_cache,
        goong_workers=args.goong_workers,
    )
    phase_times["matrix"] = time.perf_counter() - phase_started_at
    source_counts: Dict[str, int] = {}
    for source in travel_sources.values():
        source_counts[source] = source_counts.get(source, 0) + 1
    print(f"  Xong. {len(travel_times)} cặp địa điểm. Sources: {source_counts}")

    print("\nChạy MultiDayTripPlanner...")
    phase_started_at = time.perf_counter()
    print(
        f"  POI: {len(places)-1} | GA pop={args.pop} gen={args.gen} "
        f"mutation={args.mutation} patience={EARLY_STOP_PATIENCE} "
        f"alpha={TRAVEL_TIME_WEIGHT} beta={WAIT_TIME_WEIGHT} seed={args.seed}"
    )
    planner = MultiDayTripPlanner(
        places=places,
        num_days=args.days,
        travel_times=travel_times,
        travel_distances=travel_distances,
        travel_sources=travel_sources,
        travel_reliability=travel_reliability,
        selected_hotel_id=hotel.id,
        day_start_time=time_to_minutes(args.start),
        day_end_time=time_to_minutes(args.end),
        population_size=args.pop,
        generations=args.gen,
        mutation_rate=args.mutation,
        return_to_hotel=args.return_to_hotel,
        travel_buffer_percent=args.travel_buffer_percent,
        travel_buffer_min=args.travel_buffer_min,
        travel_buffer_max=args.travel_buffer_max,
    )
    result = planner.run(seed=args.seed)
    phase_times["ga"] = time.perf_counter() - phase_started_at

    print_multi_day_schedule(result)

    total_visited = sum(len(d.visited_pois) for d in result.days)
    total_distance = sum(d.ga_result.total_distance_km for d in result.days)
    total_travel = sum(d.ga_result.total_travel_time for d in result.days)
    total_visit = sum(d.ga_result.total_visit_time for d in result.days)
    total_wait = sum(d.ga_result.total_wait_time for d in result.days)
    phase_times["total"] = time.perf_counter() - run_started_at
    print(f"  Tổng địa điểm thăm được: {total_visited}/{len(places)-1}")
    print(f"  Tổng thời gian tham quan: {total_visit} phút")
    print(f"  Tổng thời gian di chuyển: {total_travel} phút | Tổng khoảng cách: {total_distance:.1f} km | Tổng chờ: {total_wait} phút")
    print("  Tổng thời gian tính toán: " + " | ".join(f"{name}={seconds:.2f}s" for name, seconds in phase_times.items()))
    print(f"{'='*62}\n")

