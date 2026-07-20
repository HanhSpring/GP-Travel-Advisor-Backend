from __future__ import annotations

import datetime
import math
import threading
from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import dataclass, field
from typing import Dict, List, Optional, Tuple

from app.services.itinerary.assignment import (
    AssignmentConfig,
    AssignmentResult,
    ConstrainedKMeansAssignment,
    MAX_CAFE_OPTIONS_PER_DAY,
)
from app.services.itinerary.clustering_debug_viz import ClusteringDebugRecorder
from app.services.itinerary.geo_clustering import GeoClusteringAssignment
from app.services.itinerary.weekday_matching import match_pools_to_weekdays
from app.services.itinerary import utils

_WEEKDAY_NAMES_VI = ["Thứ 2", "Thứ 3", "Thứ 4", "Thứ 5", "Thứ 6", "Thứ 7", "Chủ Nhật"]

from app.services.itinerary import planner

try:
    from ortools.sat.python import cp_model
except Exception:  # pragma: no cover
    cp_model = None

try:
    import numpy as np
    from sklearn.cluster import KMeans

    _sklearn_available = True
except ImportError:  # pragma: no cover
    np = None  # type: ignore[assignment]
    KMeans = None  # type: ignore[assignment,misc]
    _sklearn_available = False


# ── 0. CONSTRAINT CLASSIFICATION ─────────────────────────────────────────
# Every constraint in this solver is either:
#
#   HARD  — encoded as `model.Add(...)` with no OnlyEnforceIf escape hatch,
#           so the solver returns INFEASIBLE rather than a solution that
#           violates it. Reserved for physical/logical impossibilities —
#           a route cannot visit the same node twice, a place cannot be
#           entered before it opens, a day cannot contain 3 lunches:
#             - model.AddCircuit(arcs)                    — route topology
#             - start_var[j] >= open_time / depart[j] <= close_time
#             - start_var[j] == arrival[j]                 — no implicit
#               waiting for a selected POI (arrive exactly when the visit
#               starts; timeline stays continuous by construction, not by a
#               penalty — there used to be a `wait` slack variable + a soft
#               `wait * 30` objective term here, but the hard `== arrival`
#               constraint already forces wait to 0 whenever selected, and a
#               free/unconstrained wait for *unselected* POIs is driven to 0
#               by the minimization anyway — so the soft term could never be
#               nonzero in any optimal solution. Removed as dead code.)
#             - restaurants <= 2/day, cafes <= 2/day       (meal-slot caps)
#             - MEAL_MIN_GAP_MINUTES between two meals     (ordering/spacing)
#             - target_min <= selected_total <= target_max (POI-count band)
#
#   SOFT  — a weighted term in _add_objective's Minimize(...) expression
#           (Section 2 below). Used for anything that's a *preference*, not
#           an impossibility: travel time, best-time-window fit, lunch
#           timing, skipped-POI count, and — as of this pass — budget.
#
# Budget is deliberately SOFT, not hard: an earlier version capped
# activity+transport cost per day with a hard model.Add(...). That looked
# rigorous, but daily_budget_soft is only a rolling remainder of the whole
# trip's budget (run() subtracts each day's actual cost from what's left),
# so a hard per-day cap could force a degraded/greedy day even when a
# modest overage would still leave the *overall trip* within budget (slack
# borrowed from days that underspend) — and the moment the hard cap made a
# day infeasible, _solve_day_with_fallback fell through to
# _greedy_fallback, which enforces budget only loosely anyway. A "hard"
# constraint bypassed by a fallback isn't hard in any formal sense — the
# same failure mode as the old hard "must have lunch" constraint fixed
# earlier (see LUNCH_HARD_WINDOW below). The real, unconditional
# hard guarantee lives one layer up: validator.py's budget_exceeded check
# compares hotel_total_cost + sum(day costs) against the user's whole-trip
# budget and is a genuine HARD_VIOLATIONS entry — untouched by this file.

# ── 1. MEAL & PHYSIOLOGICAL CONSTRAINTS ──────────────────────────────────
# Cutoff time: If the itinerary starts after 13:30, the solver skips the 
# lunch requirement to avoid forcing a meal when the user might have eaten.
LUNCH_ENFORCE_CUTOFF = 13 * 60 + 30  # 13:30

# Time window for dinner scheduling.
DINNER_START = 18 * 60
DINNER_END = 19 * 60 + 30

# Minimum time gap between lunch and dinner to prevent the solver from 
# scheduling consecutive meals just to fulfill the requirements quickly.
MEAL_MIN_GAP_MINUTES = 210

# ── 2. SOFT PENALTIES (OBJECTIVE FUNCTION WEIGHTS) ───────────────────────
# Hard bound on when a restaurant may serve as lunch. There is no soft drift
# beyond this window — a restaurant that can't fit inside it is simply left
# unselected for that day (SKIPPED_POI_PENALTY already makes skipping cheaper
# than forcing an ill-fitting slot). This replaced an earlier soft per-minute
# penalty (LUNCH_LATE_PENALTY_PER_MIN) that was too weak: the solver could
# still push "lunch" as late as 18:00 (effectively dinner) rather than drop
# it, since the accumulated penalty was cheaper than the alternative.
LUNCH_HARD_WINDOW = (planner.LUNCH_START, planner.LUNCH_END)  # nguồn giá trị: planner.py

# Penalty for idle time specifically at the beginning of the day, beyond a
# grace period (HEAD_IDLE_GRACE_MINUTES) — mirrors TAIL_IDLE_GRACE_MINUTES on
# the other end of the day. A short delay before the first stop is normal
# schedule slack (e.g. deferring to a POI's best-time window); only a
# genuinely late first stop (start well past the earliest physically
# possible time) is worth discouraging.
HEAD_IDLE_TIME_PENALTY_PER_MIN = 4
HEAD_IDLE_GRACE_MINUTES = 150

# Heavy penalty for dropping/skipping a valid POI from the itinerary.
# Ensures the solver maximizes the number of visited places (Prize-Collecting OP).
SKIPPED_POI_PENALTY = 150

# Grace period at the end of the day. If the tour ends up to 2 hours early, 
# it's acceptable. Beyond that, it triggers the tail idle penalty.
TAIL_IDLE_GRACE_MINUTES = 120

# Heavy penalty if the day ends too early (wasting the user's travel day).
TAIL_IDLE_EXCESS_PENALTY_PER_MIN = 12

# ── 3. HUMAN-LIKE BEHAVIOR (BEST TIME WINDOWS) ───────────────────────────
# Defines the ideal active blocks of a human's day.
BEST_TIME_WINDOWS = {
    "MORNING": (7 * 60, 11 * 60 + 30),
    "AFTERNOON": (13 * 60, 17 * 60 + 30),
    "NIGHT": (18 * 60, 22 * 60),
}

# Base penalty if a POI is scheduled slightly outside its "Best Time Window".
BEST_TIME_BASE_PENALTY_PER_MIN = 2

# Heavier penalty if a POI is scheduled far outside its "Best Time Window" 
# (e.g., going to a Night Market at 9:00 AM).
BEST_TIME_LARGE_DEVIATION_PENALTY_PER_MIN = 4

# Allowable buffer (30 mins) before the penalty starts counting.
BEST_TIME_GRACE_MINUTES = 30

# ── 4. SPENDING-TIER / PRICE-FIT — REMOVED 2026-07-12 ────────────────────
# This section used to classify the user's average daily budget into
# low/medium/high and reward/penalize each POI by how well its own price
# tier "matched" that classification (up to -150 for a 2-tier mismatch).
# Removed because the mechanism judged POI price against a generic tier
# derived from the user's budget, instead of against real spend — creating
# a perverse effect where a "high tier" (big-budget) traveler got penalized
# for choosing an affordable local eatery, and a "low tier" traveler got
# penalized for an affordable-but-technically-"premium"-priced pick, even
# though both choices were genuinely fine relative to the user's actual
# entered budget. Real affordability is already tracked precisely by
# budget_penalty below (whole-trip rolling remainder, effectively enforcing
# ~90% of the entered budget via self.trip_budget = trip_budget_total * 0.9)
# — that mechanism doesn't need a coarse tier proxy, and a big-budget
# traveler is already free to pick pricier POIs simply because
# budget_penalty rarely fires for them, without needing an extra bonus for
# doing so. Hotel selection (a separate, budget-aware step upstream in
# recommendation.service.ts, before this solver ever runs) is where
# spending-level personalization for accommodation already happens.


def preferred_time_window(
    poi: planner.POI,
    day_start: int,
    day_end: int,
) -> Optional[Tuple[int, int]]:
    window = BEST_TIME_WINDOWS.get(
        str(getattr(poi, "best_time", "ALL_DAY") or "ALL_DAY").upper()
    )
    if window is None:
        return None
    start = max(day_start, poi.open_time, window[0])
    end = min(day_end, poi.close_time, window[1])
    if start > end:
        return None
    return start, end


def best_time_deviation_minutes(
    poi: planner.POI,
    service_start: int,
    day_start: int,
    day_end: int,
) -> int:
    window = preferred_time_window(poi, day_start, day_end)
    if window is None:
        return 0
    if service_start < window[0]:
        return window[0] - service_start
    if service_start > window[1]:
        return service_start - window[1]
    return 0


# ── Config ──────────────────────────────────────────────────────────────

@dataclass
class SchedulerV2Config:
    places: List[planner.Place]
    num_days: int
    travel_times: Dict[Tuple[str, str], int]
    travel_distances: Dict[Tuple[str, str], float]
    travel_sources: Dict[Tuple[str, str], str]
    travel_reliability: Dict[Tuple[str, str], List[dict]]
    selected_hotel_id: Optional[str]
    hotel_total_cost: float
    day_start_time: int
    day_end_time: int
    return_to_hotel: bool
    require_goong_edges: bool
    trip_budget_total: float
    adult_count: int
    child_count: int
    travel_vehicle: str
    trip_start_date: Optional[str]
    max_solve_seconds_per_day: float = 4.0
    # ── Day-1 fields ──
    check_in_time: Optional[int] = None       # phút từ 0h, giờ check-in ngày 1
    # Region-allocation wizard result: user has already decided how many
    # days each detected geo-region gets (see GeoClusteringAssignment.
    # detect_regions) — force those day-pools instead of re-clustering.
    region_day_allocations: Optional[List[Dict[str, object]]] = None
    # Pool nhà hàng dự phòng quanh điểm đến, KHÔNG lọc theo sở thích/two-tower
    # (api-service: recommendation.service.ts:fetchFallbackRestaurants) —
    # chỉ dùng bởi _ensure_restaurant_coverage() khi 1 ngày sau cluster địa
    # lý bị thiếu ứng viên nhà hàng. Không đưa vào `places` ở trên vì sẽ bị
    # geo_clustering._inject_restaurants() tự chọn nhầm ngay từ đầu, làm mất
    # tác dụng "chỉ dùng khi cần".
    fallback_restaurants: List[planner.Place] = field(default_factory=list)


# ── Planner ─────────────────────────────────────────────────────────────

class SchedulerV2Planner:
    """
    Scheduler v2 — K-Means clustering + CP-SAT day solver.

    Day 1: Half-open path  (virtual start → candidates → hotel)
    Day 2+: Full circuit   (hotel → candidates → hotel)

    Lunch chỉ enforce nếu ngày đó bắt đầu trước 13:30.
    Budget là soft constraint trên trip_budget tổng, linh hoạt giữa các ngày.
    Khi infeasible → fallback chain: relax lunch → bỏ lunch → greedy.
    """

    # CP-SAT không thể CHỨNG MINH infeasible nhanh (đặc biệt với AddCircuit +
    # time-window) — 1 lần solve infeasible có thể ngốp trọn
    # max_solve_seconds_per_day trước khi trả UNKNOWN. Trước đây
    # _solve_day_with_fallback thử TUẦN TỰ từng target_min từ
    # initial_target_min giảm dần về 1 (worst case ~10 lần solve/ngày), rất
    # tốn thời gian cho 1 ngày "khó" (POI thưa/xa nhau khiến target ước lượng
    # ban đầu không khả thi thật). Giới hạn số lần thử — vẫn giữ tinh thần
    # "thử lạc quan trước, hạ dần" nhưng chỉ ở vài mốc rải đều thay vì mọi giá
    # trị nguyên.
    MAX_TARGET_MIN_ATTEMPTS = 3

    @property
    def daily_budget_soft(self) -> float:
        """Per-day soft budget cap, backed by threading.local() so each day
        can solve concurrently (run() dispatches days on a ThreadPoolExecutor)
        without racing on a shared instance attribute — every existing read
        site in the solve chain (_solve_day_core, _greedy_fallback, etc.)
        keeps working unchanged since they all go through this property.
        Lazily creates the threading.local() on first access (via __dict__,
        not a plain attribute check, to avoid recursing through this same
        property) so instances built via __new__() + manual attrs (see test
        helpers) don't need to know about this implementation detail."""
        local = self.__dict__.setdefault("_daily_budget_local", threading.local())
        return getattr(local, "value", 0.0)

    @daily_budget_soft.setter
    def daily_budget_soft(self, value: float) -> None:
        local = self.__dict__.setdefault("_daily_budget_local", threading.local())
        local.value = value

    def __init__(self, config: SchedulerV2Config):
        if cp_model is None:
            raise RuntimeError(
                "OR-Tools is not installed. Install ai-service requirements "
                "before using scheduler_v2."
            )
        if config.num_days < 1:
            raise ValueError("num_days must be >= 1.")

        self.config = config
        self.num_days = config.num_days
        self.region_day_allocations = config.region_day_allocations
        self.places = config.places
        self.fallback_restaurants = config.fallback_restaurants
        self.travel_times = config.travel_times
        self.travel_distances = config.travel_distances or {}
        self.travel_sources = config.travel_sources or {}
        self.travel_reliability = config.travel_reliability or {}
        self.day_start_time = config.day_start_time
        self.day_end_time = config.day_end_time
        self.max_solve_seconds_per_day = max(
            0.5,
            float(config.max_solve_seconds_per_day),
        )
        self.return_to_hotel = config.return_to_hotel
        self.require_goong_edges = config.require_goong_edges
        self.travel_vehicle = (
            config.travel_vehicle
            if config.travel_vehicle in planner.TRANSPORT_COST_PER_KM
            else "car"
        )
        self._base_cost_per_km = planner.TRANSPORT_COST_PER_KM.get(
            self.travel_vehicle, planner.TRANSPORT_COST_DEFAULT
        )

        # ── Candidate rank bookkeeping ──
        total_candidates = max(1, len(self.places))
        for rank, place in enumerate(self.places):
            if place.candidate_total <= 1 and total_candidates > 1:
                place.candidate_rank = rank
                place.candidate_total = total_candidates

        # ── Hotel ──
        hotels = [p for p in self.places if p.place_type == "hotel"]
        if not hotels:
            raise ValueError("No hotels found in places list.")

        self.adult_count = max(1, int(config.adult_count or 1))
        self.child_count = max(0, int(config.child_count or 0))
        self.full_people = self.adult_count + self.child_count
        self.adult_equivalent = self.full_people
        # Fuel cost is per vehicle, not per person: the group needs
        # ceil(headcount / seats_per_vehicle) vehicles, each burning fuel over
        # the same distance, so total transport cost scales by vehicle count.
        capacity = planner.VEHICLE_CAPACITY.get(self.travel_vehicle)
        vehicles = (
            max(1, math.ceil(self.full_people / capacity)) if capacity else 1
        )
        self.cost_per_km = self._base_cost_per_km * vehicles
        self.trip_budget_total = max(0.0, float(config.trip_budget_total or 0))
        self.trip_budget = self.trip_budget_total * 0.9

        if config.selected_hotel_id:
            hotel_place = next(
                (p for p in hotels if p.id == config.selected_hotel_id), None
            )
            if hotel_place is None:
                raise ValueError(
                    f"Hotel '{config.selected_hotel_id}' not found in places list."
                )
        else:
            hotel_place = self._select_hotel(hotels)
        self.hotel_place = hotel_place
        self.hotel = hotel_place.to_hotel()

        # ── Dates ──
        try:
            self.start_date = (
                datetime.date.fromisoformat(config.trip_start_date)
                if config.trip_start_date
                else datetime.date.today()
            )
        except ValueError:
            self.start_date = datetime.date.today()

        # ── Category split ──
        self.attractions = [
            p
            for p in self.places
            if p.place_type in {"attraction", "cafe", "entertainment"}
        ]
        self.restaurants = [
            p for p in self.places if p.place_type == "restaurant"
        ]

        # ── Targets ──
        self.target_pois_per_day = self._target_pois_per_day()
        self.target_nonmeal_per_day = max(1, self.target_pois_per_day - 1)

        # ── Budget: linh hoạt giữa các ngày ──
        self.hotel_total_cost = (
            max(0.0, float(config.hotel_total_cost or 0))
            or self._hotel_total_cost(hotel_place)
        )
        residual_budget = max(0.0, self.trip_budget - self.hotel_total_cost)
        self.trip_residual_budget = residual_budget
        self._daily_budget_local = threading.local()
        self.daily_budget_soft = residual_budget

        # ── Cluster ──
        self.assignment_result = self._preallocate_days()
        self._ensure_restaurant_coverage()

    # Mỗi ngày nên có dư hơn 1 ứng viên nhà hàng — không chỉ đủ cho bữa
    # trưa, mà còn có lựa chọn cho bữa tối nếu lịch tham quan rơi vào
    # khoảng chiều/tối (xem _ensure_restaurant_coverage()).
    MIN_RESTAURANT_CANDIDATES_PER_DAY = 2
    # Bán kính tìm quán ăn dự phòng (km), tăng dần — luôn ưu tiên quán gần
    # trước, chỉ nới rộng ra khi bán kính nhỏ hơn không tìm đủ số lượng cần.
    RESTAURANT_FALLBACK_RADII_KM = (3.0, 7.0, 15.0)
    NO_LUNCH_MESSAGE = (
        "Khu vực này không có quán ăn phù hợp gần lịch trình vì thời gian và "
        "tuyến đường không đủ thuận tiện — bạn có thể ăn nhẹ trên xe."
    )
    # Khác NO_LUNCH_MESSAGE (thiếu ỨNG VIÊN nhà hàng gần đó) — trường hợp này
    # là khung giờ tham quan trong ngày không đủ chỗ cho bữa ăn đúng giờ (bắt
    # đầu trễ hơn giờ ăn trưa, hoặc kết thúc trước giờ ăn tối), dù vùng đó có
    # thể vẫn có quán ăn bình thường.
    MEAL_TIME_UNAVAILABLE_MESSAGE = (
        "Khung giờ tham quan ngày này không đủ để sắp xếp bữa ăn đúng giờ — "
        "bạn có thể tự sắp xếp ăn uống linh hoạt trong ngày."
    )

    def _ensure_restaurant_coverage(self) -> None:
        """Đảm bảo mỗi day_pool có tối thiểu MIN_RESTAURANT_CANDIDATES_PER_DAY
        ứng viên nhà hàng.

        geo_clustering._inject_restaurants() chỉ gán nhà hàng theo sở thích/
        gần nhất — nếu sở thích quá hẹp, có ngày hoàn toàn không có ứng viên
        nào dù vẫn còn quán ăn khác gần đó không khớp sở thích. Bổ sung ở đây
        từ self.fallback_restaurants (pool KHÔNG lọc sở thích — xem
        SchedulerV2Config) theo bán kính tăng dần quanh tâm cụm của ngày,
        trong mỗi mốc bán kính ưu tiên rating cao nhất trước.

        Ngày nào vẫn 0 quán ăn sau khi thử hết mọi bán kính + toàn bộ pool dự
        phòng (khu vực thực sự không có quán ăn nào gần) thì gắn
        `lunch_unavailable_reason` lên chính pool đó — _solve_day_with_fallback
        đọc field này để KHÔNG ép ràng buộc ăn trưa cứng cho ngày đó, và
        response trả về lý do để hiển thị cho người dùng thay vì lịch trình cứ
        thế infeasible.
        """
        used_ids: set[str] = {
            p.id
            for pool in self.assignment_result.day_pools
            for p in (pool.get("restaurants") or [])
        }
        remaining = [p for p in self.fallback_restaurants if p.id not in used_ids]

        for pool in self.assignment_result.day_pools:
            existing = pool.get("restaurants") or []
            need = self.MIN_RESTAURANT_CANDIDATES_PER_DAY - len(existing)
            if need <= 0:
                continue

            centroid = utils.compute_centroid(
                [*(pool.get("attractions") or []), *existing]
            )
            picked: List[planner.Place] = []
            if centroid is not None and remaining:
                anchor = type(
                    "_Centroid", (), {"latitude": centroid[0], "longitude": centroid[1]}
                )()
                for radius_km in self.RESTAURANT_FALLBACK_RADII_KM:
                    in_range = [
                        r
                        for r in remaining
                        if r not in picked
                        and utils.haversine_km_places(anchor, r) <= radius_km
                    ]
                    if not in_range:
                        continue
                    in_range.sort(key=lambda r: -float(r.rating or 0))
                    for r in in_range:
                        if len(picked) >= need:
                            break
                        picked.append(r)
                    if len(picked) >= need:
                        break

            for r in picked:
                pool.setdefault("restaurants", []).append(r)
                remaining.remove(r)

            if len(existing) + len(picked) == 0:
                pool["lunch_unavailable_reason"] = self.NO_LUNCH_MESSAGE

    def _apply_restaurant_constraints(
        self,
        model: cp_model.CpModel,
        pois: List[planner.POI],
        selected: dict,
        start_var: dict,
        scope_tag: str,
        enforce_lunch: bool = False,
        enforce_dinner: bool = False,
    ) -> None:
        """HARD constraints for restaurant selection/timing.

        Mỗi node nhà hàng được gán tối đa 1 trong 2 cờ loại trừ lẫn nhau:
        `lunch_flag` (giờ mở cửa phủ LUNCH_START..LUNCH_END) hoặc
        `dinner_flag` (phủ DINNER_START..DINNER_END) — 1 lần ghé chỉ có thể
        là 1 bữa, dù quán đó mở cả ngày và về lý thuyết đủ điều kiện cho cả
        2 khung giờ. Khi cờ bật, start_var của node đó bị khoá cứng vào đúng
        khung giờ tương ứng — không phải gợi ý/thưởng điểm mềm nữa.

        enforce_lunch/enforce_dinner (đã được _solve_day_with_fallback tính
        toán — tự tắt khi ngày không đủ thời gian hoặc khu vực không có quán
        ăn nào) buộc PHẢI có ít nhất 1 node được gắn đúng cờ tương ứng, nếu
        không model sẽ INFEASIBLE (đúng ý muốn — để
        _solve_day_with_fallback nới lỏng dần thay vì âm thầm bỏ bữa)."""
        restaurant_nodes = [
            idx + 1
            for idx, poi in enumerate(pois)
            if poi.place_type == "restaurant"
        ]
        if not restaurant_nodes:
            return

        model.Add(sum(selected[i] for i in restaurant_nodes) <= 2)

        lunch_flags = []
        dinner_flags = []
        for node in restaurant_nodes:
            poi = pois[node - 1]
            lunch_eligible = (
                poi.open_time <= planner.LUNCH_END
                and poi.close_time >= planner.LUNCH_START
            )
            dinner_eligible = (
                poi.open_time <= DINNER_END and poi.close_time >= DINNER_START
            )

            lunch_flag = None
            if lunch_eligible:
                lunch_flag = model.NewBoolVar(f"{scope_tag}_lunch_{node}")
                model.Add(start_var[node] >= planner.LUNCH_START).OnlyEnforceIf(lunch_flag)
                model.Add(start_var[node] <= planner.LUNCH_END).OnlyEnforceIf(lunch_flag)
                model.AddImplication(lunch_flag, selected[node])
                lunch_flags.append(lunch_flag)

            dinner_flag = None
            if dinner_eligible:
                dinner_flag = model.NewBoolVar(f"{scope_tag}_dinner_{node}")
                model.Add(start_var[node] >= DINNER_START).OnlyEnforceIf(dinner_flag)
                model.Add(start_var[node] <= DINNER_END).OnlyEnforceIf(dinner_flag)
                model.AddImplication(dinner_flag, selected[node])
                dinner_flags.append(dinner_flag)

            if lunch_flag is not None and dinner_flag is not None:
                # Quán mở đủ dài cho cả 2 khung giờ — 1 lần ghé chỉ được
                # TÍNH là 1 trong 2 bữa, không phải cả 2.
                model.Add(lunch_flag + dinner_flag <= 1)

        if enforce_lunch and lunch_flags:
            model.Add(sum(lunch_flags) >= 1)
        if enforce_dinner and dinner_flags:
            model.Add(sum(dinner_flags) >= 1)

        if len(restaurant_nodes) >= 2:
            for left_idx in range(len(restaurant_nodes)):
                for right_idx in range(left_idx + 1, len(restaurant_nodes)):
                    left = restaurant_nodes[left_idx]
                    right = restaurant_nodes[right_idx]
                    pair_selected = model.NewBoolVar(
                        f"{scope_tag}_pair_{left}_{right}"
                    )
                    model.AddBoolAnd([selected[left], selected[right]]).OnlyEnforceIf(
                        pair_selected
                    )
                    model.AddBoolOr(
                        [selected[left].Not(), selected[right].Not(), pair_selected]
                    )
                    left_before_right = model.NewBoolVar(
                        f"{scope_tag}_order_{left}_{right}"
                    )
                    model.Add(
                        start_var[right] >= start_var[left] + MEAL_MIN_GAP_MINUTES
                    ).OnlyEnforceIf([pair_selected, left_before_right])
                    model.Add(
                        start_var[left] >= start_var[right] + MEAL_MIN_GAP_MINUTES
                    ).OnlyEnforceIf([pair_selected, left_before_right.Not()])

    # ────────────────────────────────────────────────────────────────────
    # PUBLIC: run
    # ────────────────────────────────────────────────────────────────────

    def run(self, seed: Optional[int] = None) -> planner.MultiDayResult:
        del seed
        start_day_idx = self.start_date.weekday()

        debug = ClusteringDebugRecorder(f"weekday-match-{self.num_days}days")
        debug.record(
            "6. Trước khi ghép thứ trong tuần (thứ tự pool ban đầu)",
            {
                f"Day {i + 1}": pool.get("attractions", [])
                for i, pool in enumerate(self.assignment_result.day_pools)
            },
            restaurants={
                f"Day {i + 1}": pool.get("restaurants", [])
                for i, pool in enumerate(self.assignment_result.day_pools)
            },
            cafes={
                f"Day {i + 1}": pool.get("cafes", [])
                for i, pool in enumerate(self.assignment_result.day_pools)
            },
            hotel=self.hotel_place,
        )

        # Day-pools so far are ordered however clustering/region-allocation
        # produced them — not by which calendar weekday best suits each
        # pool's POIs. Re-order them (not the POIs inside) so a pool with a
        # weekend-only attraction lands on Sat/Sun, one with a
        # closed-on-Monday spot avoids Monday, etc.
        permutation = match_pools_to_weekdays(
            self.assignment_result.day_pools, start_day_idx
        )
        self.assignment_result.day_pools = [
            self.assignment_result.day_pools[i] for i in permutation
        ]
        if len(self.assignment_result.day_loads) == len(permutation):
            self.assignment_result.day_loads = [
                self.assignment_result.day_loads[i] for i in permutation
            ]

        debug.record(
            "7. Sau khi ghép thứ trong tuần (weekday matching)",
            {
                f"Day {i + 1} ({_WEEKDAY_NAMES_VI[(start_day_idx + i) % 7]})": pool.get("attractions", [])
                for i, pool in enumerate(self.assignment_result.day_pools)
            },
            restaurants={
                f"Day {i + 1} ({_WEEKDAY_NAMES_VI[(start_day_idx + i) % 7]})": pool.get("restaurants", [])
                for i, pool in enumerate(self.assignment_result.day_pools)
            },
            cafes={
                f"Day {i + 1} ({_WEEKDAY_NAMES_VI[(start_day_idx + i) % 7]})": pool.get("cafes", [])
                for i, pool in enumerate(self.assignment_result.day_pools)
            },
            hotel=self.hotel_place,
        )

        # Ngân sách/ngày: chia đều theo số ngày, tính 1 lần trước khi giải —
        # KHÔNG còn kiểu "dồn toa" tuần tự (ngày 1 dùng nguyên ngân sách còn
        # lại, ngày cuối chỉ còn phần dư), vì lúc giải song song không còn
        # biết "các ngày khác đã tiêu bao nhiêu" tại thời điểm giải. Ngân
        # sách vốn là ràng buộc MỀM có chủ đích (xem comment đầu file: hard
        # cap từng bị revert) — bảo đảm thật nằm ở validator.py's
        # budget_exceeded trên TỔNG cả chuyến, không phụ thuộc cách chia
        # soft-budget đầu vào này — nên xấp xỉ đều theo ngày là an toàn.
        per_day_budget = self.trip_residual_budget / max(1, self.num_days)

        def solve_one_day(day_idx: int) -> planner.DayResult:
            # daily_budget_soft là threading.local()-backed property — mỗi
            # thread set giá trị riêng, không race với các ngày khác đang
            # giải đồng thời.
            self.daily_budget_soft = per_day_budget
            pool = self.assignment_result.day_pools[day_idx]
            daily_places = [
                *pool["attractions"], *pool["restaurants"], *pool.get("cafes", [])
            ]
            weekday_idx = (start_day_idx + day_idx) % 7
            day_pois = [
                place.to_poi_for_day(weekday_idx) for place in daily_places
            ]
            if not day_pois:
                return planner.DayResult(
                    day=day_idx + 1,
                    pois=[],
                    ga_result=self._empty_day_result("no_daily_pois"),
                )
            day_result = self._solve_day(day_idx + 1, day_pois)
            # Ưu tiên lý do từ pool (_ensure_restaurant_coverage() — khu vực
            # thực sự không có quán ăn nào) nếu có; _solve_day_with_fallback
            # có thể đã tự set 1 lý do khác (khung giờ ngày không đủ chỗ cho
            # bữa ăn) — KHÔNG ghi đè về rỗng nếu pool không có gì để nói.
            pool_reason = pool.get("lunch_unavailable_reason", "")
            if pool_reason:
                day_result.lunch_unavailable_reason = pool_reason
            return planner.DayResult(
                day=day_idx + 1, pois=day_pois, ga_result=day_result
            )

        # Chạy song song các ngày. CP-SAT's solver.Solve() là lời gọi C++
        # native, nhả GIL khi solve nên threading cho song song thật (không
        # cần ProcessPoolExecutor/pickling). max_workers giới hạn bảo thủ:
        # mỗi ngày đã tự dùng num_search_workers=8 nội bộ, giải quá nhiều
        # ngày cùng lúc sẽ quá tải CPU thay vì tăng tốc.
        max_workers = max(1, min(self.num_days, 4))
        day_results_by_idx: Dict[int, planner.DayResult] = {}
        with ThreadPoolExecutor(max_workers=max_workers) as executor:
            futures = {
                executor.submit(solve_one_day, day_idx): day_idx
                for day_idx in range(self.num_days)
            }
            for future in as_completed(futures):
                day_idx = futures[future]
                day_results_by_idx[day_idx] = future.result()
        day_results: list[planner.DayResult] = [
            day_results_by_idx[day_idx] for day_idx in range(self.num_days)
        ]

        # Đối chiếu sau khi giải xong: day_pools vốn được thiết kế tách biệt
        # theo địa điểm (geo_clustering._inject_restaurants/_inject_cafes đảm
        # bảo 1 nhà hàng/quán chỉ thuộc đúng 1 ngày gần nhất — không còn kiểu
        # "ứng viên cho nhiều ngày"; attraction đến từ clustering cứng nên
        # cũng tách biệt theo cụm), nên trùng lặp ở đây lẽ ra không nên xảy
        # ra — đây chỉ là lưới an toàn rẻ, KHÔNG giải lại khi phát hiện
        # trùng, chỉ bỏ dòng lặp lại (chấp nhận ngày đó thiếu 1 chỗ, giống
        # cách fallback chain hiện tại đã chấp nhận ở nơi khác).
        global_visited: set[str] = set()
        for day_result in day_results:
            kept_entries = []
            duplicates_dropped = 0
            for entry in day_result.ga_result.schedule:
                if entry.is_return_to_hotel or entry.place_type == "hotel":
                    kept_entries.append(entry)
                    continue
                location_id = str(entry.location_id)
                if location_id in global_visited:
                    duplicates_dropped += 1
                    day_result.ga_result.total_activity_cost = max(
                        0.0,
                        day_result.ga_result.total_activity_cost
                        - entry.estimated_cost,
                    )
                    day_result.ga_result.total_day_cost = max(
                        0.0,
                        day_result.ga_result.total_day_cost - entry.estimated_cost,
                    )
                    day_result.ga_result.skipped_count += 1
                    continue
                global_visited.add(location_id)
                kept_entries.append(entry)
            if duplicates_dropped:
                day_result.ga_result.schedule = kept_entries
                self.assignment_result.warnings.append(
                    f"day {day_result.day}: dropped {duplicates_dropped} "
                    "POI(s) already scheduled on an earlier day "
                    "(cross-day dedup after parallel solve)"
                )

        # Final stage: what actually got scheduled after CP-SAT solved each
        # day, as opposed to the pre-solve candidate pools recorded above.
        places_by_id = {str(p.id): p for p in self.places}
        final_attractions: Dict[str, list] = {}
        final_restaurants: Dict[str, list] = {}
        final_cafes: Dict[str, list] = {}
        for day_result in day_results:
            weekday_idx = (start_day_idx + (day_result.day - 1)) % 7
            label = f"Day {day_result.day} ({_WEEKDAY_NAMES_VI[weekday_idx]})"
            attractions_here = []
            restaurants_here = []
            cafes_here = []
            for entry in day_result.ga_result.schedule:
                if entry.is_return_to_hotel or entry.place_type == "hotel":
                    continue
                place = places_by_id.get(str(entry.location_id))
                if place is None:
                    continue
                if entry.place_type == "restaurant":
                    restaurants_here.append(place)
                elif entry.place_type == "cafe":
                    cafes_here.append(place)
                else:
                    attractions_here.append(place)
            final_attractions[label] = attractions_here
            final_restaurants[label] = restaurants_here
            final_cafes[label] = cafes_here

        debug.record(
            "8. Lịch trình hoàn chỉnh (sau khi giải CP-SAT)",
            final_attractions,
            restaurants=final_restaurants,
            cafes=final_cafes,
            hotel=self.hotel_place,
        )
        debug.save()

        return planner.MultiDayResult(
            hotel=self.hotel,
            num_days=self.num_days,
            days=day_results,
            assignment_result=self.assignment_result,
        )

    # ────────────────────────────────────────────────────────────────────
    # DISPATCH
    # ────────────────────────────────────────────────────────────────────

    def _solve_day(
        self, day_number: int, pois: List[planner.POI]
    ) -> planner.GAResult:
        is_day_1 = day_number == 1
        return self._solve_day_with_fallback(day_number, pois, is_day_1)

    def _calculate_target_bounds(
        self,
        candidate_count: int,
        day_start: int,
    ) -> Tuple[int, int]:
        if candidate_count <= 0:
            return 0, 0
        available_minutes = max(1, self.day_end_time - day_start)
        target_max = min(
            candidate_count,
            max(1, self.target_pois_per_day),
        )
        target_by_time = max(2, available_minutes // 150)
        target_min = min(candidate_count, target_max, target_by_time)
        return target_min, target_max

    # ────────────────────────────────────────────────────────────────────
    # FALLBACK CHAIN
    # ────────────────────────────────────────────────────────────────────

    def _solve_day_with_fallback(
        self,
        day_number: int,
        pois: List[planner.POI],
        is_day_1: bool,
    ) -> planner.GAResult:
        """Solve one day while relaxing only constraints that caused failure."""
        # PRE-PRUNING
        pruned_pois = []
        for p in pois:
            if p.open_time >= self.day_end_time or p.close_time <= self.day_start_time:
                continue
            p_cost = getattr(p, "estimated_cost", 0)
            if self.trip_budget_total > 0 and p_cost > self.daily_budget_soft * 1.5:
                total = max(1, p.candidate_total)
                bounded_rank = min(max(p.candidate_rank, 0), total - 1)
                rank_score = 1.0 - (bounded_rank / total)
                rating_score = min(max(p.rating, 0.0), 5.0) / 5.0
                two_tower_score = planner.ALPHA_DEFAULT * rank_score + (1 - planner.ALPHA_DEFAULT) * rating_score
                if two_tower_score <= 0.8:
                    continue
            pruned_pois.append(p)
        pois = pruned_pois
        
        # Ràng buộc cứng cho từng bữa (xem _apply_restaurant_constraints), NHƯNG
        # chỉ áp dụng khi bữa đó còn khả thi trong khung giờ hoạt động của
        # ngày — bắt đầu trễ hơn giờ ăn trưa, hoặc kết thúc trước giờ ăn tối,
        # thì tự tắt cờ tương ứng thay vì để CP-SAT rơi vào infeasible.
        # _ensure_restaurant_coverage() đã xác nhận trước khi vào đây nếu khu
        # vực này hoàn toàn không có ứng viên nhà hàng nào (kể cả sau khi mở
        # rộng tìm kiếm) — trường hợp đó tắt CẢ HAI cờ luôn, không cần xét giờ.
        day_pool_idx = day_number - 1
        no_restaurant_area = bool(
            0 <= day_pool_idx < len(self.assignment_result.day_pools)
            and self.assignment_result.day_pools[day_pool_idx].get(
                "lunch_unavailable_reason"
            )
        )
        day_start = (
            self.config.check_in_time
            if is_day_1 and self.config.check_in_time is not None
            else self.day_start_time
        )
        day_end = self.day_end_time

        if no_restaurant_area:
            enforce_lunch_base = False
            enforce_dinner_base = False
        else:
            enforce_lunch_base = day_start <= LUNCH_ENFORCE_CUTOFF and day_end >= planner.LUNCH_START
            enforce_dinner_base = day_start <= DINNER_END and day_end >= DINNER_START

        lunch_win = LUNCH_HARD_WINDOW
        initial_target_min, _ = self._calculate_target_bounds(
            len(pois),
            day_start,
        )
        if initial_target_min <= 0:
            return self._greedy_fallback(day_number, pois, is_day_1)

        # target_min: chỉ thử 1 vài mốc rải đều (lạc quan → giữa → tối
        # thiểu), không quét hết từng giá trị nguyên — xem MAX_TARGET_MIN_ATTEMPTS.
        step = max(1, initial_target_min // max(1, self.MAX_TARGET_MIN_ATTEMPTS - 1))
        target_attempts = sorted(
            {initial_target_min, 1, *range(initial_target_min, 0, -step)},
            reverse=True,
        )[: self.MAX_TARGET_MIN_ATTEMPTS]

        # Nới lỏng ĐÚNG bữa gây infeasible trước khi rơi về greedy, không nới
        # cả 2 cùng lúc ngay từ đầu. Bữa tối nới trước — thực tế khách có thể
        # tự sắp xếp ăn tối ngoài lịch trình dễ hơn là bỏ bữa trưa giữa ngày
        # tham quan. Chỉ thêm mốc nới lỏng khi bữa đó ĐANG được enforce ở mốc
        # trước — tránh thử lại 1 tổ hợp đã biết chắc giống hệt mốc trước.
        relaxation_levels = [(enforce_lunch_base, enforce_dinner_base)]
        if enforce_dinner_base:
            relaxation_levels.append((enforce_lunch_base, False))
        if enforce_lunch_base:
            relaxation_levels.append((False, False))

        for enforce_lunch, enforce_dinner in relaxation_levels:
            for target_min in target_attempts:
                result = self._solve_day_core(
                    day_number, pois, is_day_1,
                    enforce_lunch=enforce_lunch,
                    enforce_dinner=enforce_dinner,
                    lunch_window=lunch_win,
                    target_min=target_min,
                )
                if result is not None:
                    if no_restaurant_area:
                        result.lunch_unavailable_reason = self.NO_LUNCH_MESSAGE
                    elif not enforce_lunch or not enforce_dinner:
                        result.lunch_unavailable_reason = self.MEAL_TIME_UNAVAILABLE_MESSAGE
                    return result

        return self._greedy_fallback(day_number, pois, is_day_1)

    # ────────────────────────────────────────────────────────────────────
    # CORE CP-SAT SOLVER
    # ────────────────────────────────────────────────────────────────────

    def _solve_day_core(
        self,
        day_number: int,
        pois: List[planner.POI],
        is_day_1: bool,
        enforce_lunch: bool,
        enforce_dinner: bool = False,
        lunch_window: Optional[Tuple[int, int]] = None,
        target_min: Optional[int] = None,
    ) -> Optional[planner.GAResult]:
        """
        Build & solve CP-SAT model.  Returns None if INFEASIBLE.

        Day 1  → half-open path  (virtual start → places → hotel)
        Day 2+ → full circuit    (hotel → places → hotel)
        """
        day_start = self.day_start_time
        if is_day_1 and self.config.check_in_time is not None:
            day_start = self.config.check_in_time

        helper = planner.TSP_TW_GA(
            pois=pois,
            travel_times=self.travel_times,
            travel_distances=self.travel_distances,
            travel_sources=self.travel_sources,
            travel_reliability=self.travel_reliability,
            config=planner.TourConfig(
                start_time=day_start, end_time=self.day_end_time
            ),
            start_location_id=self.hotel.id,
            greedy_fit=True,
            return_to_hotel=self.return_to_hotel,
            require_goong_edges=self.require_goong_edges,
            day_budget=self.daily_budget_soft,
            adult_equivalent=self.adult_equivalent,
            travel_vehicle=self.travel_vehicle,
        )

        if is_day_1:
            return self._build_day1_model(
                pois, helper, day_start, enforce_lunch, enforce_dinner,
                lunch_window, target_min
            )
        return self._build_circuit_model(
            day_number, pois, helper, day_start, enforce_lunch, enforce_dinner,
            lunch_window, target_min
        )

    # ────────────────────────────────────────────────────────────────────
    # DAY 1: HALF-OPEN PATH
    # ────────────────────────────────────────────────────────────────────

    def _build_day1_model(
        self,
        pois: List[planner.POI],
        helper,
        day_start: int,
        enforce_lunch: bool,
        enforce_dinner: bool,
        lunch_window: Optional[Tuple[int, int]],
        target_min: Optional[int],
    ) -> Optional[planner.GAResult]:
        """
        Node layout:
          0       = virtual start (check_in_location hoặc free start)
          1..n    = candidate places
          n+1     = hotel (điểm kết thúc)

        Circuit: vstart → place_a → … → hotel → vstart
        Các place không được chọn có self-loop.
        """
        model = cp_model.CpModel()
        n = len(pois)
        VSTART = 0
        HOTEL = n + 1

        selected = {
            i: model.NewBoolVar(f"sel_{i}") for i in range(1, n + 1)
        }
        arcs: list = []
        arc_vars: dict = {}

        # Self-loops cho các place tùy chọn
        for i in range(1, n + 1):
            arcs.append([i, i, selected[i].Not()])

        # Virtual start → mỗi place
        for j in range(1, n + 1):
            var = model.NewBoolVar(f"vs_to_{j}")
            arc_vars[(VSTART, j)] = var
            arcs.append([VSTART, j, var])

        # Mỗi place → hotel
        for i in range(1, n + 1):
            var = model.NewBoolVar(f"{i}_to_hotel")
            arc_vars[(i, HOTEL)] = var
            arcs.append([i, HOTEL, var])

        # Virtual start → hotel (skip all)
        skip_all = model.NewBoolVar("skip_all")
        arc_vars[(VSTART, HOTEL)] = skip_all
        arcs.append([VSTART, HOTEL, skip_all])

        # Hotel → virtual start (đóng vòng circuit — luôn active)
        close_arc = model.NewBoolVar("close_arc")
        arc_vars[(HOTEL, VSTART)] = close_arc
        arcs.append([HOTEL, VSTART, close_arc])
        model.Add(close_arc == 1)

        # Place → place
        for i in range(1, n + 1):
            targets = [j for j in range(1, n + 1) if i != j]
            if n > 8:
                targets = sorted(
                    targets,
                    key=lambda j: helper._raw_travel(pois[i - 1].id, pois[j - 1].id)
                )[:5]
            for j in targets:
                var = model.NewBoolVar(f"arc_{i}_{j}")
                arc_vars[(i, j)] = var
                arcs.append([i, j, var])

        model.AddCircuit(arcs)

        # ── Time variables ──
        arrival = {
            i: model.NewIntVar(0, 24 * 60, f"arrival_{i}")
            for i in range(1, n + 1)
        }
        start_var = {
            i: model.NewIntVar(0, 24 * 60, f"start_{i}")
            for i in range(1, n + 1)
        }
        depart = {
            i: model.NewIntVar(0, 24 * 60, f"depart_{i}")
            for i in range(1, n + 1)
        }
        return_time = model.NewIntVar(0, 24 * 60, "return_time")

        # ── Travel times ──
        travel_minutes: Dict[Tuple[int, int], int] = {}
        travel_distance: Dict[Tuple[int, int], float] = {}

        for j in range(1, n + 1):
            travel_minutes[(VSTART, j)] = 0
            travel_distance[(VSTART, j)] = 0.0

        for i in range(1, n + 1):
            from_id = pois[i - 1].id
            for j in range(1, n + 1):
                if i != j:
                    to_id = pois[j - 1].id
                    raw = helper._raw_travel(from_id, to_id)
                    buf, _ = helper._travel_buffer(from_id, to_id, raw, None)
                    travel_minutes[(i, j)] = self._round_travel_minutes(raw + buf)
                    travel_distance[(i, j)] = helper._distance(from_id, to_id)
            # place → hotel
            raw = helper._raw_travel(from_id, self.hotel.id)
            buf, _ = helper._travel_buffer(from_id, self.hotel.id, raw, None)
            travel_minutes[(i, HOTEL)] = self._round_travel_minutes(raw + buf)
            travel_distance[(i, HOTEL)] = helper._distance(
                from_id, self.hotel.id
            )

        # ── Time constraints ──
        for j in range(1, n + 1):
            poi = pois[j - 1]
            # Keep the timeline continuous. A selected POI must be reachable
            # exactly when its visit starts; no implicit waiting is inserted.
            model.Add(
                start_var[j] == arrival[j]
            ).OnlyEnforceIf(selected[j])
            model.Add(
                depart[j] == start_var[j] + max(0, int(poi.visit_duration))
            ).OnlyEnforceIf(selected[j])
            model.Add(
                start_var[j] >= max(day_start, int(poi.open_time))
            ).OnlyEnforceIf(selected[j])
            model.Add(
                depart[j] <= min(self.day_end_time, int(poi.close_time))
            ).OnlyEnforceIf(selected[j])

        # ── Arc time propagation ──
        for (i, j), var in arc_vars.items():
            if i == VSTART and 1 <= j <= n:
                model.Add(
                    arrival[j] == day_start + travel_minutes[(VSTART, j)]
                ).OnlyEnforceIf(var)
            elif 1 <= i <= n and j == HOTEL:
                model.Add(
                    return_time == depart[i] + travel_minutes[(i, HOTEL)]
                ).OnlyEnforceIf(var)
            elif 1 <= i <= n and 1 <= j <= n:
                model.Add(
                    arrival[j] == depart[i]
                    + travel_minutes.get((i, j), 30)
                ).OnlyEnforceIf(var)

        model.Add(return_time <= self.day_end_time)

        # ── Restaurant constraint ──
        self._apply_restaurant_constraints(
            model,
            pois,
            selected,
            start_var,
            "day1",
            enforce_lunch=enforce_lunch,
            enforce_dinner=enforce_dinner,
        )
        cafe_nodes = [
            i for i in range(1, n + 1) if pois[i - 1].place_type == "cafe"
        ]
        if cafe_nodes:
            model.Add(sum(selected[i] for i in cafe_nodes) <= MAX_CAFE_OPTIONS_PER_DAY)

        # ── Max/Min POIs ──
        dynamic_target_min, target_max = self._calculate_target_bounds(
            n,
            day_start,
        )
        effective_target_min = (
            dynamic_target_min if target_min is None else target_min
        )
        effective_target_min = min(target_max, max(1, effective_target_min))
        model.Add(sum(selected.values()) <= target_max)
        model.Add(sum(selected.values()) >= effective_target_min)

        # ── Objective ──
        self._add_objective(
            model, n, pois, selected, start_var,
            arc_vars, travel_minutes, travel_distance, helper,
            return_time=return_time,
            day_start=day_start,
        )

        # ── Solve ──
        solver = cp_model.CpSolver()
        solver.parameters.max_time_in_seconds = self.max_solve_seconds_per_day
        solver.parameters.num_search_workers = 8
        status = solver.Solve(model)
        if status not in (cp_model.OPTIMAL, cp_model.FEASIBLE):
            return None

        route_nodes = self._extract_path_nodes(n, VSTART, HOTEL, arc_vars, solver)
        # Lunch is a soft objective term now (see _add_objective), not a hard
        # constraint, so the solve can legitimately return zero restaurants
        # or a late one. Tag stopped_reason from the *actual* solved route
        # (not a requested flag) so the validator's missing_lunch check and
        # the mobile 4-layer day-quality banner keep reading the truth.
        has_restaurant = False
        lunch_late = False
        for nd in route_nodes:
            poi = pois[nd - 1]
            if poi.place_type != "restaurant":
                continue
            has_restaurant = True
            if enforce_lunch and lunch_window:
                started = solver.Value(start_var[nd])
                is_dinner_time = DINNER_START <= started <= DINNER_END
                if not is_dinner_time and (
                    started < lunch_window[0] or started > lunch_window[1]
                ):
                    lunch_late = True
        reason = (
            "cpsat_optimal" if status == cp_model.OPTIMAL else "cpsat_feasible"
        )
        if not has_restaurant:
            reason += "_no_lunch"
        elif lunch_late:
            reason += "_lunch_relaxed"

        return self._build_result_from_route(
            pois=pois,
            helper=helper,
            route_nodes=route_nodes,
            selected_indices=[nd - 1 for nd in route_nodes],
            arrival=arrival,
            start=start_var,
            depart=depart,
            solver=solver,
            stopped_reason=reason,
            lunch_skipped=not has_restaurant,
        )

    # ────────────────────────────────────────────────────────────────────
    # DAY 2+: FULL CIRCUIT
    # ────────────────────────────────────────────────────────────────────

    def _build_circuit_model(
        self,
        day_number: int,
        pois: List[planner.POI],
        helper,
        day_start: int,
        enforce_lunch: bool,
        enforce_dinner: bool,
        lunch_window: Optional[Tuple[int, int]],
        target_min: Optional[int],
    ) -> Optional[planner.GAResult]:
        """
        Node layout:
          0       = hotel (depot)
          1..n    = candidate places
        """
        model = cp_model.CpModel()
        n = len(pois)

        selected = {
            i: model.NewBoolVar(f"sel_{i}") for i in range(1, n + 1)
        }
        arcs: list = []
        arc_vars: dict = {}

        for i in range(0, n + 1):
            targets = [j for j in range(0, n + 1)]
            if n > 8 and i != 0:
                nearest = sorted(
                    [j for j in range(1, n + 1) if i != j],
                    key=lambda j: helper._raw_travel(pois[i - 1].id, pois[j - 1].id)
                )[:5]
                targets = [i, 0] + nearest
                
            for j in targets:
                if i == j:
                    if i == 0:
                        continue  # hotel luôn nằm trong circuit
                    arcs.append([i, i, selected[i].Not()])
                    continue
                var = model.NewBoolVar(f"arc_{i}_{j}")
                arc_vars[(i, j)] = var
                arcs.append([i, j, var])
        model.AddCircuit(arcs)

        # ── Time variables ──
        arrival = {
            i: model.NewIntVar(0, 24 * 60, f"arrival_{i}")
            for i in range(1, n + 1)
        }
        start_var = {
            i: model.NewIntVar(0, 24 * 60, f"start_{i}")
            for i in range(1, n + 1)
        }
        depart = {
            i: model.NewIntVar(0, 24 * 60, f"depart_{i}")
            for i in range(1, n + 1)
        }
        return_time = model.NewIntVar(0, 24 * 60, "return_time")

        # ── Travel times ──
        travel_minutes: Dict[Tuple[int, int], int] = {}
        travel_distance: Dict[Tuple[int, int], float] = {}
        for i in range(0, n + 1):
            from_id = self.hotel.id if i == 0 else pois[i - 1].id
            for j in range(0, n + 1):
                if i == j:
                    continue
                to_id = self.hotel.id if j == 0 else pois[j - 1].id
                raw = helper._raw_travel(from_id, to_id)
                buf, _ = helper._travel_buffer(from_id, to_id, raw, None)
                travel_minutes[(i, j)] = self._round_travel_minutes(raw + buf)
                travel_distance[(i, j)] = helper._distance(from_id, to_id)

        # ── Time constraints ──
        for j in range(1, n + 1):
            poi = pois[j - 1]
            # Keep the timeline continuous. Opening and meal windows must be
            # satisfied through route selection/order rather than waiting.
            model.Add(
                start_var[j] == arrival[j]
            ).OnlyEnforceIf(selected[j])
            model.Add(
                depart[j] == start_var[j] + max(0, int(poi.visit_duration))
            ).OnlyEnforceIf(selected[j])
            model.Add(
                start_var[j] >= max(day_start, int(poi.open_time))
            ).OnlyEnforceIf(selected[j])
            model.Add(
                depart[j] <= min(self.day_end_time, int(poi.close_time))
            ).OnlyEnforceIf(selected[j])

        # ── Arc time propagation ──
        for (i, j), var in arc_vars.items():
            travel = travel_minutes[(i, j)]
            if i == 0 and j != 0:
                model.Add(
                    arrival[j] == day_start + travel
                ).OnlyEnforceIf(var)
            elif i != 0 and j == 0:
                model.Add(
                    return_time == depart[i] + travel
                ).OnlyEnforceIf(var)
            elif i != 0 and j != 0:
                model.Add(
                    arrival[j] == depart[i] + travel
                ).OnlyEnforceIf(var)

        model.Add(return_time <= self.day_end_time)

        # ── Restaurant constraint ──
        self._apply_restaurant_constraints(
            model,
            pois,
            selected,
            start_var,
            "day1",
            enforce_lunch=enforce_lunch,
            enforce_dinner=enforce_dinner,
        )
        cafe_nodes = [
            i for i in range(1, n + 1) if pois[i - 1].place_type == "cafe"
        ]
        if cafe_nodes:
            model.Add(sum(selected[i] for i in cafe_nodes) <= MAX_CAFE_OPTIONS_PER_DAY)

        # ── Max/Min POIs ──
        dynamic_target_min, target_max = self._calculate_target_bounds(
            n,
            day_start,
        )
        effective_target_min = (
            dynamic_target_min if target_min is None else target_min
        )
        effective_target_min = min(target_max, max(1, effective_target_min))
        model.Add(sum(selected.values()) <= target_max)
        model.Add(sum(selected.values()) >= effective_target_min)

        # ── Objective ──
        self._add_objective(
            model, n, pois, selected, start_var,
            arc_vars, travel_minutes, travel_distance, helper,
            return_time=return_time,
            day_start=day_start,
        )

        # ── Solve ──
        solver = cp_model.CpSolver()
        solver.parameters.max_time_in_seconds = self.max_solve_seconds_per_day
        solver.parameters.num_search_workers = 8
        status = solver.Solve(model)
        if status not in (cp_model.OPTIMAL, cp_model.FEASIBLE):
            return None

        route_nodes = self._extract_route_nodes(n, arc_vars, solver)
        # See the matching comment in _build_day1_model: lunch is a soft
        # objective term now, so tag stopped_reason from the actual solved
        # route rather than a requested flag.
        has_restaurant = False
        lunch_late = False
        for nd in route_nodes:
            poi = pois[nd - 1]
            if poi.place_type != "restaurant":
                continue
            has_restaurant = True
            if enforce_lunch and lunch_window:
                started = solver.Value(start_var[nd])
                is_dinner_time = DINNER_START <= started <= DINNER_END
                if not is_dinner_time and (
                    started < lunch_window[0] or started > lunch_window[1]
                ):
                    lunch_late = True
        reason = (
            "cpsat_optimal" if status == cp_model.OPTIMAL else "cpsat_feasible"
        )
        if not has_restaurant:
            reason += "_no_lunch"
        elif lunch_late:
            reason += "_lunch_relaxed"

        return self._build_result_from_route(
            pois=pois,
            helper=helper,
            route_nodes=route_nodes,
            selected_indices=[nd - 1 for nd in route_nodes],
            arrival=arrival,
            start=start_var,
            depart=depart,
            solver=solver,
            stopped_reason=reason,
            lunch_skipped=not has_restaurant,
        )

    # ────────────────────────────────────────────────────────────────────
    # OBJECTIVE (shared Day 1 & Day 2+)
    # ────────────────────────────────────────────────────────────────────

    def _add_objective(
        self,
        model,
        n: int,
        pois: List[planner.POI],
        selected: dict,
        start_var: dict,
        arc_vars: dict,
        travel_minutes: dict,
        travel_distance: dict,
        helper,
        return_time,
        day_start: int = None,
    ) -> None:
        effective_day_start = day_start if day_start is not None else self.day_start_time

        utility_terms = []
        travel_terms = []
        skipped_terms = []
        activity_cost_terms = []
        best_time_penalty_terms = []

        for i, poi in enumerate(pois, start=1):
            poi_cost = helper._poi_cost(poi)
            two_tower_score = helper._poi_utility(poi) / planner.UTILITY_SCALE

            # Same "unlimited budget" exemption used elsewhere in this file
            # (e.g. budget_k_overage below) — this is a budget-agnostic
            # "costlier POI = slightly lower reward" nudge, but "unlimited"
            # means cost shouldn't factor into the choice at all.
            cost_penalty = int(poi_cost // 10000) if self.trip_budget_total > 0 else 0
            # One uniform utility scale for every place type. A per-type
            # discount for restaurant/cafe used to exist here (300x/220x vs
            # 1000x for attractions) to bias trimming toward keeping
            # attractions over food — but restaurant/cafe candidates are
            # already greedily pre-filtered by distance to at most
            # restaurant_option_limit/cafe_option_limit per day BEFORE this
            # solver ever runs (see geo_clustering.py's _inject_restaurants/
            # _inject_cafes), so there's rarely more than 1-2 food candidates
            # to rank against each other in the first place — the per-type
            # discount's only real effect was cross-type trimming, which
            # needed 3 separate hand-tuned numbers to reason about. Within-
            # type ranking is unaffected by removing it: two_tower_score
            # already differs per POI regardless of the multiplier applied.
            poi_reward = int(round(two_tower_score * 1000))
            stay_penalty = int(poi.visit_duration)
            # lunch_bonus/dinner_bonus removed: chọn quán ăn giờ là ràng buộc
            # CỨNG (xem _apply_restaurant_constraints), không cần thưởng điểm
            # mềm để "khuyến khích" 1 việc đã bắt buộc.
            effective_reward = poi_reward - cost_penalty - stay_penalty

            utility_terms.append(effective_reward * selected[i])
            skipped_terms.append(SKIPPED_POI_PENALTY * selected[i].Not())
            activity_cost_terms.append(int(round(poi_cost)) * selected[i])

            preferred_window = preferred_time_window(
                poi,
                effective_day_start,
                self.day_end_time,
            )
            if preferred_window is not None:
                early = model.NewIntVar(0, 24 * 60, f"best_time_early_{i}")
                late = model.NewIntVar(0, 24 * 60, f"best_time_late_{i}")
                model.Add(early >= preferred_window[0] - start_var[i]).OnlyEnforceIf(
                    selected[i]
                )
                model.Add(late >= start_var[i] - preferred_window[1]).OnlyEnforceIf(
                    selected[i]
                )
                model.Add(early == 0).OnlyEnforceIf(selected[i].Not())
                model.Add(late == 0).OnlyEnforceIf(selected[i].Not())
                large_early = model.NewIntVar(
                    0, 24 * 60, f"best_time_large_early_{i}"
                )
                large_late = model.NewIntVar(
                    0, 24 * 60, f"best_time_large_late_{i}"
                )
                model.Add(large_early >= early - BEST_TIME_GRACE_MINUTES)
                model.Add(large_late >= late - BEST_TIME_GRACE_MINUTES)
                best_time_penalty_terms.append(
                    (early + late) * BEST_TIME_BASE_PENALTY_PER_MIN
                    + (large_early + large_late)
                    * BEST_TIME_LARGE_DEVIATION_PENALTY_PER_MIN
                )

        # HISTORY: a keyword-matched "late-night entertainment" penalty
        # (karaoke/bar/pub/club/cinema/billiards/game/escape/bowling)
        # pushing those POIs no earlier than 13:00 (or 18:00 for the late-
        # night subset) used to run here, as a fallback for entertainment-
        # type POIs missing a proper best_time tag (best_time_penalty_terms
        # only fires when a tag exists). Removed 2026-07-12: those specific
        # late-night venue types have been dropped from the entertainment
        # category at the data-curation layer — what remains under
        # "entertainment" (theme parks etc.) is normal daytime-appropriate
        # content needing no morning restriction. If late-night venue types
        # are reintroduced later, re-add a best_time-tag-based safeguard
        # rather than reviving this keyword-matching mechanism.

        # Khoá giờ nhà hàng (lunch/dinner window) giờ nằm trực tiếp trong
        # _apply_restaurant_constraints's lunch_flag/dinner_flag — không cần
        # 1 block "blanket rule" riêng ở đây nữa (trước đây phải né dinner_flag
        # thủ công để không tạo mâu thuẫn, xem lịch sử qua git blame nếu cần).

        for (i, j), var in arc_vars.items():
            tm = travel_minutes.get((i, j), 0)
            travel_terms.append(tm * 2 * var)

        # ── Budget: soft penalty in 1k-VND units ──
        budget_unit = planner.BUDGET_OVERAGE_UNIT_VND
        daily_budget_k = max(0, int(self.daily_budget_soft) // budget_unit)

        activity_cost_k = sum(
            (int(round(helper._poi_cost(pois[i - 1]))) // budget_unit) * selected[i]
            for i in range(1, n + 1)
        )
        # Use the same route arcs as the CP-SAT circuit/path. The previous
        # hotel-to-each-selected-POI approximation could disagree materially
        # with the final route cost reported after solving.
        transport_cost_k = sum(
            (
                int(
                    round(
                        max(0.0, float(travel_distance.get((i, j), 0.0)))
                        * self.cost_per_km
                    )
                )
                // budget_unit
            )
            * var
            for (i, j), var in arc_vars.items()
        )

        # Soft, not hard: a day-level cap here would force greedy_fallback
        # (weaker budget discipline, no route optimality) whenever a single
        # day's tight budget+time combination is infeasible — even though
        # daily_budget_soft is only a rolling remainder of the whole trip's
        # budget, so a modest overage on one day can still leave the overall
        # trip within budget (slack borrowed from days that underspend).
        # The real hard guarantee is validator.py's trip-level
        # budget_exceeded check against the user's total budget; this term
        # just steers the solver away from overspending when it can.
        budget_k_overage = model.NewIntVar(0, 2_000_000, "budget_k_overage")
        if self.trip_budget_total > 0:
            model.Add(budget_k_overage >= activity_cost_k + transport_cost_k - daily_budget_k)
        else:
            model.Add(budget_k_overage == 0)

        # Same weight used for the reported GAResult.budget_penalty
        # (_build_result_from_route/_greedy_fallback) — one documented
        # constant instead of two silently-different multipliers. CP-SAT
        # linear expressions need an integer coefficient; the constant is
        # already a whole number (15.0), so this cast loses nothing.
        budget_penalty = budget_k_overage * int(planner.BUDGET_PENALTY_WEIGHT)

        # ── Day-density penalty — REMOVED 2026-07-12 ──
        # HISTORY: this section originally carried THREE overlapping soft
        # mechanisms answering "is today's POI count reasonable?", later
        # consolidated down to just density_penalty_term (target =
        # available_minutes/150 per POI, penalty = |selected - target| * 200
        # either direction). Removed entirely in this pass: target_min/
        # target_max (the HARD band from _calculate_target_bounds) turned out
        # to reuse the exact same 150-min-per-POI slice as target_by_time (one
        # of target_min's three inputs) — not a separate, spatially-derived
        # bound from geo_clustering.py as it looked at a glance, just the same
        # time-based heuristic duplicated in both a hard and a soft form.
        # Worse than merely redundant: density_penalty_term's soft target sat
        # near target_min (the low end of the hard band), actively pulling
        # selected_total back down against skipped_terms/utility_terms, which
        # pull toward target_max — two soft mechanisms fighting each other
        # inside the same already-hard-bounded range. selected_total is now
        # left free within [target_min, target_max] for utility_terms/
        # skipped_terms to decide alone. Re-verified via
        # scripts/sensitivity_analysis_weights.py (day + trip mode) after
        # removal — see scripts/sensitivity_results_trip.csv for the
        # before/after comparison this change should be checked against.

        # HISTORY: a separate "distance penalty" (0.1-km units, thresholds at
        # 60/80/100km) used to live here, on top of travel_terms (linear,
        # always-on, per minute) and travel_penalty_term below (tiered, per
        # total minutes). Distance and travel time correlate but aren't
        # identical (traffic, road grade) — in principle a separate lever —
        # but in practice all three pulled the same direction ("discourage a
        # far-flung day"), just measured two different ways (km vs minutes),
        # making the trio hard to reason about together and none of them
        # covered by the sensitivity study (all magic numbers inline here,
        # not named module constants). Minutes already capture what actually
        # matters to the traveler (time stuck traveling); a separate km-based
        # penalty added no distinguishable signal budget_penalty's own
        # per-km transport cost doesn't already price in. Removed 2026-07-12.
        #
        # ── Travel-time penalty ──
        raw_travel_terms = [
            travel_minutes.get((i, j), 0) * var
            for (i, j), var in arc_vars.items()
        ]
        total_travel_var = model.NewIntVar(0, 24 * 60, "total_travel_var")
        model.Add(total_travel_var == sum(raw_travel_terms))

        # >180 min: +5/min; >240 min: +10/min additional; >300 min: +2000 flat
        travel_over_180 = model.NewIntVar(0, 1440, "travel_over_180")
        model.Add(travel_over_180 >= total_travel_var - 180)
        travel_over_240 = model.NewIntVar(0, 1440, "travel_over_240")
        model.Add(travel_over_240 >= total_travel_var - 240)
        is_extreme_travel = model.NewBoolVar("is_extreme_travel")
        model.Add(total_travel_var > 300).OnlyEnforceIf(is_extreme_travel)
        model.Add(total_travel_var <= 300).OnlyEnforceIf(is_extreme_travel.Not())

        travel_penalty_term = (
            travel_over_180 * 5
            + travel_over_240 * 10
            + is_extreme_travel * 2000
        )

        # HISTORY: an always-on linear penalty (idle_tail * 9, no grace
        # period) used to run alongside the grace-then-penalty term below —
        # taxing even a few idle minutes at the end of the day on top of the
        # steeper penalty for genuinely wasted time past a 2-hour grace.
        # Consolidated into just the grace-then-penalty form: a short idle
        # tail (<=TAIL_IDLE_GRACE_MINUTES) is normal schedule slack, not
        # something to penalize from minute one. Removed 2026-07-12 — see
        # ai-service/tests/test_scheduler_v2_density_fallback.py and
        # scripts/sensitivity_analysis_weights.py for the matching cleanup
        # of the now-unused IDLE_TIME_PENALTY_PER_MIN constant/sweep entry.
        idle_tail = model.NewIntVar(0, 24 * 60, "idle_tail")
        model.Add(idle_tail == self.day_end_time - return_time)
        idle_tail_excess = model.NewIntVar(0, 24 * 60, "idle_tail_excess")
        model.Add(
            idle_tail_excess >= idle_tail - TAIL_IDLE_GRACE_MINUTES
        )
        idle_excess_penalty_term = (
            idle_tail_excess * TAIL_IDLE_EXCESS_PENALTY_PER_MIN
        )

        # Penalize an unnecessarily late first stop, beyond a grace period.
        # Previously only the idle tail was penalized, so a route could
        # start at lunch and still finish late enough to look attractive to
        # the objective. A small amount of head idle is normal schedule
        # slack (e.g. deferring to a POI's best-time window), so — mirroring
        # TAIL_IDLE_GRACE_MINUTES on the other end of the day — only the
        # portion past HEAD_IDLE_GRACE_MINUTES is penalized.
        head_idle_terms = []
        for (i, j), arc in arc_vars.items():
            if i not in (0, -1) or not (1 <= j <= n):
                continue
            head_idle = model.NewIntVar(0, 24 * 60, f"head_idle_{j}")
            model.Add(
                head_idle
                >= start_var[j]
                - effective_day_start
                - travel_minutes.get((i, j), 0)
            ).OnlyEnforceIf(arc)
            model.Add(head_idle == 0).OnlyEnforceIf(arc.Not())
            head_idle_excess = model.NewIntVar(0, 24 * 60, f"head_idle_excess_{j}")
            model.Add(
                head_idle_excess >= head_idle - HEAD_IDLE_GRACE_MINUTES
            ).OnlyEnforceIf(arc)
            model.Add(head_idle_excess == 0).OnlyEnforceIf(arc.Not())
            head_idle_terms.append(head_idle_excess * HEAD_IDLE_TIME_PENALTY_PER_MIN)

        model.Minimize(
            sum(travel_terms)
            + sum(best_time_penalty_terms)
            + budget_penalty
            + sum(skipped_terms)
            - sum(utility_terms)
            + travel_penalty_term
            + idle_excess_penalty_term
            + sum(head_idle_terms)
        )

    # ────────────────────────────────────────────────────────────────────
    # ROUTE EXTRACTION
    # ────────────────────────────────────────────────────────────────────

    def _extract_route_nodes(
        self, n: int, arc_vars: dict, solver
    ) -> List[int]:
        """Extract route for Full Circuit (node 0 = hotel)."""
        next_by_node: dict[int, int] = {}
        for (i, j), var in arc_vars.items():
            if solver.BooleanValue(var):
                next_by_node[i] = j
        route: list[int] = []
        current = next_by_node.get(0, 0)
        guard = 0
        while current != 0 and guard <= n:
            route.append(current)
            current = next_by_node.get(current, 0)
            guard += 1
        return route

    def _extract_path_nodes(
        self,
        n: int,
        vstart: int,
        hotel: int,
        arc_vars: dict,
        solver,
    ) -> List[int]:
        """Extract route for Half-open Path (vstart → places → hotel)."""
        next_by_node: dict[int, int] = {}
        for (i, j), var in arc_vars.items():
            if solver.BooleanValue(var):
                next_by_node[i] = j
        route: list[int] = []
        current = next_by_node.get(vstart, hotel)
        guard = 0
        while current != hotel and current != vstart and guard <= n:
            route.append(current)
            current = next_by_node.get(current, hotel)
            guard += 1
        return route

    # ────────────────────────────────────────────────────────────────────
    # BUILD RESULT
    # ────────────────────────────────────────────────────────────────────

    def _build_result_from_route(
        self,
        pois: List[planner.POI],
        helper: planner.TSP_TW_GA,
        route_nodes: List[int],
        selected_indices: List[int],
        arrival: dict,
        start: dict,
        depart: dict,
        solver,
        stopped_reason: str,
        lunch_skipped: bool = False,
    ) -> planner.GAResult:
        schedule: List[planner.ScheduleEntry] = []
        current_id = self.hotel.id
        current_name = self.hotel.name
        total_travel = 0
        total_distance = 0.0
        total_visit = 0
        total_wait = 0
        total_utility = 0.0
        total_activity_cost = 0.0
        restaurant_count = 0

        for node in route_nodes:
            poi = pois[node - 1]
            raw = helper._raw_travel(current_id, poi.id)
            buffer, buffer_source = helper._travel_buffer(
                current_id, poi.id, raw, None
            )
            travel = self._round_travel_minutes(raw + buffer)
            buffer = max(0, travel - raw)
            distance = helper._distance(current_id, poi.id)
            wait_minutes = max(
                0, solver.Value(start[node]) - solver.Value(arrival[node])
            )
            poi_cost = helper._poi_cost(poi)
            schedule.append(
                planner.ScheduleEntry(
                    poi.id,
                    poi.name,
                    current_id,
                    current_name,
                    travel,
                    raw,
                    buffer,
                    buffer_source,
                    distance,
                    helper._travel_source(current_id, poi.id),
                    solver.Value(arrival[node]),
                    solver.Value(depart[node]),
                    wait_minutes,
                    poi.place_type == "restaurant",
                    poi.unknown_hours,
                    place_type=poi.place_type,
                    base_duration=poi.visit_duration,
                    estimated_cost=poi_cost,
                    price_basis=poi.price_basis,
                    price_inferred=poi.price_inferred,
                    best_time=poi.best_time,
                    best_time_source=poi.best_time_source,
                    best_time_applicable=preferred_time_window(
                        poi, self.day_start_time, self.day_end_time
                    )
                    is not None,
                    two_tower_score=helper._poi_utility(poi) / planner.UTILITY_SCALE,
                )
            )
            total_travel += travel
            total_distance += distance
            total_visit += poi.visit_duration
            total_wait += wait_minutes
            total_activity_cost += poi_cost
            total_utility += helper._poi_utility(poi)
            restaurant_count += 1 if poi.place_type == "restaurant" else 0
            current_id = poi.id
            current_name = poi.name

        # Return to hotel
        if (
            self.return_to_hotel
            and schedule
            and current_id != self.hotel.id
        ):
            raw = helper._raw_travel(current_id, self.hotel.id)
            buffer, buffer_source = helper._travel_buffer(
                current_id, self.hotel.id, raw, None
            )
            travel = self._round_travel_minutes(raw + buffer)
            buffer = max(0, travel - raw)
            distance = helper._distance(current_id, self.hotel.id)
            arrival_time = schedule[-1].departure_time + travel
            schedule.append(
                planner.ScheduleEntry(
                    self.hotel.id,
                    self.hotel.name,
                    current_id,
                    current_name,
                    travel,
                    raw,
                    buffer,
                    buffer_source,
                    distance,
                    helper._travel_source(current_id, self.hotel.id),
                    arrival_time,
                    arrival_time,
                    0,
                    False,
                    False,
                    True,
                    place_type="hotel",
                )
            )
            total_travel += travel
            total_distance += distance

        total_transport_cost = total_distance * self.cost_per_km
        total_day_cost = total_activity_cost + total_transport_cost
        budget_overage = (
            max(0.0, total_day_cost - self.daily_budget_soft)
            if self.trip_budget_total > 0
            else 0.0
        )
        budget_penalty = (
            (budget_overage / planner.BUDGET_OVERAGE_UNIT_VND)
            * planner.BUDGET_PENALTY_WEIGHT
        )
        actual_time = total_travel + total_visit + total_wait
        idle_time = max(
            0, (self.day_end_time - self.day_start_time) - actual_time
        )
        meal_violations = 0
        if not lunch_skipped:
            meal_violations = (
                1
                if any(p.place_type == "restaurant" for p in pois)
                and restaurant_count == 0
                else 0
            )
        penalty = planner.FEASIBILITY_PENALTY if meal_violations else 0
        fitness = (
            penalty
            + planner.UTILITY_TRAVEL_WEIGHT * total_travel
            + planner.WAIT_TIME_WEIGHT * total_wait
            + budget_penalty
            - total_utility
        )
        return planner.GAResult(
            best_chromosome=selected_indices,
            schedule=schedule,
            fitness=fitness,
            cost=fitness,
            total_travel_time=total_travel,
            total_distance_km=total_distance,
            total_visit_time=total_visit,
            total_wait_time=total_wait,
            total_penalty=penalty,
            total_hard_violations=meal_violations,
            meal_violations=meal_violations,
            restaurant_count=restaurant_count,
            total_activity_cost=total_activity_cost,
            total_transport_cost=total_transport_cost,
            total_day_cost=total_day_cost,
            budget_limit=self.daily_budget_soft,
            budget_overage=budget_overage,
            budget_penalty=budget_penalty,
            skipped_count=max(0, len(pois) - len(selected_indices)),
            idle_time=idle_time,
            generation_found=0,
            generations_run=1,
            stopped_reason=stopped_reason,
            visited_poi_indices=selected_indices,
        )

    # ────────────────────────────────────────────────────────────────────
    # GREEDY FALLBACK
    # ────────────────────────────────────────────────────────────────────

    def _greedy_fallback(
        self,
        day_number: int,
        pois: List[planner.POI],
        is_day_1: bool,
    ) -> planner.GAResult:
        """
        Fallback cuối: chọn POI theo candidate_rank (thấp = tốt),
        fit vào timeline tuyến tính, bỏ qua budget.
        """
        day_start = self.day_start_time
        if is_day_1 and self.config.check_in_time is not None:
            day_start = self.config.check_in_time

        helper = planner.TSP_TW_GA(
            pois=pois,
            travel_times=self.travel_times,
            travel_distances=self.travel_distances,
            travel_sources=self.travel_sources,
            travel_reliability=self.travel_reliability,
            config=planner.TourConfig(
                start_time=day_start, end_time=self.day_end_time
            ),
            start_location_id=self.hotel.id,
            greedy_fit=True,
            return_to_hotel=self.return_to_hotel,
            require_goong_edges=self.require_goong_edges,
            day_budget=self.daily_budget_soft,
            adult_equivalent=self.adult_equivalent,
            travel_vehicle=self.travel_vehicle,
        )

        # Restaurants xếp sau attractions để buổi sáng luôn dành cho tham quan,
        # tránh tình huống greedy ghé restaurant đầu tiên lúc 7:00 → chờ đến 11:30 (wait ~4.5h).
        sorted_pois = sorted(
            enumerate(pois),
            key=lambda x: (
                1 if x[1].place_type == "restaurant" else 0,
                (
                    preferred_time_window(x[1], day_start, self.day_end_time)
                    or (day_start, self.day_end_time)
                )[0],
                x[1].candidate_rank,
            ),
        )

        schedule: List[planner.ScheduleEntry] = []
        current_time = day_start
        current_id = self.hotel.id
        current_name = self.hotel.name
        total_travel = 0
        total_distance = 0.0
        total_visit = 0
        total_wait = 0
        total_activity_cost = 0.0
        total_utility = 0.0
        restaurant_count = 0
        restaurant_starts: list[int] = []
        selected_indices: list[int] = []

        for idx, poi in sorted_pois:
            raw = helper._raw_travel(current_id, poi.id)
            buf, buffer_source = helper._travel_buffer(
                current_id, poi.id, raw, None
            )
            travel = self._round_travel_minutes(raw + buf)
            buf = max(0, travel - raw)
            distance = helper._distance(current_id, poi.id)
            arrival_t = current_time + travel
            service_start = max(arrival_t, poi.open_time)
            departure = service_start + poi.visit_duration
            if departure > min(self.day_end_time, poi.close_time):
                continue
            # Kiểm tra có kịp về hotel trước day_end sau khi rời POI này không
            if self.return_to_hotel:
                raw_to_hotel = helper._raw_travel(poi.id, self.hotel.id)
                buf_to_hotel, _ = helper._travel_buffer(poi.id, self.hotel.id, raw_to_hotel, None)
                if (
                    departure
                    + self._round_travel_minutes(raw_to_hotel + buf_to_hotel)
                    > self.day_end_time
                ):
                    continue
            wait_minutes = max(0, service_start - arrival_t)
            if poi.place_type == "restaurant" and restaurant_count >= 2:
                continue
            if poi.place_type == "restaurant":
                if restaurant_count == 0:
                    if not (planner.LUNCH_START <= service_start <= planner.LUNCH_END):
                        continue
                else:
                    if not (DINNER_START <= service_start <= DINNER_END):
                        continue
                    if restaurant_starts and service_start - restaurant_starts[-1] < MEAL_MIN_GAP_MINUTES:
                        continue
            if wait_minutes > planner.MAX_NON_MEAL_WAIT_MINUTES:
                continue
            poi_cost = helper._poi_cost(poi)
            
            if self.trip_budget_total > 0:
                if total_activity_cost + poi_cost > self.daily_budget_soft:
                    if len(schedule) > 0:
                        continue

            schedule.append(
                planner.ScheduleEntry(
                    poi.id,
                    poi.name,
                    current_id,
                    current_name,
                    travel,
                    raw,
                    buf,
                    buffer_source,
                    distance,
                    helper._travel_source(current_id, poi.id),
                    arrival_t,
                    departure,
                    wait_minutes,
                    poi.place_type == "restaurant",
                    poi.unknown_hours,
                    place_type=poi.place_type,
                    base_duration=poi.visit_duration,
                    estimated_cost=poi_cost,
                    price_basis=poi.price_basis,
                    price_inferred=poi.price_inferred,
                    best_time=poi.best_time,
                    best_time_source=poi.best_time_source,
                    best_time_applicable=preferred_time_window(
                        poi, day_start, self.day_end_time
                    )
                    is not None,
                    two_tower_score=helper._poi_utility(poi) / planner.UTILITY_SCALE,
                )
            )
            total_travel += travel
            total_distance += distance
            total_visit += poi.visit_duration
            total_wait += wait_minutes
            total_activity_cost += poi_cost
            total_utility += helper._poi_utility(poi)
            restaurant_count += 1 if poi.place_type == "restaurant" else 0
            if poi.place_type == "restaurant":
                restaurant_starts.append(service_start)
            selected_indices.append(idx)
            current_time = departure
            current_id = poi.id
            current_name = poi.name

        # Return to hotel
        if (
            self.return_to_hotel
            and schedule
            and current_id != self.hotel.id
        ):
            raw = helper._raw_travel(current_id, self.hotel.id)
            buf, buffer_source = helper._travel_buffer(
                current_id, self.hotel.id, raw, None
            )
            travel = self._round_travel_minutes(raw + buf)
            buf = max(0, travel - raw)
            distance = helper._distance(current_id, self.hotel.id)
            arrival_time = current_time + travel
            schedule.append(
                planner.ScheduleEntry(
                    self.hotel.id,
                    self.hotel.name,
                    current_id,
                    current_name,
                    travel,
                    raw,
                    buf,
                    buffer_source,
                    distance,
                    helper._travel_source(current_id, self.hotel.id),
                    arrival_time,
                    arrival_time,
                    0,
                    False,
                    False,
                    True,
                    place_type="hotel",
                )
            )
            total_travel += travel
            total_distance += distance

        total_transport_cost = total_distance * self.cost_per_km
        total_day_cost = total_activity_cost + total_transport_cost
        budget_overage = (
            max(0.0, total_day_cost - self.daily_budget_soft)
            if self.trip_budget_total > 0
            else 0.0
        )
        budget_penalty = (
            (budget_overage / planner.BUDGET_OVERAGE_UNIT_VND)
            * planner.BUDGET_PENALTY_WEIGHT
        )
        actual_time = total_travel + total_visit + total_wait
        idle_time = max(
            0, (self.day_end_time - self.day_start_time) - actual_time
        )

        return planner.GAResult(
            best_chromosome=selected_indices,
            schedule=schedule,
            fitness=total_utility,
            cost=total_utility,
            total_travel_time=total_travel,
            total_distance_km=total_distance,
            total_visit_time=total_visit,
            total_wait_time=total_wait,
            total_penalty=0,
            total_hard_violations=0,
            meal_violations=0,
            restaurant_count=restaurant_count,
            total_activity_cost=total_activity_cost,
            total_transport_cost=total_transport_cost,
            total_day_cost=total_day_cost,
            budget_limit=self.daily_budget_soft,
            budget_overage=budget_overage,
            budget_penalty=budget_penalty,
            skipped_count=max(0, len(pois) - len(selected_indices)),
            idle_time=idle_time,
            generation_found=0,
            generations_run=0,
            stopped_reason="greedy_fallback",
            visited_poi_indices=selected_indices,
        )

    # ────────────────────────────────────────────────────────────────────
    # EMPTY DAY
    # ────────────────────────────────────────────────────────────────────

    def _empty_day_result(self, reason: str) -> planner.GAResult:
        return planner.GAResult(
            best_chromosome=[],
            schedule=[],
            fitness=planner.FEASIBILITY_PENALTY,
            cost=planner.FEASIBILITY_PENALTY,
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
            budget_limit=self.daily_budget_soft,
            budget_overage=0.0,
            budget_penalty=0.0,
            skipped_count=0,
            idle_time=max(0, self.day_end_time - self.day_start_time),
            generation_found=0,
            generations_run=0,
            stopped_reason=reason,
            visited_poi_indices=[],
        )

    # ────────────────────────────────────────────────────────────────────
    # SWEEP ALLOCATION
    # ────────────────────────────────────────────────────────────────────

    def _preallocate_days(self) -> AssignmentResult:
        """Use GeoClusteringAssignment for day pools."""
        assignment = GeoClusteringAssignment(
            AssignmentConfig(
                num_days=self.num_days,
                daily_start_time=self.day_start_time,
                daily_end_time=self.day_end_time,
                trip_intent="",
                hotel=self.hotel_place,
                target_nonmeal_per_day=max(1, self.target_pois_per_day - 1),
            ),
            self.travel_times,
        )
        return assignment.assign(
            self.attractions + self.restaurants,
            region_day_allocations=self.region_day_allocations,
        )

    # ────────────────────────────────────────────────────────────────────
    # HELPERS
    # ────────────────────────────────────────────────────────────────────

    @staticmethod
    def _round_travel_minutes(minutes: int | float) -> int:
        value = max(0, int(math.ceil(float(minutes))))
        return int(math.ceil(value / 5.0) * 5) if value > 0 else 0

    def _target_pois_per_day(self) -> int:
        available_minutes = max(0, self.day_end_time - self.day_start_time)
        time_target = max(
            planner.POI_TARGET_MIN_PER_DAY,
            math.floor(available_minutes / planner.POI_TARGET_TIME_SLICE_MINUTES),
        )
        time_target = min(planner.POI_TARGET_MAX_PER_DAY, time_target)
        candidate_avg = math.ceil(
            (len(self.attractions) + len(self.restaurants))
            / max(1, self.num_days)
        )
        if candidate_avg <= 0:
            return planner.POI_TARGET_MIN_PER_DAY
        return max(1, min(time_target, candidate_avg))

    def _hotel_total_cost(self, hotel: planner.Place) -> float:
        per_person_nightly = (
            hotel.estimated_cost
            if hotel.estimated_cost > 0
            else planner.FALLBACK_HOTEL_COST_PER_NIGHT / planner.ROOM_CAPACITY
        )
        nights = max(1, self.num_days - 1)
        return per_person_nightly * nights * self.full_people

    def _select_hotel(self, hotels: List[planner.Place]) -> planner.Place:
        """Chọn hotel có score cao nhất (candidate_rank thấp nhất)."""
        return planner.select_geographic_hotel(
            hotels,
            self.places,
            trip_budget=self.trip_budget,
            hotel_total_cost_fn=self._hotel_total_cost,
        )

    @staticmethod
    def _day_load(pool: dict) -> int:
        """Tổng thời gian dự kiến cho 1 ngày (phút)."""
        total = 0
        for place in pool.get("attractions", []):
            total += max(30, int(getattr(place, "visit_duration", 60)))
        for place in pool.get("restaurants", []):
            total += max(30, int(getattr(place, "visit_duration", 60)))
        return total
