from __future__ import annotations

import datetime
import math
from dataclasses import dataclass
from typing import Dict, List, Optional, Tuple

from app.services.itinerary.assignment import AssignmentConfig, AssignmentModule, AssignmentResult
from app.services.itinerary import planner

try:
    from ortools.sat.python import cp_model
except Exception:  # pragma: no cover - handled at runtime for clear diagnostics
    cp_model = None


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


class SchedulerV2Planner:
    """
    Scheduler v2: pre-allocation + independent CP-SAT day solver.

    This is intentionally side-by-side with the current GA planner. It shares
    the same input/output dataclasses so console reports and preview JSON can
    compare both engines without changing the mobile UI flow.
    """

    def __init__(self, config: SchedulerV2Config):
        if cp_model is None:
            raise RuntimeError("OR-Tools is not installed. Install ai-service requirements before using scheduler_v2.")
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
        self.travel_vehicle = config.travel_vehicle if config.travel_vehicle in planner.TRANSPORT_COST_PER_KM else "car"
        self.cost_per_km = planner.TRANSPORT_COST_PER_KM.get(self.travel_vehicle, planner.TRANSPORT_COST_DEFAULT)

        total_candidates = max(1, len(self.places))
        for rank, place in enumerate(self.places):
            if place.candidate_total <= 1 and total_candidates > 1:
                place.candidate_rank = rank
                place.candidate_total = total_candidates

        hotels = [place for place in self.places if place.place_type == "hotel"]
        if not hotels:
            raise ValueError("No hotels found in places list.")
        self.adult_count = max(1, int(config.adult_count or 1))
        self.child_count = max(0, int(config.child_count or 0))
        self.full_people = self.adult_count + self.child_count
        self.adult_equivalent = self.adult_count + self.child_count * planner.CHILD_COST_FACTOR
        self.rooms = max(1, math.ceil(self.full_people / planner.ROOM_CAPACITY))
        self.budget_per_person = max(0.0, float(config.budget_per_person or 0))
        self.trip_budget = self.budget_per_person * self.full_people

        if config.selected_hotel_id:
            hotel_place = next((p for p in hotels if p.id == config.selected_hotel_id), None)
            if hotel_place is None:
                raise ValueError(f"Hotel '{config.selected_hotel_id}' not found in places list.")
        else:
            hotel_place = self._select_hotel(hotels)
        self.hotel_place = hotel_place
        self.hotel = hotel_place.to_hotel()

        try:
            self.start_date = (
                datetime.date.fromisoformat(config.trip_start_date)
                if config.trip_start_date
                else datetime.date.today()
            )
        except ValueError:
            self.start_date = datetime.date.today()

        self.attractions = [
            p for p in self.places if p.place_type in {"attraction", "cafe", "entertainment"}
        ]
        self.restaurants = [p for p in self.places if p.place_type == "restaurant"]
        self.target_pois_per_day = self._target_pois_per_day()
        self.target_nonmeal_per_day = max(1, self.target_pois_per_day - 1)
        self.hotel_total_cost = self._hotel_total_cost(hotel_place)
        residual_budget = max(0.0, self.trip_budget - self.hotel_total_cost)
        self.daily_budget = residual_budget / self.num_days if self.num_days > 0 else 0.0
        self.assignment_result = self._preallocate_days()

    def run(self, seed: Optional[int] = None) -> planner.MultiDayResult:
        del seed
        day_results: List[planner.DayResult] = []
        start_day_idx = self.start_date.weekday()
        for day_idx in range(self.num_days):
            pool = self.assignment_result.day_pools[day_idx]
            daily_places = [*pool["attractions"], *pool["restaurants"]]
            weekday_idx = (start_day_idx + day_idx) % 7
            day_pois = [place.to_poi_for_day(weekday_idx) for place in daily_places]
            if not day_pois:
                day_results.append(
                    planner.DayResult(day=day_idx + 1, pois=[], ga_result=self._empty_day_result("no_daily_pois"))
                )
                continue
            day_result = self._solve_day(day_idx + 1, day_pois)
            day_results.append(planner.DayResult(day=day_idx + 1, pois=day_pois, ga_result=day_result))

        return planner.MultiDayResult(
            hotel=self.hotel,
            num_days=self.num_days,
            days=day_results,
            assignment_result=self.assignment_result,
        )

    def _solve_day(self, day_number: int, pois: List[planner.POI]) -> planner.GAResult:
        # Reuse GA helper methods for exact same travel buffers, cost, utility and source semantics.
        helper = planner.TSP_TW_GA(
            pois=pois,
            travel_times=self.travel_times,
            travel_distances=self.travel_distances,
            travel_sources=self.travel_sources,
            travel_reliability=self.travel_reliability,
            config=planner.TourConfig(start_time=self.day_start_time, end_time=self.day_end_time),
            start_location_id=self.hotel.id,
            greedy_fit=True,
            return_to_hotel=self.return_to_hotel,
            require_goong_edges=self.require_goong_edges,
            day_budget=self.daily_budget,
            adult_equivalent=self.adult_equivalent,
            travel_vehicle=self.travel_vehicle,
        )

        model = cp_model.CpModel()
        n = len(pois)
        selected = {i: model.NewBoolVar(f"sel_{i}") for i in range(1, n + 1)}
        arcs = []
        arc_vars = {}

        for i in range(0, n + 1):
            for j in range(0, n + 1):
                if i == j:
                    if i == 0:
                        continue
                    arcs.append([i, i, selected[i].Not()])
                    continue
                var = model.NewBoolVar(f"arc_{i}_{j}")
                arc_vars[(i, j)] = var
                arcs.append([i, j, var])
        model.AddCircuit(arcs)

        arrival = {i: model.NewIntVar(0, 24 * 60, f"arrival_{i}") for i in range(1, n + 1)}
        start = {i: model.NewIntVar(0, 24 * 60, f"start_{i}") for i in range(1, n + 1)}
        depart = {i: model.NewIntVar(0, 24 * 60, f"depart_{i}") for i in range(1, n + 1)}
        wait = {i: model.NewIntVar(0, 24 * 60, f"wait_{i}") for i in range(1, n + 1)}
        return_time = model.NewIntVar(0, 24 * 60, "return_time")

        travel_minutes: Dict[Tuple[int, int], int] = {}
        travel_distance: Dict[Tuple[int, int], float] = {}
        for i in range(0, n + 1):
            from_id = self.hotel.id if i == 0 else pois[i - 1].id
            for j in range(0, n + 1):
                if i == j:
                    continue
                to_id = self.hotel.id if j == 0 else pois[j - 1].id
                raw = helper._raw_travel(from_id, to_id)
                buffer, _ = helper._travel_buffer(from_id, to_id, raw, None)
                travel_minutes[(i, j)] = raw + buffer
                travel_distance[(i, j)] = helper._distance(from_id, to_id)

        for j in range(1, n + 1):
            poi = pois[j - 1]
            model.Add(start[j] >= arrival[j]).OnlyEnforceIf(selected[j])
            model.Add(wait[j] == start[j] - arrival[j]).OnlyEnforceIf(selected[j])
            model.Add(depart[j] == start[j] + max(0, int(poi.visit_duration))).OnlyEnforceIf(selected[j])
            model.Add(start[j] >= max(self.day_start_time, int(poi.open_time))).OnlyEnforceIf(selected[j])
            model.Add(depart[j] <= min(self.day_end_time, int(poi.close_time))).OnlyEnforceIf(selected[j])
            if poi.place_type == "restaurant":
                model.Add(start[j] >= planner.LUNCH_START).OnlyEnforceIf(selected[j])
                model.Add(start[j] <= planner.LUNCH_END).OnlyEnforceIf(selected[j])

        for (i, j), var in arc_vars.items():
            travel = travel_minutes[(i, j)]
            if i == 0 and j != 0:
                model.Add(arrival[j] >= self.day_start_time + travel).OnlyEnforceIf(var)
            elif i != 0 and j == 0:
                model.Add(return_time >= depart[i] + travel).OnlyEnforceIf(var)
            elif i != 0 and j != 0:
                model.Add(arrival[j] >= depart[i] + travel).OnlyEnforceIf(var)

        model.Add(return_time <= self.day_end_time)
        restaurant_nodes = [idx + 1 for idx, poi in enumerate(pois) if poi.place_type == "restaurant"]
        if restaurant_nodes:
            model.Add(sum(selected[i] for i in restaurant_nodes) == 1)

        target_max = min(n, max(1, self.target_pois_per_day))
        model.Add(sum(selected.values()) <= target_max)

        utility_terms = []
        travel_terms = []
        wait_terms = []
        activity_cost_terms = []
        transport_cost_terms = []
        for i, poi in enumerate(pois, start=1):
            utility_terms.append(int(round(helper._poi_utility(poi) * 10)) * selected[i])
            wait_terms.append(wait[i] * int(round(planner.WAIT_TIME_WEIGHT * 10)))
            activity_cost_terms.append(int(round(helper._poi_cost(poi))) * selected[i])
        for (i, j), var in arc_vars.items():
            travel_terms.append(travel_minutes[(i, j)] * int(round(planner.UTILITY_TRAVEL_WEIGHT * 10)) * var)
            transport_cost_terms.append(int(round(travel_distance[(i, j)] * self.cost_per_km)) * var)

        total_activity_cost = sum(activity_cost_terms)
        total_transport_cost = sum(transport_cost_terms)
        budget_overage = model.NewIntVar(0, 2_000_000_000, "budget_overage")
        if self.daily_budget > 0:
            model.Add(budget_overage >= total_activity_cost + total_transport_cost - int(round(self.daily_budget)))
        else:
            model.Add(budget_overage == 0)
        budget_units = model.NewIntVar(0, 2_000_000, "budget_units")
        model.AddDivisionEquality(budget_units, budget_overage, planner.BUDGET_OVERAGE_UNIT_VND)
        budget_penalty = budget_units * int(round(planner.BUDGET_PENALTY_WEIGHT * 10))
        model.Minimize(sum(travel_terms) + sum(wait_terms) + budget_penalty - sum(utility_terms))

        solver = cp_model.CpSolver()
        solver.parameters.max_time_in_seconds = self.config.max_solve_seconds_per_day
        solver.parameters.num_search_workers = 8
        status = solver.Solve(model)
        if status not in (cp_model.OPTIMAL, cp_model.FEASIBLE):
            return self._empty_day_result(f"cpsat_no_solution_day_{day_number}")

        route_nodes = self._extract_route_nodes(n, arc_vars, solver)
        return self._build_result_from_route(
            pois=pois,
            helper=helper,
            route_nodes=route_nodes,
            selected_indices=[node - 1 for node in route_nodes],
            arrival=arrival,
            start=start,
            depart=depart,
            solver=solver,
            stopped_reason="cpsat_optimal" if status == cp_model.OPTIMAL else "cpsat_feasible",
        )

    def _extract_route_nodes(self, n: int, arc_vars: dict, solver) -> List[int]:
        next_by_node: dict[int, int] = {}
        for (i, j), var in arc_vars.items():
            if solver.BooleanValue(var):
                next_by_node[i] = j
        route = []
        current = next_by_node.get(0, 0)
        guard = 0
        while current != 0 and guard <= n:
            route.append(current)
            current = next_by_node.get(current, 0)
            guard += 1
        return route

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
            buffer, buffer_source = helper._travel_buffer(current_id, poi.id, raw, None)
            travel = raw + buffer
            distance = helper._distance(current_id, poi.id)
            wait_minutes = max(0, solver.Value(start[node]) - solver.Value(arrival[node]))
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

        if self.return_to_hotel and schedule and current_id != self.hotel.id:
            raw = helper._raw_travel(current_id, self.hotel.id)
            buffer, buffer_source = helper._travel_buffer(current_id, self.hotel.id, raw, None)
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
        budget_overage = max(0.0, total_day_cost - self.daily_budget) if self.daily_budget > 0 else 0.0
        budget_penalty = (budget_overage / planner.BUDGET_OVERAGE_UNIT_VND) * planner.BUDGET_PENALTY_WEIGHT
        actual_time = total_travel + total_visit + total_wait
        idle_time = max(0, (self.day_end_time - self.day_start_time) - actual_time)
        meal_violations = 1 if any(p.place_type == "restaurant" for p in pois) and restaurant_count == 0 else 0
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
            budget_limit=self.daily_budget,
            budget_overage=budget_overage,
            budget_penalty=budget_penalty,
            skipped_count=max(0, len(pois) - len(selected_indices)),
            idle_time=idle_time,
            generation_found=0,
            generations_run=1,
            stopped_reason=stopped_reason,
            visited_poi_indices=selected_indices,
        )

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
            budget_limit=self.daily_budget,
            budget_overage=0.0,
            budget_penalty=0.0,
            skipped_count=0,
            idle_time=max(0, self.day_end_time - self.day_start_time),
            generation_found=0,
            generations_run=0,
            stopped_reason=reason,
            visited_poi_indices=[],
        )

    def _preallocate_days(self) -> AssignmentResult:
        assignment = AssignmentModule(
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

    def _target_pois_per_day(self) -> int:
        available_minutes = max(0, self.day_end_time - self.day_start_time)
        time_target = max(
            planner.POI_TARGET_MIN_PER_DAY,
            math.floor(available_minutes / planner.POI_TARGET_TIME_SLICE_MINUTES),
        )
        time_target = min(planner.POI_TARGET_MAX_PER_DAY, time_target)
        candidate_avg = math.ceil((len(self.attractions) + len(self.restaurants)) / max(1, self.num_days))
        if candidate_avg <= 0:
            return planner.POI_TARGET_MIN_PER_DAY
        return max(1, min(time_target, candidate_avg))

    def _hotel_total_cost(self, hotel: planner.Place) -> float:
        nightly = hotel.estimated_cost if hotel.estimated_cost > 0 else planner.FALLBACK_HOTEL_COST_PER_NIGHT
        nights = max(1, self.num_days - 1)
        return nightly * nights * self.rooms

    def _select_hotel(self, hotels: List[planner.Place]) -> planner.Place:
        if self.trip_budget <= 0:
            return min(hotels, key=lambda hotel: hotel.candidate_rank)
        target_hotel_budget = self.trip_budget * 0.40
        return min(
            hotels,
            key=lambda hotel: (
                max(0.0, self._hotel_total_cost(hotel) - target_hotel_budget) / planner.BUDGET_OVERAGE_UNIT_VND,
                hotel.candidate_rank,
            ),
        )
