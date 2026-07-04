from __future__ import annotations

import datetime
import math
from dataclasses import dataclass
from typing import Dict, List, Optional, Tuple

from app.services.itinerary.assignment import (
    AssignmentConfig,
    AssignmentResult,
    ConstrainedKMeansAssignment,
)
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


# ── Lunch cutoff ────────────────────────────────────────────────────────
# Nếu ngày bắt đầu sau mốc này → không enforce ăn trưa.
LUNCH_ENFORCE_CUTOFF = 13 * 60 + 30  # 13:30
DINNER_START = 18 * 60
DINNER_END = 19 * 60 + 30
MEAL_MIN_GAP_MINUTES = 210
ENTERTAINMENT_EARLIEST_START = 13 * 60
LATE_ENTERTAINMENT_EARLIEST_START = 18 * 60
ENTERTAINMENT_EARLY_PENALTY_PER_MIN = 4
IDLE_TIME_PENALTY_PER_MIN = 6
HEAD_IDLE_TIME_PENALTY_PER_MIN = 4
SKIPPED_POI_PENALTY = 150
TAIL_IDLE_GRACE_MINUTES = 120
TAIL_IDLE_EXCESS_PENALTY_PER_MIN = 12
BEST_TIME_WINDOWS = {
    "MORNING": (7 * 60, 11 * 60 + 30),
    "AFTERNOON": (13 * 60, 17 * 60 + 30),
    "NIGHT": (18 * 60, 22 * 60),
}
BEST_TIME_BASE_PENALTY_PER_MIN = 2
BEST_TIME_LARGE_DEVIATION_PENALTY_PER_MIN = 4
BEST_TIME_GRACE_MINUTES = 30


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
        self.places = config.places
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
        self.cost_per_km = planner.TRANSPORT_COST_PER_KM.get(
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
        self.adult_equivalent = (
            self.adult_count + self.child_count * planner.CHILD_COST_FACTOR
        )
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
        self.daily_budget_soft = residual_budget

        # ── Cluster ──
        self.assignment_result = self._preallocate_days()

    def _is_late_entertainment(self, poi: planner.POI) -> bool:
        text = planner.normalize_text(f"{poi.name} {poi.place_type}")
        return any(
            keyword in text
            for keyword in (
                "karaoke",
                "bar",
                "pub",
                "club",
                "cinema",
                "rap phim",
                "billiard",
                "bida",
                "game",
                "escape",
                "bowling",
            )
        )

    def _entertainment_earliest_start(self, poi: planner.POI) -> int:
        if poi.place_type != "entertainment":
            return 0
        if self._is_late_entertainment(poi):
            return LATE_ENTERTAINMENT_EARLIEST_START
        return ENTERTAINMENT_EARLIEST_START

    def _apply_restaurant_constraints(
        self,
        model: cp_model.CpModel,
        pois: List[planner.POI],
        selected: dict,
        start_var: dict,
        lunch_window: Optional[Tuple[int, int]],
        enforce_lunch: bool,
        scope_tag: str,
    ) -> None:
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
            if (
                lunch_window
                and poi.open_time <= lunch_window[1]
                and poi.close_time >= lunch_window[0]
            ):
                lunch_flag = model.NewBoolVar(f"{scope_tag}_lunch_{node}")
                model.Add(start_var[node] >= lunch_window[0]).OnlyEnforceIf(lunch_flag)
                model.Add(start_var[node] <= lunch_window[1]).OnlyEnforceIf(lunch_flag)
                model.AddImplication(lunch_flag, selected[node])
                lunch_flags.append(lunch_flag)

            if poi.open_time <= DINNER_END and poi.close_time >= DINNER_START:
                dinner_flag = model.NewBoolVar(f"{scope_tag}_dinner_{node}")
                model.Add(start_var[node] >= DINNER_START).OnlyEnforceIf(dinner_flag)
                model.Add(start_var[node] <= DINNER_END).OnlyEnforceIf(dinner_flag)
                model.AddImplication(dinner_flag, selected[node])
                dinner_flags.append(dinner_flag)

        if enforce_lunch and lunch_flags:
            model.Add(sum(lunch_flags) >= 1)

        if len(restaurant_nodes) >= 2:
            second_meal = model.NewBoolVar(f"{scope_tag}_second_meal")
            model.Add(sum(selected[i] for i in restaurant_nodes) >= 2).OnlyEnforceIf(
                second_meal
            )
            model.Add(sum(selected[i] for i in restaurant_nodes) <= 1).OnlyEnforceIf(
                second_meal.Not()
            )
            if dinner_flags:
                model.Add(sum(dinner_flags) >= 1).OnlyEnforceIf(second_meal)
            else:
                model.Add(second_meal == 0)

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
        remaining_budget = self.trip_residual_budget

        def solve_one_day(day_idx: int) -> planner.DayResult:
            pool = self.assignment_result.day_pools[day_idx]
            daily_places = [*pool["attractions"], *pool["restaurants"]]
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
            return planner.DayResult(
                day=day_idx + 1, pois=day_pois, ga_result=day_result
            )

        # Chạy song song các ngày
        day_results: list[planner.DayResult] = []
        for day_idx in range(self.num_days):
            self.daily_budget_soft = max(0.0, remaining_budget)
            day_result = solve_one_day(day_idx)
            day_results.append(day_result)
            remaining_budget = max(
                0.0,
                remaining_budget
                - max(0.0, float(day_result.ga_result.total_day_cost or 0)),
            )
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
        
        # Xác định có enforce lunch hay không
        if is_day_1:
            day1_start = self.config.check_in_time or self.day_start_time
            enforce_lunch_base = day1_start <= LUNCH_ENFORCE_CUTOFF
        else:
            enforce_lunch_base = True

        lunch_win = (planner.LUNCH_START, planner.LUNCH_END)
        day_start = (
            self.config.check_in_time
            if is_day_1 and self.config.check_in_time is not None
            else self.day_start_time
        )
        initial_target_min, _ = self._calculate_target_bounds(
            len(pois),
            day_start,
        )

        # Preserve lunch semantics while the dynamic target is feasible.
        if enforce_lunch_base:
            result = self._solve_day_core(
                day_number, pois, is_day_1,
                enforce_lunch=True, lunch_window=lunch_win,
                budget_tolerance_ratio=0.00,
                target_min=initial_target_min,
            )
            if result is not None:
                return result

            relaxed = (lunch_win[0] - 30, lunch_win[1] + 30)
            for target_min in range(initial_target_min, 0, -1):
                result = self._solve_day_core(
                    day_number, pois, is_day_1,
                    enforce_lunch=True, lunch_window=relaxed,
                    budget_tolerance_ratio=0.00,
                    target_min=target_min,
                )
                if result is not None:
                    return result

        # target_min is the new hard constraint. Lower it smoothly before
        # falling back to greedy so sparse, remote, or low-budget days survive.
        for target_min in range(initial_target_min, 0, -1):
            result = self._solve_day_core(
                day_number, pois, is_day_1,
                enforce_lunch=False, lunch_window=None,
                budget_tolerance_ratio=0.00,
                target_min=target_min,
            )
            if result is not None:
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
        lunch_window: Optional[Tuple[int, int]],
        budget_tolerance_ratio: float = 0.10,
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
                pois, helper, day_start, enforce_lunch, lunch_window,
                budget_tolerance_ratio, target_min
            )
        return self._build_circuit_model(
            day_number, pois, helper, day_start, enforce_lunch, lunch_window,
            budget_tolerance_ratio, target_min
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
        lunch_window: Optional[Tuple[int, int]],
        budget_tolerance_ratio: float,
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
        wait = {
            i: model.NewIntVar(0, 24 * 60, f"wait_{i}")
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
        lunch_flags = []
        for j in range(1, n + 1):
            poi = pois[j - 1]
            model.Add(
                start_var[j] >= arrival[j]
            ).OnlyEnforceIf(selected[j])
            model.Add(
                wait[j] == start_var[j] - arrival[j]
            ).OnlyEnforceIf(selected[j])
            
            # Keep the timeline continuous. A selected POI must be reachable
            # exactly when its visit starts; no implicit waiting is inserted.
            model.Add(wait[j] == 0).OnlyEnforceIf(selected[j])
            model.Add(
                depart[j] == start_var[j] + max(0, int(poi.visit_duration))
            ).OnlyEnforceIf(selected[j])
            model.Add(
                start_var[j] >= max(day_start, int(poi.open_time))
            ).OnlyEnforceIf(selected[j])
            model.Add(
                depart[j] <= min(self.day_end_time, int(poi.close_time))
            ).OnlyEnforceIf(selected[j])
            # Lunch constraint
            if poi.place_type == "restaurant" and enforce_lunch:
                lunch_flag = model.NewBoolVar(f"lunch_flag_{j}")
                model.AddImplication(lunch_flag, selected[j])
                lunch_flags.append(lunch_flag)
                if lunch_window and poi.open_time <= lunch_window[1] and poi.close_time >= lunch_window[0]:
                    model.Add(start_var[j] >= lunch_window[0]).OnlyEnforceIf(lunch_flag)
                    model.Add(start_var[j] <= lunch_window[1]).OnlyEnforceIf(lunch_flag)

        if enforce_lunch:
            if lunch_flags:
                model.Add(sum(lunch_flags) >= 1)

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
            lunch_window,
            enforce_lunch,
            "day1",
        )
        cafe_nodes = [
            i for i in range(1, n + 1) if pois[i - 1].place_type == "cafe"
        ]
        if cafe_nodes:
            model.Add(sum(selected[i] for i in cafe_nodes) <= 1)

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
            model, n, pois, selected, start_var, wait,
            arc_vars, travel_minutes, travel_distance, helper, budget_tolerance_ratio,
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
        reason = (
            "cpsat_optimal" if status == cp_model.OPTIMAL else "cpsat_feasible"
        )
        if not enforce_lunch:
            reason += "_no_lunch"

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
            lunch_skipped=not enforce_lunch,
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
        lunch_window: Optional[Tuple[int, int]],
        budget_tolerance_ratio: float,
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
        wait = {
            i: model.NewIntVar(0, 24 * 60, f"wait_{i}")
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
        lunch_flags = []
        for j in range(1, n + 1):
            poi = pois[j - 1]
            model.Add(
                start_var[j] >= arrival[j]
            ).OnlyEnforceIf(selected[j])
            model.Add(
                wait[j] == start_var[j] - arrival[j]
            ).OnlyEnforceIf(selected[j])
            
            # Keep the timeline continuous. Opening and meal windows must be
            # satisfied through route selection/order rather than waiting.
            model.Add(wait[j] == 0).OnlyEnforceIf(selected[j])
            model.Add(
                depart[j] == start_var[j] + max(0, int(poi.visit_duration))
            ).OnlyEnforceIf(selected[j])
            model.Add(
                start_var[j] >= max(day_start, int(poi.open_time))
            ).OnlyEnforceIf(selected[j])
            model.Add(
                depart[j] <= min(self.day_end_time, int(poi.close_time))
            ).OnlyEnforceIf(selected[j])
            # Lunch
            if poi.place_type == "restaurant" and enforce_lunch:
                lunch_flag = model.NewBoolVar(f"lunch_flag_{j}")
                model.AddImplication(lunch_flag, selected[j])
                lunch_flags.append(lunch_flag)
                if lunch_window and poi.open_time <= lunch_window[1] and poi.close_time >= lunch_window[0]:
                    model.Add(start_var[j] >= lunch_window[0]).OnlyEnforceIf(lunch_flag)
                    model.Add(start_var[j] <= lunch_window[1]).OnlyEnforceIf(lunch_flag)

        if enforce_lunch:
            if lunch_flags:
                model.Add(sum(lunch_flags) >= 1)

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
            lunch_window,
            enforce_lunch,
            "day1",
        )
        cafe_nodes = [
            i for i in range(1, n + 1) if pois[i - 1].place_type == "cafe"
        ]
        if cafe_nodes:
            model.Add(sum(selected[i] for i in cafe_nodes) <= 1)

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
            model, n, pois, selected, start_var, wait,
            arc_vars, travel_minutes, travel_distance, helper, budget_tolerance_ratio,
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
        reason = (
            "cpsat_optimal" if status == cp_model.OPTIMAL else "cpsat_feasible"
        )
        if not enforce_lunch:
            reason += "_no_lunch"

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
            lunch_skipped=not enforce_lunch,
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
        wait: dict,
        arc_vars: dict,
        travel_minutes: dict,
        travel_distance: dict,
        helper,
        budget_tolerance_ratio: float,
        return_time,
        day_start: int = None,
    ) -> None:
        effective_day_start = day_start if day_start is not None else self.day_start_time
        available_minutes = max(1, self.day_end_time - effective_day_start)

        utility_terms = []
        travel_terms = []
        wait_terms = []
        skipped_terms = []
        activity_cost_terms = []
        best_time_penalty_terms = []

        daily_budget_target = self.trip_budget / max(1, self.num_days)
        user_tier = "low"
        if daily_budget_target >= 1200000:
            user_tier = "high"
        elif daily_budget_target >= 500000:
            user_tier = "medium"

        for i, poi in enumerate(pois, start=1):
            poi_cost = helper._poi_cost(poi)
            poi_price_tier = "cheap"
            if poi_cost >= 500000:
                poi_price_tier = "premium"
            elif poi_cost >= 100000:
                poi_price_tier = "medium"

            price_fit_bonus = 0
            if user_tier == "low":
                if poi_price_tier == "cheap": price_fit_bonus = 50
                elif poi_price_tier == "premium": price_fit_bonus = -500
            elif user_tier == "medium":
                if poi_price_tier == "medium": price_fit_bonus = 50
            elif user_tier == "high":
                if poi_price_tier == "premium": price_fit_bonus = 100
                elif poi_price_tier == "cheap": price_fit_bonus = -50

            two_tower_score = helper._poi_utility(poi) / planner.UTILITY_SCALE
            premium_low_score_penalty = 0
            if user_tier == "high" and poi_price_tier == "premium" and two_tower_score < 0.65:
                premium_low_score_penalty = 250

            cost_penalty = int(poi_cost // 10000)
            # Food utility is scaled down: restaurants 300x, cafes 150x (vs attractions 1000x)
            if poi.place_type == "restaurant":
                poi_reward = int(round(two_tower_score * 300))
            elif poi.place_type == "cafe":
                poi_reward = int(round(two_tower_score * 150))
            else:
                poi_reward = int(round(two_tower_score * 1000))
            stay_penalty = int(poi.visit_duration)
            effective_reward = poi_reward + price_fit_bonus - premium_low_score_penalty - cost_penalty - stay_penalty

            utility_terms.append(effective_reward * selected[i])
            wait_terms.append(wait[i] * 30)
            # Reduced skipped weight (80) to match winner scoring and let density penalty steer count
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

        entertainment_penalty_terms = []
        for i, poi in enumerate(pois, start=1):
            earliest = self._entertainment_earliest_start(poi)
            if earliest <= 0:
                continue
            early_minutes = model.NewIntVar(
                0, 24 * 60, f"entertainment_early_minutes_{i}"
            )
            model.Add(early_minutes >= earliest - start_var[i])
            model.Add(early_minutes >= 0)
            entertainment_penalty_terms.append(
                early_minutes * ENTERTAINMENT_EARLY_PENALTY_PER_MIN
            )

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

        if self.trip_budget_total > 0:
            max_allowed_cost_k = int(daily_budget_k * (1 + budget_tolerance_ratio))
            model.Add(activity_cost_k + transport_cost_k <= max_allowed_cost_k)

        budget_k_overage = model.NewIntVar(0, 2_000_000, "budget_k_overage")
        if self.trip_budget_total > 0:
            model.Add(budget_k_overage >= activity_cost_k + transport_cost_k - daily_budget_k)
        else:
            model.Add(budget_k_overage == 0)

        budget_penalty = budget_k_overage * 2

        # ── Day-density penalty ──
        # target: one POI per 150 min of available time
        target_poi_count = max(1, round(available_minutes / 150))

        selected_total = model.NewIntVar(0, n, "selected_total")
        model.Add(selected_total == sum(selected.values()))

        density_diff = model.NewIntVar(0, n, "density_diff")
        model.AddAbsEquality(density_diff, selected_total - target_poi_count)
        density_penalty_term = density_diff * 200

        # Dense-day penalty: avg_minutes_per_poi < 90 ⟺ selected > available // 90
        dense_threshold = max(1, available_minutes // 90)
        is_too_dense = model.NewBoolVar("is_too_dense")
        model.Add(selected_total > dense_threshold).OnlyEnforceIf(is_too_dense)
        model.Add(selected_total <= dense_threshold).OnlyEnforceIf(is_too_dense.Not())
        dense_penalty_term = is_too_dense * 500

        # Sparse-day penalty: selected_count <= 2 on a full-length day
        sparse_penalty_term: object = 0
        if available_minutes >= 720:
            is_too_sparse = model.NewBoolVar("is_too_sparse")
            model.Add(selected_total <= 2).OnlyEnforceIf(is_too_sparse)
            model.Add(selected_total > 2).OnlyEnforceIf(is_too_sparse.Not())
            sparse_penalty_term = is_too_sparse * 600

        # ── Distance penalty (in 0.1-km integer units) ──
        arc_dist_10 = {
            (i, j): int(round(travel_distance.get((i, j), 0.0) * 10))
            for (i, j) in arc_vars
        }
        dist_total_10 = model.NewIntVar(0, 20000, "dist_total_10")
        model.Add(
            dist_total_10 == sum(arc_dist_10[(i, j)] * arc_vars[(i, j)] for (i, j) in arc_vars)
        )

        # >60 km: +20/km over = +2 per 0.1-km unit over 600
        dist_over_600 = model.NewIntVar(0, 20000, "dist_over_600")
        model.Add(dist_over_600 >= dist_total_10 - 600)
        # >80 km: additional +50/km = +5 per unit over 800
        dist_over_800 = model.NewIntVar(0, 20000, "dist_over_800")
        model.Add(dist_over_800 >= dist_total_10 - 800)
        # >100 km: +2000 flat
        is_extreme_dist = model.NewBoolVar("is_extreme_dist")
        model.Add(dist_total_10 > 1000).OnlyEnforceIf(is_extreme_dist)
        model.Add(dist_total_10 <= 1000).OnlyEnforceIf(is_extreme_dist.Not())

        distance_penalty_term = dist_over_600 * 2 + dist_over_800 * 5 + is_extreme_dist * 2000

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

        idle_tail = model.NewIntVar(0, 24 * 60, "idle_tail")
        model.Add(idle_tail == self.day_end_time - return_time)
        idle_penalty_term = idle_tail * IDLE_TIME_PENALTY_PER_MIN
        idle_tail_excess = model.NewIntVar(0, 24 * 60, "idle_tail_excess")
        model.Add(
            idle_tail_excess >= idle_tail - TAIL_IDLE_GRACE_MINUTES
        )
        idle_excess_penalty_term = (
            idle_tail_excess * TAIL_IDLE_EXCESS_PENALTY_PER_MIN
        )

        # Penalize an unnecessarily late first stop. Previously only the idle
        # tail was penalized, so a route could start at lunch and still finish
        # late enough to look attractive to the objective.
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
            head_idle_terms.append(head_idle * HEAD_IDLE_TIME_PENALTY_PER_MIN)

        model.Minimize(
            sum(travel_terms)
            + sum(wait_terms)
            + sum(entertainment_penalty_terms)
            + sum(best_time_penalty_terms)
            + budget_penalty
            + sum(skipped_terms)
            - sum(utility_terms)
            + density_penalty_term
            + dense_penalty_term
            + sparse_penalty_term
            + distance_penalty_term
            + travel_penalty_term
            + idle_penalty_term
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
        """Use the same constrained K-means assignment as the GA engine."""
        assignment = ConstrainedKMeansAssignment(
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
        return assignment.assign(self.attractions + self.restaurants)

    def _preallocate_days_sweep_legacy(self) -> AssignmentResult:
        """
        Sweep Allocation: angle-based sequential day assignment with capacity
        and distance guardrails. Replaces K-Means.

        Flow:
          1. Deduplicate candidates
          2. Separate: primary attractions | cafes | restaurants
          3. Sweep-assign primary attractions into days (remote POIs get own day)
          4. Balance uneven pools
          5. Compute cluster centroids
          6. Inject cafes near each day cluster (cap 1/day)
          7. Assign restaurants from global pool (proximity-gated)
          8. Trim + snapshot counts
        """
        candidates = self._deduplicate_candidates(self.attractions + self.restaurants)

        if not candidates or self.num_days <= 0:
            return AssignmentResult(
                day_pools=[{"attractions": [], "restaurants": []} for _ in range(self.num_days)],
                day_loads=[0] * self.num_days,
            )

        # Very few candidates → round-robin fallback
        primary_only = [p for p in candidates if p.place_type in {"attraction", "entertainment"}]
        if len(primary_only) < self.num_days:
            return self._round_robin_assign(candidates)

        cafes = [p for p in candidates if p.place_type == "cafe"]
        restaurants = [p for p in candidates if p.place_type == "restaurant"]

        # Sweep-assign primary attractions
        day_pools = self._sweep_allocate_days(primary_only)

        # Balance uneven days after sweep
        self._balance_day_pools(day_pools)

        # Centroids from pure attractions only
        self._compute_cluster_centroids(day_pools)

        # Inject cafes near each day's cluster (1 per day)
        self._inject_cafes_to_days(cafes, day_pools)

        # Snapshot base counts (before restaurant injection)
        for pool in day_pools:
            pool["base_candidate_count"] = len(pool["attractions"]) + len(pool["restaurants"])
            pool["base_restaurant_count"] = len(pool["restaurants"])

        # Assign restaurants from global pool
        self._assign_restaurants_to_days(restaurants, day_pools)

        # Record injected restaurant count
        for pool in day_pools:
            pool["injected_restaurant_count"] = max(
                0, len(pool["restaurants"]) - pool["base_restaurant_count"]
            )

        self._trim_day_pools(day_pools)

        for pool in day_pools:
            pool["final_candidate_count"] = len(pool["attractions"]) + len(pool["restaurants"])

        day_loads = [self._day_load(pool) for pool in day_pools]
        return AssignmentResult(
            day_pools=day_pools,
            day_loads=day_loads,
            warnings=[f"sweep_v1 primary={len(primary_only)} cafes={len(cafes)} restaurants={len(restaurants)}"],
        )

    def _round_robin_assign(self, candidates: list) -> AssignmentResult:
        """Fallback: distribute candidates evenly when too few for sweep."""
        day_pools: list[dict] = [
            {
                "attractions": [], "restaurants": [],
                "allocation_method": "round_robin",
                "is_remote_day": False,
            }
            for _ in range(self.num_days)
        ]
        for idx, place in enumerate(candidates):
            day_idx = idx % self.num_days
            if place.place_type == "restaurant":
                day_pools[day_idx]["restaurants"].append(place)
            else:
                day_pools[day_idx]["attractions"].append(place)

        self._compute_cluster_centroids(day_pools)

        cafes_global = [p for p in candidates if p.place_type == "cafe"]
        rest_global = [p for p in candidates if p.place_type == "restaurant"]
        self._inject_cafes_to_days(cafes_global, day_pools)
        self._assign_restaurants_to_days(rest_global, day_pools)

        for pool in day_pools:
            pool.setdefault("base_candidate_count", len(pool["attractions"]) + len(pool["restaurants"]))
            pool.setdefault("base_restaurant_count", len(pool["restaurants"]))
            pool.setdefault("injected_restaurant_count", 0)
            pool.setdefault("final_candidate_count", len(pool["attractions"]) + len(pool["restaurants"]))
            pool.setdefault("cafe_filtered_count", 0)

        day_loads = [self._day_load(pool) for pool in day_pools]
        return AssignmentResult(
            day_pools=day_pools, day_loads=day_loads, warnings=["round_robin_fallback"],
        )

    def _deduplicate_candidates(self, places: list) -> list:
        """
        Remove near-duplicate POIs before allocation.
        Keep the better-ranked one (lower candidate_rank = better).

        Rules (any → duplicate):
          - Same place_type + distance < 200 m
          - Same category group + distance < 500 m + token-overlap >= 40 %
        """
        if len(places) <= 1:
            return list(places)

        import re as _re

        def _tokens(name: str) -> set:
            s = name.lower()
            s = _re.sub(r'[^\w\s]', ' ', s)
            stop = {'và', 'của', 'ở', 'tại', 'the', 'a', 'an', 'in', '-', ''}
            return set(s.split()) - stop

        def _cat(place_type: str) -> str:
            if place_type in {"restaurant", "cafe"}:
                return place_type
            return "poi"

        # Sort best-ranked first so we keep the better option
        sorted_places = sorted(places, key=lambda p: p.candidate_rank)
        kept: list = []

        for place in sorted_places:
            p_tokens = _tokens(place.name)
            p_cat = _cat(place.place_type)
            is_dup = False

            for existing in kept:
                dist = self._haversine_km(
                    place.latitude, place.longitude,
                    existing.latitude, existing.longitude,
                )
                # Same type, very close → obvious duplicate
                if place.place_type == existing.place_type and dist < 0.2:
                    is_dup = True
                    break
                # Same category group, somewhat close, and name overlaps
                if _cat(existing.place_type) == p_cat and dist < 0.5:
                    e_tokens = _tokens(existing.name)
                    union = p_tokens | e_tokens
                    if union:
                        jaccard = len(p_tokens & e_tokens) / len(union)
                        if jaccard >= 0.4:
                            is_dup = True
                            break

            if not is_dup:
                kept.append(place)

        return kept

    def _sweep_allocate_days(self, primary: list) -> list[dict]:
        """
        Assign primary attractions to days via angular sweep with capacity
        and distance guardrails.

        Remote POIs (distance >= 30 km OR one-way travel >= 60 min) are
        assigned to dedicated day slots and not mixed with city-centre POIs.

        Returns day_pools with only attractions (no cafes, no restaurants yet).
        """
        anchor_lat = self.hotel_place.latitude
        anchor_lng = self.hotel_place.longitude
        avail_min = max(60, self.day_end_time - self.day_start_time)
        max_used = int(avail_min * 0.90)
        target_used = int(avail_min * 0.70)

        # Classify
        remote: list[tuple] = []   # (place, dist_km)
        normal: list[tuple] = []   # (place, angle_rad, dist_km)

        for p in primary:
            dist_km = self._haversine_km(p.latitude, p.longitude, anchor_lat, anchor_lng)
            one_way_min = self._haversine_minutes(p.latitude, p.longitude, anchor_lat, anchor_lng)
            if dist_km >= 30.0 or one_way_min >= 60:
                remote.append((p, dist_km))
            else:
                angle = math.atan2(p.latitude - anchor_lat, p.longitude - anchor_lng)
                normal.append((p, angle, dist_km))

        # Farthest-first for remote; angular order for normal
        remote.sort(key=lambda x: -x[1])
        normal.sort(key=lambda x: x[1])

        # Initialise day pools
        day_pools: list[dict] = [
            {
                "attractions": [], "restaurants": [],
                "_used_min": 0, "_est_dist_km": 0.0,
                "is_remote_day": False, "remote_anchor_name": None,
                "allocation_method": "sweep",
            }
            for _ in range(self.num_days)
        ]

        # Phase 1: reserve dedicated slots for remote POIs
        remote_day_set: set[int] = set()

        for r_poi, r_dist in remote:
            one_way_min = self._haversine_minutes(
                r_poi.latitude, r_poi.longitude, anchor_lat, anchor_lng
            )
            est_day_min = one_way_min * 2 + getattr(r_poi, "visit_duration", 120)
            stay_min = getattr(r_poi, "visit_duration", 120)

            best_day: Optional[int] = None

            # 1st: an existing remote day whose anchor is within 8 km and has capacity
            for di in list(remote_day_set):
                if not day_pools[di]["attractions"]:
                    continue
                anchor_poi = day_pools[di]["attractions"][0]
                if (self._haversine_km(
                    r_poi.latitude, r_poi.longitude,
                    anchor_poi.latitude, anchor_poi.longitude,
                ) <= 8.0 and day_pools[di]["_used_min"] + stay_min + 30 <= max_used):
                    best_day = di
                    break

            # 2nd: first empty non-remote day
            if best_day is None:
                for di in range(self.num_days):
                    if di not in remote_day_set and not day_pools[di]["attractions"]:
                        best_day = di
                        break

            # 3rd: any non-remote day with enough capacity
            if best_day is None:
                for di in range(self.num_days):
                    if di not in remote_day_set and day_pools[di]["_used_min"] + est_day_min <= max_used:
                        best_day = di
                        break

            # Last resort: least-loaded day
            if best_day is None:
                best_day = min(range(self.num_days), key=lambda di: day_pools[di]["_used_min"])

            pool = day_pools[best_day]
            pool["attractions"].append(r_poi)
            pool["_used_min"] += est_day_min
            pool["_est_dist_km"] += r_dist * 2
            pool["is_remote_day"] = True
            if pool["remote_anchor_name"] is None:
                pool["remote_anchor_name"] = r_poi.name
            remote_day_set.add(best_day)

        # Phase 2: sweep normal POIs into non-remote days
        normal_days = [di for di in range(self.num_days) if di not in remote_day_set]
        if not normal_days:
            normal_days = list(range(self.num_days))

        day_cursor = 0

        for poi, angle, poi_dist in normal:
            assigned = False

            for attempt in range(len(normal_days)):
                di = normal_days[(day_cursor + attempt) % len(normal_days)]
                pool = day_pools[di]

                if pool["attractions"]:
                    prev = pool["attractions"][-1]
                    travel_min = self._haversine_minutes(
                        prev.latitude, prev.longitude, poi.latitude, poi.longitude
                    )
                    seg_dist = self._haversine_km(
                        prev.latitude, prev.longitude, poi.latitude, poi.longitude
                    )
                else:
                    travel_min = self._haversine_minutes(
                        anchor_lat, anchor_lng, poi.latitude, poi.longitude
                    )
                    seg_dist = poi_dist

                incremental = travel_min + getattr(poi, "visit_duration", 90)
                new_used = pool["_used_min"] + incremental
                new_dist = pool["_est_dist_km"] + seg_dist

                if new_used <= max_used and new_dist <= 80.0:
                    pool["attractions"].append(poi)
                    pool["_used_min"] = new_used
                    pool["_est_dist_km"] = new_dist
                    assigned = True
                    if pool["_used_min"] >= target_used:
                        day_cursor = (day_cursor + 1) % len(normal_days)
                    break

            if not assigned:
                # Force-assign to least-loaded normal day (distance limit relaxed)
                best = min(normal_days, key=lambda di: day_pools[di]["_used_min"])
                day_pools[best]["attractions"].append(poi)
                day_pools[best]["_used_min"] += (
                    self._haversine_minutes(anchor_lat, anchor_lng, poi.latitude, poi.longitude)
                    + getattr(poi, "visit_duration", 90)
                )

        # Promote tracking state to diagnostics, clean up temp keys
        for pool in day_pools:
            pool["day_used_minutes"] = pool.pop("_used_min", 0)
            pool["day_estimated_distance"] = round(pool.pop("_est_dist_km", 0.0), 2)

        return day_pools

    def _inject_cafes_to_days(self, cafes: list, day_pools: list) -> None:
        """
        Inject at most 1 cafe per day from the global cafe list.
        Only cafes within 2 km of a day's pure attraction are eligible.
        Records cafe_filtered_count = total_cafes - total_injected.
        """
        available = sorted(cafes, key=lambda p: p.candidate_rank)
        assigned_ids: set[str] = set()
        total_injected = 0

        for pool in day_pools:
            pure_attractions = [p for p in pool["attractions"] if p.place_type == "attraction"]
            if not pure_attractions:
                continue

            best_cafe = None
            best_dist = float("inf")

            for c in available:
                if c.id in assigned_ids:
                    continue
                min_dist = min(
                    self._haversine_km(c.latitude, c.longitude, a.latitude, a.longitude)
                    for a in pure_attractions
                )
                if min_dist <= 2.0 and min_dist < best_dist:
                    best_dist = min_dist
                    best_cafe = c

            if best_cafe is not None:
                pool["attractions"].append(best_cafe)
                assigned_ids.add(best_cafe.id)
                total_injected += 1

        # Store how many cafes weren't injected (useful for diagnostics)
        remainder = len(cafes) - total_injected
        for pool in day_pools:
            pool.setdefault("cafe_filtered_count", remainder)

    def _assign_restaurants_to_days(self, restaurants: list, day_pools: list) -> None:
        """
        Assign restaurants from the global pool to day pools using proximity gates.

        Pass 1: give each day exactly 1 qualifying restaurant (centroid ≤3 km OR
                nearest attraction ≤2.5 km).
        Pass 2: top up days that still have 0 restaurants with best-available fallback.
        Pass 3: allow a 2nd restaurant per day if unassigned restaurants remain.

        Restaurants are not shared between days.
        """
        available = sorted(restaurants, key=lambda r: r.candidate_rank)
        assigned_ids: set[str] = set()

        def _best_dist(r, pool: dict) -> float:
            pure = [p for p in pool["attractions"] if p.place_type == "attraction"]
            centroid = pool.get("day_cluster_center")
            if pure:
                return min(
                    self._haversine_km(r.latitude, r.longitude, a.latitude, a.longitude)
                    for a in pure
                )
            if centroid:
                return self._haversine_km(r.latitude, r.longitude, centroid[0], centroid[1])
            return self._haversine_km(
                r.latitude, r.longitude,
                self.hotel_place.latitude, self.hotel_place.longitude,
            )

        def _qualifies(r, pool: dict) -> bool:
            centroid = pool.get("day_cluster_center")
            pure = [p for p in pool["attractions"] if p.place_type == "attraction"]
            if centroid and self._haversine_km(r.latitude, r.longitude, centroid[0], centroid[1]) <= 3.0:
                return True
            if pure and min(
                self._haversine_km(r.latitude, r.longitude, a.latitude, a.longitude)
                for a in pure
            ) <= 2.5:
                return True
            return False

        # Pass 1: one qualifying restaurant per day
        for pool in day_pools:
            best_r = None
            best_d = float("inf")
            for r in available:
                if r.id in assigned_ids or not _qualifies(r, pool):
                    continue
                d = _best_dist(r, pool)
                if d < best_d:
                    best_d = d
                    best_r = r
            if best_r:
                pool["restaurants"].append(best_r)
                assigned_ids.add(best_r.id)
                pool["injected_reason"] = "near_cluster"

        # Pass 2: fallback for days still missing a restaurant
        for pool in day_pools:
            if pool["restaurants"]:
                continue
            best_r = None
            best_d = float("inf")
            for r in available:
                if r.id in assigned_ids:
                    continue
                d = _best_dist(r, pool)
                if d < best_d:
                    best_d = d
                    best_r = r
            if best_r:
                pool["restaurants"].append(best_r)
                assigned_ids.add(best_r.id)
                pool["injected_reason"] = "best_available"

        # Pass 3: 2nd restaurant per day if budget allows
        for pool in day_pools:
            if len(pool["restaurants"]) >= 2:
                continue
            best_r = None
            best_d = float("inf")
            for r in available:
                if r.id in assigned_ids or not _qualifies(r, pool):
                    continue
                d = _best_dist(r, pool)
                if d < best_d:
                    best_d = d
                    best_r = r
            if best_r:
                pool["restaurants"].append(best_r)
                assigned_ids.add(best_r.id)

    def _compute_cluster_centroids(self, day_pools: list) -> None:
        """Compute attraction-only centroid per day and store as day_cluster_center."""
        for pool in day_pools:
            pure_attractions = [
                p for p in pool["attractions"] if p.place_type == "attraction"
            ]
            pool["day_cluster_center"] = self._centroid(pure_attractions)

    def _balance_day_pools(self, day_pools: list) -> None:
        """
        Cân bằng kích thước cluster sau K-Means.

        K-Means thuần không đảm bảo số lượng POI bằng nhau giữa các ngày.
        Khi địa điểm tập trung một vùng (VD: trung tâm TP), một cluster có thể
        nhận 50+ POI còn các cluster khác chỉ có 2-3.

        Thuật toán:
          1. Tính target = total // num_days, threshold = max(3, target // 2)
          2. Lặp: tìm ngày quá tải (over) và ngày thiếu (under)
          3. Dừng khi max_size - min_size <= threshold
          4. Mỗi bước: chuyển attraction gần centroid của ngày under nhất từ ngày over sang
             (chỉ chuyển restaurant nếu ngày over có > 1 restaurant)
        """
        total = sum(
            len(pool["attractions"]) + len(pool["restaurants"])
            for pool in day_pools
        )
        if total == 0 or self.num_days <= 1:
            return

        target = max(1, total // self.num_days)
        # Dừng khi độ lệch max-min không vượt quá ngưỡng này
        stop_threshold = max(3, target // 2)

        for _ in range(total * 2):
            day_sizes = [
                len(pool["attractions"]) + len(pool["restaurants"])
                for pool in day_pools
            ]
            over_idx = max(range(self.num_days), key=lambda i: day_sizes[i])
            under_idx = min(range(self.num_days), key=lambda i: day_sizes[i])

            if day_sizes[over_idx] - day_sizes[under_idx] <= stop_threshold:
                break

            # Centroid của ngày thiếu (fallback về hotel nếu chưa có POI nào)
            under_places = (
                day_pools[under_idx]["attractions"]
                + day_pools[under_idx]["restaurants"]
            )
            if under_places:
                c_lat = sum(p.latitude for p in under_places) / len(under_places)
                c_lng = sum(p.longitude for p in under_places) / len(under_places)
            else:
                c_lat = self.hotel_place.latitude
                c_lng = self.hotel_place.longitude

            # Tìm POI gần centroid nhất từ ngày quá tải để chuyển sang
            over_pool = day_pools[over_idx]
            best_place = None
            best_dist = float("inf")

            for p in over_pool["attractions"]:
                d = self._haversine_minutes(p.latitude, p.longitude, c_lat, c_lng)
                if d < best_dist:
                    best_dist = d
                    best_place = (p, "attractions")

            # Chỉ di chuyển restaurant nếu ngày quá tải có > 1 restaurant
            if best_place is None:
                for p in over_pool["restaurants"]:
                    if len(over_pool["restaurants"]) > 1:
                        d = self._haversine_minutes(
                            p.latitude, p.longitude, c_lat, c_lng
                        )
                        if d < best_dist:
                            best_dist = d
                            best_place = (p, "restaurants")

            if best_place is None:
                break

            place, pool_key = best_place
            day_pools[over_idx][pool_key].remove(place)
            day_pools[under_idx][pool_key].append(place)

    def _trim_day_pools(self, day_pools: list) -> None:
        """
        Giới hạn số candidates mỗi ngày để CP-SAT không bị timeout.

        Sau K-Means + balance, mỗi ngày có thể có 16+ candidates.
        Với n=16 nodes, circuit model tạo ra ~n² arc vars → LP relaxation nặng
        → solver hết 8s mà chưa tìm được FEASIBLE → fall back sang greedy.

        Giải pháp: giữ tối đa MAX_POOL_PER_DAY candidates/ngày.
        Ưu tiên giữ: tối đa 3 restaurants (bắt buộc cho lunch) + top attractions theo candidate_rank.
        """
        max_pool = max(self.target_pois_per_day + 8, 20)
        for pool in day_pools:
            if len(pool["restaurants"]) > 2:
                pool["restaurants"] = sorted(
                    pool["restaurants"], key=lambda p: p.candidate_rank
                )[:2]
                
            total = len(pool["attractions"]) + len(pool["restaurants"])
            if total <= max_pool:
                continue
            
            n_keep_attractions = max(0, max_pool - len(pool["restaurants"]))
            if n_keep_attractions < len(pool["attractions"]):
                # Sắp xếp theo candidate_rank (thấp = tốt hơn) và giữ top-K
                pool["attractions"] = sorted(
                    pool["attractions"], key=lambda p: p.candidate_rank
                )[:n_keep_attractions]

    # ────────────────────────────────────────────────────────────────────
    # HELPERS
    # ────────────────────────────────────────────────────────────────────

    @staticmethod
    def _round_travel_minutes(minutes: int | float) -> int:
        value = max(0, int(math.ceil(float(minutes))))
        return int(math.ceil(value / 5.0) * 5) if value > 0 else 0

    @staticmethod
    def _haversine_km(lat1: float, lng1: float, lat2: float, lng2: float) -> float:
        """Great-circle distance in km."""
        R = 6371.0
        rlat1, rlng1 = math.radians(lat1), math.radians(lng1)
        rlat2, rlng2 = math.radians(lat2), math.radians(lng2)
        dlat = rlat2 - rlat1
        dlng = rlng2 - rlng1
        a = (
            math.sin(dlat / 2) ** 2
            + math.cos(rlat1) * math.cos(rlat2) * math.sin(dlng / 2) ** 2
        )
        return 2 * R * math.atan2(math.sqrt(a), math.sqrt(1 - a))

    @staticmethod
    def _haversine_minutes(
        lat1: float,
        lng1: float,
        lat2: float,
        lng2: float,
        speed_kmh: float = 30,
    ) -> int:
        """Haversine distance → phút di chuyển, +5 phút overhead."""
        R = 6371
        rlat1, rlng1 = math.radians(lat1), math.radians(lng1)
        rlat2, rlng2 = math.radians(lat2), math.radians(lng2)
        dlat = rlat2 - rlat1
        dlng = rlng2 - rlng1
        a = (
            math.sin(dlat / 2) ** 2
            + math.cos(rlat1) * math.cos(rlat2) * math.sin(dlng / 2) ** 2
        )
        km = 2 * R * math.atan2(math.sqrt(a), math.sqrt(1 - a))
        return int(km / speed_kmh * 60) + 5

    @staticmethod
    def _centroid(places: list) -> Optional[Tuple[float, float]]:
        """Geographic centroid of a non-empty list of places."""
        if not places:
            return None
        lat = sum(p.latitude for p in places) / len(places)
        lng = sum(p.longitude for p in places) / len(places)
        return (lat, lng)

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
