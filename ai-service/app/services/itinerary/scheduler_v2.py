from __future__ import annotations

import datetime
import math
from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import dataclass
from typing import Dict, List, Optional, Tuple

from app.services.itinerary.assignment import AssignmentResult
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
    day_start_time: int
    day_end_time: int
    return_to_hotel: bool
    require_goong_edges: bool
    budget_per_person: float
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
        self.rooms = max(1, math.ceil(self.full_people / planner.ROOM_CAPACITY))
        self.budget_per_person = max(0.0, float(config.budget_per_person or 0))
        self.trip_budget = self.budget_per_person * self.full_people

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
        self.hotel_total_cost = self._hotel_total_cost(hotel_place)
        residual_budget = max(0.0, self.trip_budget - self.hotel_total_cost)
        self.trip_residual_budget = residual_budget
        self.daily_budget_soft = (
            residual_budget / self.num_days if self.num_days > 0 else 0.0
        )

        # ── Cluster ──
        self.assignment_result = self._preallocate_days()

    # ────────────────────────────────────────────────────────────────────
    # PUBLIC: run
    # ────────────────────────────────────────────────────────────────────

    def run(self, seed: Optional[int] = None) -> planner.MultiDayResult:
        del seed
        start_day_idx = self.start_date.weekday()

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
        workers = min(self.num_days, 4)
        with ThreadPoolExecutor(max_workers=workers) as executor:
            futures = {
                executor.submit(solve_one_day, d): d
                for d in range(self.num_days)
            }
            results_map: dict[int, planner.DayResult] = {}
            for future in as_completed(futures):
                day_idx = futures[future]
                results_map[day_idx] = future.result()

        day_results = [results_map[d] for d in range(self.num_days)]
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

    # ────────────────────────────────────────────────────────────────────
    # FALLBACK CHAIN
    # ────────────────────────────────────────────────────────────────────

    def _solve_day_with_fallback(
        self,
        day_number: int,
        pois: List[planner.POI],
        is_day_1: bool,
    ) -> planner.GAResult:
        """
        Solve with fallback chain:
          1. Strict lunch window + 10% budget tolerance
          2. Relaxed lunch window (±30 min) + 20% budget tolerance
          3. No lunch constraint + 35% budget tolerance
          4. Greedy fallback
        """
        # PRE-PRUNING
        pruned_pois = []
        for p in pois:
            if p.open_time >= self.day_end_time or p.close_time <= self.day_start_time:
                continue
            p_cost = getattr(p, "estimated_cost", 0)
            if self.daily_budget_soft > 0 and p_cost > self.daily_budget_soft * 1.5:
                total = max(1, p.candidate_total)
                bounded_rank = min(max(p.candidate_rank, 0), total - 1)
                rank_score = 1.0 - (bounded_rank / total)
                rating_score = min(max(p.rating, 0.0), 5.0) / 5.0
                two_tower_score = planner.ALPHA_DEFAULT * rank_score + (1 - planner.ALPHA_DEFAULT) * rating_score
                if two_tower_score <= 0.8:
                    continue
            pruned_pois.append(p)
        pois = pruned_pois
        
        # Limit to top 10
        if len(pois) > 10:
            pois = sorted(pois, key=lambda x: getattr(x, "candidate_rank", 100))[:10]

        # Xác định có enforce lunch hay không
        if is_day_1:
            day1_start = self.config.check_in_time or self.day_start_time
            enforce_lunch_base = day1_start <= LUNCH_ENFORCE_CUTOFF
        else:
            enforce_lunch_base = True

        lunch_win = (planner.LUNCH_START, planner.LUNCH_END)

        # ── Attempt 1: strict lunch ──
        if enforce_lunch_base:
            result = self._solve_day_core(
                day_number, pois, is_day_1,
                enforce_lunch=True, lunch_window=lunch_win, budget_tolerance_ratio=0.00
            )
            if result is not None:
                return result

            # ── Attempt 2: relaxed lunch ±30 min ──
            relaxed = (lunch_win[0] - 30, lunch_win[1] + 30)
            result = self._solve_day_core(
                day_number, pois, is_day_1,
                enforce_lunch=True, lunch_window=relaxed, budget_tolerance_ratio=0.05
            )
            if result is not None:
                return result

        # ── Attempt 3: no lunch ──
        result = self._solve_day_core(
            day_number, pois, is_day_1,
            enforce_lunch=False, lunch_window=None, budget_tolerance_ratio=0.15
        )
        if result is not None:
            return result

        # ── Attempt 4: greedy fallback ──
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
                pois, helper, day_start, enforce_lunch, lunch_window, budget_tolerance_ratio
            )
        return self._build_circuit_model(
            day_number, pois, helper, day_start, enforce_lunch, lunch_window, budget_tolerance_ratio
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
                    travel_minutes[(i, j)] = raw + buf
                    travel_distance[(i, j)] = helper._distance(from_id, to_id)
            # place → hotel
            raw = helper._raw_travel(from_id, self.hotel.id)
            buf, _ = helper._travel_buffer(from_id, self.hotel.id, raw, None)
            travel_minutes[(i, HOTEL)] = raw + buf
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
            
            # Hard limit wait time
            max_wait_allowed = 45 if poi.place_type == "restaurant" else 90
            model.Add(wait[j] <= max_wait_allowed).OnlyEnforceIf(selected[j])
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
            if (
                poi.place_type == "restaurant"
                and enforce_lunch
                and lunch_window
            ):
                model.Add(
                    start_var[j] >= lunch_window[0]
                ).OnlyEnforceIf(selected[j])
                model.Add(
                    start_var[j] <= lunch_window[1]
                ).OnlyEnforceIf(selected[j])

        if enforce_lunch and lunch_window:
            if lunch_flags:
                model.Add(sum(lunch_flags) >= 1)

        # ── Arc time propagation ──
        for (i, j), var in arc_vars.items():
            if i == VSTART and 1 <= j <= n:
                model.Add(
                    arrival[j] >= day_start + travel_minutes[(VSTART, j)]
                ).OnlyEnforceIf(var)
            elif 1 <= i <= n and j == HOTEL:
                model.Add(
                    return_time == depart[i] + travel_minutes[(i, HOTEL)]
                ).OnlyEnforceIf(var)
            elif 1 <= i <= n and 1 <= j <= n:
                model.Add(
                    arrival[j] >= depart[i]
                    + travel_minutes.get((i, j), 30)
                ).OnlyEnforceIf(var)

        model.Add(return_time <= self.day_end_time)

        # ── Restaurant constraint ──
        restaurant_nodes = [
            idx + 1
            for idx, poi in enumerate(pois)
            if poi.place_type == "restaurant"
        ]
        if restaurant_nodes:
            model.Add(sum(selected[i] for i in restaurant_nodes) <= 2)

        # ── Max/Min POIs ──
        target_max = min(n, max(1, self.target_pois_per_day))
        target_min = 1
        model.Add(sum(selected.values()) <= target_max)
        model.Add(sum(selected.values()) >= target_min)

        # ── Objective ──
        self._add_objective(
            model, n, pois, selected, wait,
            arc_vars, travel_minutes, travel_distance, helper, budget_tolerance_ratio
        )

        # ── Solve ──
        solver = cp_model.CpSolver()
        solver.parameters.max_time_in_seconds = 1.5
        solver.parameters.num_search_workers = 8
        status = solver.Solve(model)
        if status not in (cp_model.OPTIMAL, cp_model.FEASIBLE):
            return None

        route_nodes = self._extract_path_nodes(n, VSTART, HOTEL, arc_vars, solver)
        reason = (
            "cpsat_optimal" if status == cp_model.OPTIMAL else "cpsat_feasible"
        )
        if not enforce_lunch or not lunch_flags:
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
                travel_minutes[(i, j)] = raw + buf
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
            
            # Hard limit wait time
            max_wait_allowed = 45 if poi.place_type == "restaurant" else 90
            model.Add(wait[j] <= max_wait_allowed).OnlyEnforceIf(selected[j])
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
            if (
                poi.place_type == "restaurant"
                and enforce_lunch
                and lunch_window
            ):
                lunch_flag = model.NewBoolVar(f"lunch_flag_{j}")
                model.Add(start_var[j] >= lunch_window[0]).OnlyEnforceIf(lunch_flag)
                model.Add(start_var[j] <= lunch_window[1]).OnlyEnforceIf(lunch_flag)
                model.AddImplication(lunch_flag, selected[j])
                lunch_flags.append(lunch_flag)

        if enforce_lunch and lunch_window:
            if lunch_flags:
                model.Add(sum(lunch_flags) >= 1)

        # ── Arc time propagation ──
        for (i, j), var in arc_vars.items():
            travel = travel_minutes[(i, j)]
            if i == 0 and j != 0:
                model.Add(
                    arrival[j] >= day_start + travel
                ).OnlyEnforceIf(var)
            elif i != 0 and j == 0:
                model.Add(
                    return_time == depart[i] + travel
                ).OnlyEnforceIf(var)
            elif i != 0 and j != 0:
                model.Add(
                    arrival[j] >= depart[i] + travel
                ).OnlyEnforceIf(var)

        model.Add(return_time <= self.day_end_time)

        # ── Restaurant constraint ──
        restaurant_nodes = [
            idx + 1
            for idx, poi in enumerate(pois)
            if poi.place_type == "restaurant"
        ]
        if restaurant_nodes:
            model.Add(sum(selected[i] for i in restaurant_nodes) <= 2)

        # ── Max/Min POIs ──
        target_max = min(n, max(1, self.target_pois_per_day))
        target_min = 1
        model.Add(sum(selected.values()) <= target_max)
        model.Add(sum(selected.values()) >= target_min)

        # ── Objective ──
        self._add_objective(
            model, n, pois, selected, wait,
            arc_vars, travel_minutes, travel_distance, helper, budget_tolerance_ratio
        )

        # ── Solve ──
        solver = cp_model.CpSolver()
        solver.parameters.max_time_in_seconds = 1.5
        solver.parameters.num_search_workers = 8
        status = solver.Solve(model)
        if status not in (cp_model.OPTIMAL, cp_model.FEASIBLE):
            return None

        route_nodes = self._extract_route_nodes(n, arc_vars, solver)
        reason = (
            "cpsat_optimal" if status == cp_model.OPTIMAL else "cpsat_feasible"
        )
        if not enforce_lunch or not lunch_flags:
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
        wait: dict,
        arc_vars: dict,
        travel_minutes: dict,
        travel_distance: dict,
        helper,
        budget_tolerance_ratio: float,
    ) -> None:
        utility_terms = []
        travel_terms = []
        wait_terms = []
        skipped_terms = []
        activity_cost_terms = []
        transport_cost_terms = []

        daily_budget_per_person = self.budget_per_person / max(1, self.num_days)
        user_tier = "low"
        if daily_budget_per_person >= 1200000:
            user_tier = "high"
        elif daily_budget_per_person >= 500000:
            user_tier = "medium"

        for i, poi in enumerate(pois, start=1):
            poi_cost = helper._poi_cost(poi)
            cost_per_person = poi_cost / max(1, self.full_people)
            poi_price_tier = "cheap"
            if cost_per_person >= 500000:
                poi_price_tier = "premium"
            elif cost_per_person >= 100000:
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
            poi_reward = int(round(two_tower_score * 1000))
            stay_penalty = int(poi.visit_duration)
            effective_reward = poi_reward + price_fit_bonus - premium_low_score_penalty - cost_penalty - stay_penalty

            utility_terms.append(effective_reward * selected[i])
            wait_terms.append(wait[i] * 30)
            skipped_terms.append(2000 * selected[i].Not())
            activity_cost_terms.append(int(round(poi_cost)) * selected[i])

        for (i, j), var in arc_vars.items():
            tm = travel_minutes.get((i, j), 0)
            td = travel_distance.get((i, j), 0.0)
            travel_terms.append(
                tm * 2 * var
            )
            transport_cost_terms.append(
                int(round(td * self.cost_per_km)) * var
            )

        # Budget: soft penalty tính theo đơn vị 1k VND vượt ngân sách/ngày.
        # Dùng O(n) approximation cho transport cost thay vì tổng qua arc_vars (O(n²)).
        # Xấp xỉ: mỗi POI được chọn đóng góp transport ≈ dist(hotel, place) × cost_per_km.
        # Giữ nguyên độ chính xác thực tế (transport << activity cost) nhưng giảm LP complexity.
        budget_unit = planner.BUDGET_OVERAGE_UNIT_VND  # 1_000 VND
        daily_budget_k = max(0, int(self.daily_budget_soft) // budget_unit)

        activity_cost_k = sum(
            (int(round(helper._poi_cost(pois[i - 1]))) // budget_unit) * selected[i]
            for i in range(1, n + 1)
        )
        # O(n): xấp xỉ transport theo khoảng cách 1 chiều hotel→place mỗi POI được chọn
        transport_cost_k = sum(
            (int(round(
                helper._distance(self.hotel.id, pois[i - 1].id) * self.cost_per_km
            )) // budget_unit) * selected[i]
            for i in range(1, n + 1)
        )

        if daily_budget_k > 0:
            max_allowed_cost_k = int(daily_budget_k * (1 + budget_tolerance_ratio))
            model.Add(activity_cost_k + transport_cost_k <= max_allowed_cost_k)

        budget_k_overage = model.NewIntVar(0, 2_000_000, "budget_k_overage")
        if self.daily_budget_soft > 0:
            model.Add(budget_k_overage >= activity_cost_k + transport_cost_k - daily_budget_k)
        else:
            model.Add(budget_k_overage == 0)

        # weight = BUDGET_PENALTY_WEIGHT (3) — 1 đơn vị penalty mỗi 1k VND vượt budget
        budget_penalty = budget_k_overage * 2  # equivalent to excess // 500

        model.Minimize(
            sum(travel_terms)
            + sum(wait_terms)
            + budget_penalty
            + sum(skipped_terms)
            - sum(utility_terms)
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
            travel = raw + buffer
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
            travel = raw + buffer
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
            if self.daily_budget_soft > 0
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
        selected_indices: list[int] = []

        for idx, poi in sorted_pois:
            raw = helper._raw_travel(current_id, poi.id)
            buf, buffer_source = helper._travel_buffer(
                current_id, poi.id, raw, None
            )
            travel = raw + buf
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
                if departure + raw_to_hotel + buf_to_hotel > self.day_end_time:
                    continue
            wait_minutes = max(0, service_start - arrival_t)
            if poi.place_type == "restaurant" and restaurant_count >= 2:
                continue
            if wait_minutes > planner.MAX_NON_MEAL_WAIT_MINUTES:
                continue
            poi_cost = helper._poi_cost(poi)
            
            if self.daily_budget_soft > 0:
                if total_activity_cost + poi_cost > self.daily_budget_soft * 1.05:
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
            travel = raw + buf
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
            if self.daily_budget_soft > 0
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
    # K-MEANS CLUSTERING
    # ────────────────────────────────────────────────────────────────────

    def _preallocate_days(self) -> AssignmentResult:
        """
        K-Means clustering có ràng buộc:
        - Feature: [lat, lng, dist_to_hotel * 0.3]
        - Hotel là trung tâm (centroid gợi ý)
        - Sau cluster: đảm bảo mỗi ngày có ≥ 1 restaurant
        """
        candidates = self.attractions + self.restaurants
        if not candidates or self.num_days <= 0:
            return AssignmentResult(
                day_pools=[
                    {"attractions": [], "restaurants": []}
                    for _ in range(self.num_days)
                ],
                day_loads=[0] * self.num_days,
            )

        # Fallback: round-robin nếu sklearn không có hoặc quá ít candidates
        if not _sklearn_available or len(candidates) < self.num_days:
            return self._round_robin_assign(candidates)

        hotel_lat = self.hotel_place.latitude
        hotel_lng = self.hotel_place.longitude
        features = []
        for p in candidates:
            # Scale lat/lng to kilometers relative to hotel
            d_lat_km = (p.latitude - hotel_lat) * 111.0
            d_lng_km = (p.longitude - hotel_lng) * 111.0 * math.cos(math.radians(hotel_lat))
            dist_hotel_km = math.sqrt(d_lat_km**2 + d_lng_km**2)
            
            features.append([d_lat_km, d_lng_km, dist_hotel_km * 0.2])

        features_np = np.array(features)
        n_clusters = min(self.num_days, len(candidates))

        init_centers = "k-means++"
        if len(self.restaurants) >= n_clusters and n_clusters > 0:
            # Lấy top n_clusters nhà hàng tốt nhất (dựa trên candidate_rank)
            top_restaurants = sorted(self.restaurants, key=lambda p: p.candidate_rank)[:n_clusters]
            init_list = []
            for r in top_restaurants:
                d_lat_km = (r.latitude - hotel_lat) * 111.0
                d_lng_km = (r.longitude - hotel_lng) * 111.0 * math.cos(math.radians(hotel_lat))
                dist_hotel_km = math.sqrt(d_lat_km**2 + d_lng_km**2)
                init_list.append([d_lat_km, d_lng_km, dist_hotel_km * 0.2])
            init_centers = np.array(init_list)

        if isinstance(init_centers, str):
            km = KMeans(n_clusters=n_clusters, random_state=42, n_init=10)
        else:
            km = KMeans(n_clusters=n_clusters, random_state=42, init=init_centers, n_init=1)

        labels = km.fit_predict(features_np)

        day_pools: list[dict] = [
            {"attractions": [], "restaurants": []}
            for _ in range(self.num_days)
        ]
        for idx, place in enumerate(candidates):
            day_idx = int(labels[idx])
            if place.place_type == "restaurant":
                day_pools[day_idx]["restaurants"].append(place)
            else:
                day_pools[day_idx]["attractions"].append(place)

        self._balance_day_pools(day_pools)
        self._ensure_restaurant_per_day(day_pools)
        self._trim_day_pools(day_pools)
        day_loads = [self._day_load(pool) for pool in day_pools]
        warnings = [
            f"kmeans_v2 n_clusters={n_clusters} "
            f"candidates={len(candidates)}"
        ]
        return AssignmentResult(
            day_pools=day_pools, day_loads=day_loads, warnings=warnings
        )

    def _round_robin_assign(
        self, candidates: list
    ) -> AssignmentResult:
        """Fallback round-robin khi sklearn không khả dụng."""
        day_pools: list[dict] = [
            {"attractions": [], "restaurants": []}
            for _ in range(self.num_days)
        ]
        for idx, place in enumerate(candidates):
            day_idx = idx % self.num_days
            if place.place_type == "restaurant":
                day_pools[day_idx]["restaurants"].append(place)
            else:
                day_pools[day_idx]["attractions"].append(place)
        self._ensure_restaurant_per_day(day_pools)
        day_loads = [self._day_load(pool) for pool in day_pools]
        return AssignmentResult(
            day_pools=day_pools,
            day_loads=day_loads,
            warnings=["round_robin_fallback"],
        )

    def _ensure_restaurant_per_day(self, day_pools: list) -> None:
        """Hoán đổi restaurant gần nhất từ ngày thừa sang ngày thiếu."""
        for day_idx, pool in enumerate(day_pools):
            if pool["restaurants"]:
                continue
            best_donor: Optional[int] = None
            best_restaurant = None
            best_dist = float("inf")
            for donor_idx, donor_pool in enumerate(day_pools):
                if donor_idx == day_idx or len(donor_pool["restaurants"]) <= 1:
                    continue
                for r in donor_pool["restaurants"]:
                    if pool["attractions"]:
                        avg_dist = sum(
                            self._haversine_minutes(
                                r.latitude, r.longitude,
                                a.latitude, a.longitude,
                            )
                            for a in pool["attractions"]
                        ) / len(pool["attractions"])
                    else:
                        avg_dist = self._haversine_minutes(
                            r.latitude,
                            r.longitude,
                            self.hotel_place.latitude,
                            self.hotel_place.longitude,
                        )
                    if avg_dist < best_dist:
                        best_dist = avg_dist
                        best_donor = donor_idx
                        best_restaurant = r
            if best_restaurant is not None and best_donor is not None:
                day_pools[best_donor]["restaurants"].remove(best_restaurant)
                day_pools[day_idx]["restaurants"].append(best_restaurant)

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
            if len(pool["restaurants"]) > 3:
                pool["restaurants"] = sorted(
                    pool["restaurants"], key=lambda p: p.candidate_rank
                )[:3]
                
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
        nightly = (
            hotel.estimated_cost
            if hotel.estimated_cost > 0
            else planner.FALLBACK_HOTEL_COST_PER_NIGHT
        )
        nights = max(1, self.num_days - 1)
        return nightly * nights * self.rooms

    def _select_hotel(self, hotels: List[planner.Place]) -> planner.Place:
        """Chọn hotel có score cao nhất (candidate_rank thấp nhất)."""
        return min(hotels, key=lambda h: h.candidate_rank)

    @staticmethod
    def _day_load(pool: dict) -> int:
        """Tổng thời gian dự kiến cho 1 ngày (phút)."""
        total = 0
        for place in pool.get("attractions", []):
            total += max(30, int(getattr(place, "visit_duration", 60)))
        for place in pool.get("restaurants", []):
            total += max(30, int(getattr(place, "visit_duration", 60)))
        return total
