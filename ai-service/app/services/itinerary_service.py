from __future__ import annotations

import datetime
import logging
import time
from typing import Any

from app.core.config import settings
from app.schemas.itinerary import (
    ItineraryDayResponse,
    ItineraryPlanRequest,
    ItineraryPlanResponse,
    ScheduleEntryResponse,
)
from app.services.itinerary import planner
from app.services.itinerary.scheduler_v2 import (
    BEST_TIME_WINDOWS,
    SchedulerV2Config,
    SchedulerV2Planner,
)
from app.services.itinerary.validator import FeasibilityValidator, ValidationResult

logger = logging.getLogger(__name__)
FOOD_CATEGORY_ID = "97029cfb-069b-4dba-a152-dfb3d36634d3"


def plan_itinerary(req: ItineraryPlanRequest) -> ItineraryPlanResponse:
    started_at = time.perf_counter()
    trip_start_date = _parse_trip_start_date(req.trip_start_date)
    places = [
        _to_planner_place(item.model_dump(), day_idx=0, start_date=trip_start_date)
        for item in req.places
    ]
    if not any(place.place_type == "hotel" for place in places):
        raise ValueError("No real hotel/accommodation place provided for itinerary planning.")

    hotels = [place for place in places if place.place_type == "hotel"]
    restaurants = [place for place in places if place.place_type == "restaurant"]
    attractions = [place for place in places if place.place_type == "attraction"]
    logger.info(
        "[Planner] input_places=%s hotels=%s restaurants=%s attractions=%s days=%s",
        len(places),
        len(hotels),
        len(restaurants),
        len(attractions),
        req.num_days,
    )

    coords = {place.id: (place.longitude, place.latitude) for place in places}
    travel_cache = req.travel_cache_path or planner.TRAVEL_CACHE_PATH

    # Fallback to settings if not provided in request
    goong_key = req.goong_api_key or settings.goong_api_key
    if not req.use_goong:
        goong_key = ""

    if not goong_key and req.require_goong:
        logger.warning("[Planner] require_goong=True but no GOONG_API_KEY. Using Haversine fallback.")
    elif goong_key:
        logger.info("[Planner] Using Goong Distance Matrix API (vehicle=%s)", req.travel_vehicle)
    else:
        logger.info("[Planner] No Goong config. Using Haversine fallback (speed=%.1f km/h)", req.speed_kmh)

    engine_name = (req.planner_engine or "ga_v1").strip().lower()
    if engine_name not in {"ga_v1", "scheduler_v2", "compare"}:
        raise ValueError("planner_engine must be one of: ga_v1, scheduler_v2, compare.")

    matrix_started_at = time.perf_counter()
    try:
        # Scheduler v2 first builds a cheap complete matrix from cache/Haversine
        # for clustering, then refreshes only the smaller per-day route pools
        # from Goong after assignment.
        initial_matrix_key = "" if engine_name in {"scheduler_v2", "compare"} else goong_key
        travel_times, travel_distances, travel_sources, travel_reliability = planner.build_travel_matrix(
            coords,
            api_key=initial_matrix_key,
            vehicle=req.travel_vehicle,
            cache_path=travel_cache,
            speed_kmh=req.speed_kmh,
            require_goong=req.require_goong,
        )
    except Exception as e:
        logger.exception("[Planner] Travel matrix calculation failed (Goong API/Haversine)")
        raise RuntimeError(f"Travel matrix calculation failed: {str(e)}") from e

    matrix_ms = round((time.perf_counter() - matrix_started_at) * 1000)
    comparison = None
    if engine_name == "compare":
        ga_result, ga_ms, ga_validation = _run_ga_engine(
            req, places, travel_times, travel_distances, travel_sources, travel_reliability
        )
        scheduler_result, scheduler_ms, scheduler_validation = _run_scheduler_v2_engine(
            req, places, travel_times, travel_distances, travel_sources,
            travel_reliability, goong_key
        )
        ga_result.validation_result = ga_validation
        scheduler_result.validation_result = scheduler_validation
        comparison = {
            "engines": {
                "ga_v1": _summarize_result(ga_result, ga_ms, ga_validation),
                "scheduler_v2": _summarize_result(scheduler_result, scheduler_ms, scheduler_validation),
            },
            "winner_hint": _winner_hint(ga_result, scheduler_result),
        }
        _log_result("GA_V1", ga_result, ga_ms)
        _log_result("SCHEDULER_V2", scheduler_result, scheduler_ms)
        try:
            _print_comparison(ga_result, scheduler_result, comparison)
        except UnicodeEncodeError as exc:
            logger.warning("[Planner] skipped comparison console print due to encoding: %s", exc)
        result = scheduler_result
        validation = scheduler_validation
        response_engine = "compare:scheduler_v2"
    elif engine_name == "scheduler_v2":
        result, scheduler_ms, validation = _run_scheduler_v2_engine(
            req, places, travel_times, travel_distances, travel_sources,
            travel_reliability, goong_key
        )
        result.validation_result = validation
        ga_ms = 0
        response_engine = "scheduler_v2"
        _log_result("SCHEDULER_V2", result, scheduler_ms)
    else:
        result, ga_ms, validation = _run_ga_engine(
            req, places, travel_times, travel_distances, travel_sources, travel_reliability
        )
        result.validation_result = validation
        scheduler_ms = ga_ms
        response_engine = "ga_v1"
        _log_result("GA_V1", result, ga_ms)
    total_ms = round((time.perf_counter() - started_at) * 1000)

    logger.info(
        "[Planner] completed engine=%s total=%sms matrix=%sms ga=%sms solver=%sms hotel=%s (%s)",
        response_engine,
        total_ms,
        matrix_ms,
        ga_ms,
        scheduler_ms,
        result.hotel.name,
        result.hotel.id,
    )
    try:
        planner.print_multi_day_schedule(result)
    except UnicodeEncodeError as exc:
        logger.warning("[Planner] skipped console schedule print due to encoding: %s", exc)
    return _serialize_result(
        result,
        input_places=len(req.places),
        total_ms=total_ms,
        matrix_ms=matrix_ms,
        ga_ms=ga_ms,
        planner_engine=response_engine,
        solver_ms=scheduler_ms,
        validation=validation,
        comparison=comparison,
        travel_source_counts={
            source: sum(1 for value in travel_sources.values() if value == source)
            for source in sorted(set(travel_sources.values()))
        },
    )


def _run_ga_engine(
    req: ItineraryPlanRequest,
    places: list[planner.Place],
    travel_times: dict,
    travel_distances: dict,
    travel_sources: dict,
    travel_reliability: dict,
) -> tuple[planner.MultiDayResult, int, ValidationResult]:
    started_at = time.perf_counter()
    engine = planner.MultiDayTripPlanner(
        places=places,
        num_days=req.num_days,
        travel_times=travel_times,
        travel_distances=travel_distances,
        travel_sources=travel_sources,
        travel_reliability=travel_reliability,
        selected_hotel_id=req.selected_hotel_id,
        hotel_total_cost=req.hotel_total_cost,
        day_start_time=planner.time_to_minutes(req.daily_start_time),
        day_end_time=planner.time_to_minutes(req.daily_end_time),
        population_size=req.population_size,
        generations=req.generations,
        mutation_rate=req.mutation_rate,
        return_to_hotel=req.return_to_hotel,
        require_goong_edges=req.require_goong,
        trip_budget_total=(
            req.trip_budget_total
            if req.trip_budget_total > 0
            else req.budget_per_person
        ),
        adult_count=req.adult_count,
        child_count=req.child_count,
        travel_vehicle=req.travel_vehicle,
        trip_start_date=req.trip_start_date,
    )
    try:
        result = engine.run(seed=req.seed)
    except Exception as e:
        logger.exception("[Planner] GA v1 failed")
        raise RuntimeError(f"GA v1 planning failed: {str(e)}") from e
    elapsed_ms = round((time.perf_counter() - started_at) * 1000)
    validation = FeasibilityValidator().validate(
        result,
        _build_places_map(places, req.num_days, _parse_trip_start_date(req.trip_start_date)),
        trip_budget_total=(
            req.trip_budget_total
            if req.trip_budget_total > 0
            else req.budget_per_person
        ),
        hotel_total_cost=req.hotel_total_cost,
    )
    return result, elapsed_ms, validation


def _run_scheduler_v2_engine(
    req: ItineraryPlanRequest,
    places: list[planner.Place],
    travel_times: dict,
    travel_distances: dict,
    travel_sources: dict,
    travel_reliability: dict,
    goong_api_key: str,
) -> tuple[planner.MultiDayResult, int, ValidationResult]:
    started_at = time.perf_counter()
    engine = SchedulerV2Planner(
        SchedulerV2Config(
            places=places,
            num_days=req.num_days,
            travel_times=travel_times,
            travel_distances=travel_distances,
            travel_sources=travel_sources,
            travel_reliability=travel_reliability,
            selected_hotel_id=req.selected_hotel_id,
            hotel_total_cost=req.hotel_total_cost,
            day_start_time=planner.time_to_minutes(req.daily_start_time),
            day_end_time=planner.time_to_minutes(req.daily_end_time),
            return_to_hotel=req.return_to_hotel,
            require_goong_edges=req.require_goong,
            trip_budget_total=(
                req.trip_budget_total
                if req.trip_budget_total > 0
                else req.budget_per_person
            ),
            adult_count=req.adult_count,
            child_count=req.child_count,
            travel_vehicle=req.travel_vehicle,
            trip_start_date=req.trip_start_date,
            check_in_time=planner.time_to_minutes(req.check_in_time) if req.check_in_time else None,
        )
    )
    try:
        planner.refresh_travel_matrix_for_day_pools(
            coords={
                place.id: (place.longitude, place.latitude)
                for place in places
            },
            day_pools=engine.assignment_result.day_pools,
            hotel_id=engine.hotel.id,
            travel_times=travel_times,
            travel_distances=travel_distances,
            travel_sources=travel_sources,
            travel_reliability=travel_reliability,
            api_key=goong_api_key,
            vehicle=req.travel_vehicle,
            cache_path=req.travel_cache_path or planner.TRAVEL_CACHE_PATH,
            speed_kmh=req.speed_kmh,
            require_goong=req.require_goong,
        )
        result = engine.run(seed=req.seed)
    except Exception as e:
        logger.exception("[Planner] scheduler_v2 failed")
        raise RuntimeError(f"scheduler_v2 planning failed: {str(e)}") from e
    elapsed_ms = round((time.perf_counter() - started_at) * 1000)
    validation = FeasibilityValidator().validate(
        result,
        _build_places_map(places, req.num_days, _parse_trip_start_date(req.trip_start_date)),
        trip_budget_total=(
            req.trip_budget_total
            if req.trip_budget_total > 0
            else req.budget_per_person
        ),
        hotel_total_cost=req.hotel_total_cost,
    )
    return result, elapsed_ms, validation


def _build_places_map(
    places: list[planner.Place],
    num_days: int,
    trip_start_date: datetime.date,
) -> dict:
    places_map: dict = {place.id: place for place in places}
    for day_idx in range(num_days):
        weekday_idx = (trip_start_date.weekday() + day_idx) % 7
        for place in places:
            places_map[(day_idx + 1, place.id)] = place.to_poi_for_day(weekday_idx)
    return places_map


def _summarize_result(
    result: planner.MultiDayResult,
    elapsed_ms: int,
    validation: ValidationResult | None,
) -> dict[str, Any]:
    days = []
    for i, day in enumerate(result.days):
        ga = day.ga_result
        day_visited = len(day.visited_pois)

        # Pull pool metadata (set by scheduler_v2; GA pools won't have these keys)
        pool_meta: dict = {}
        if result.assignment_result and i < len(result.assignment_result.day_pools):
            pool_meta = result.assignment_result.day_pools[i]

        base_candidates = pool_meta.get("base_candidate_count", len(day.pois))
        injected_restaurant_candidates = pool_meta.get("injected_restaurant_count", 0)
        final_candidates = pool_meta.get("final_candidate_count", len(day.pois))
        day_cluster_center = pool_meta.get("day_cluster_center")  # (lat, lng) or None
        cafe_filtered_count = pool_meta.get("cafe_filtered_count", 0)
        injected_reason = pool_meta.get("injected_reason")
        is_remote_day = pool_meta.get("is_remote_day", False)
        remote_anchor_name = pool_meta.get("remote_anchor_name")
        allocation_method = pool_meta.get("allocation_method", "kmeans")
        day_used_minutes = pool_meta.get("day_used_minutes")
        day_estimated_distance = pool_meta.get("day_estimated_distance")

        # Diagnostics
        available_minutes = (
            ga.total_travel_time + ga.total_visit_time + ga.total_wait_time + ga.idle_time
        )
        target_poi_count = max(1, round(available_minutes / 150)) if available_minutes > 0 else 1
        avg_minutes_per_poi = (available_minutes / max(1, day_visited)) if day_visited > 0 else 0
        used_minutes = ga.total_travel_time + ga.total_visit_time + ga.total_wait_time
        unused_minutes = ga.idle_time

        extra_penalty = _day_density_penalty(ga, day_visited)

        # Cluster-distance diagnostics — worst-case distance from cluster centroid
        # to pool restaurants/cafes (proxy for how far food stops stray from the day route)
        restaurant_dist_to_cluster = None
        cafe_dist_to_cluster = None
        if day_cluster_center and pool_meta:
            import math as _math

            def _hav(lat1: float, lng1: float, lat2: float, lng2: float) -> float:
                R = 6371.0
                dlat = _math.radians(lat2 - lat1)
                dlng = _math.radians(lng2 - lng1)
                a = (_math.sin(dlat / 2) ** 2
                     + _math.cos(_math.radians(lat1)) * _math.cos(_math.radians(lat2))
                     * _math.sin(dlng / 2) ** 2)
                return 2 * R * _math.atan2(_math.sqrt(a), _math.sqrt(1 - a))

            clat, clng = day_cluster_center
            r_dists = [
                _hav(p.latitude, p.longitude, clat, clng)
                for p in pool_meta.get("restaurants", [])
            ]
            c_dists = [
                _hav(p.latitude, p.longitude, clat, clng)
                for p in pool_meta.get("attractions", [])
                if getattr(p, "place_type", None) == "cafe"
            ]
            if r_dists:
                restaurant_dist_to_cluster = round(max(r_dists), 2)
            if c_dists:
                cafe_dist_to_cluster = round(max(c_dists), 2)

        days.append(
            {
                "day": day.day,
                # Candidate counts
                "base_candidates": base_candidates,
                "injected_restaurant_candidates": injected_restaurant_candidates,
                "candidates": final_candidates,      # final pool size (backward-compat key)
                "final_candidates": final_candidates,
                "cafe_filtered_count": cafe_filtered_count,
                # Visit counts
                "visited": day_visited,
                "restaurants": ga.restaurant_count,
                # Time
                "travel_minutes": ga.total_travel_time,
                "wait_minutes": ga.total_wait_time,
                "visit_minutes": ga.total_visit_time,
                "idle_minutes": ga.idle_time,
                # Diagnostics
                "available_minutes": available_minutes,
                "target_poi_count": target_poi_count,
                "avg_minutes_per_poi": round(avg_minutes_per_poi, 1),
                "used_minutes": used_minutes,
                "unused_minutes": unused_minutes,
                "extra_penalty": extra_penalty,
                # Cluster / sweep diagnostics
                "day_cluster_center": (
                    [round(day_cluster_center[0], 5), round(day_cluster_center[1], 5)]
                    if day_cluster_center else None
                ),
                "restaurant_distance_to_cluster": restaurant_dist_to_cluster,
                "cafe_distance_to_cluster": cafe_dist_to_cluster,
                "injected_reason": injected_reason,
                "allocation_method": allocation_method,
                "is_remote_day": is_remote_day,
                "remote_anchor_name": remote_anchor_name,
                "day_used_minutes": day_used_minutes,
                "day_estimated_distance": day_estimated_distance,
                # Finance
                "distance_km": round(ga.total_distance_km, 2),
                "fitness": round(ga.fitness, 4),
                "day_cost": round(ga.total_day_cost),
                "budget_overage": round(ga.budget_overage),
                "stopped_reason": ga.stopped_reason,
                "schedule": [_serialize_entry(entry) for entry in ga.schedule],
            }
        )
    validation_dict = (
        validation.to_dict()
        if validation is not None and hasattr(validation, "to_dict")
        else {"is_feasible": True, "violations": [], "warnings": []}
    )
    return {
        "elapsed_ms": elapsed_ms,
        "hotel_id": result.hotel.id,
        "hotel_name": result.hotel.name,
        "total_visited": sum(len(day.visited_pois) for day in result.days),
        "total_travel_minutes": sum(day.ga_result.total_travel_time for day in result.days),
        "total_wait_minutes": sum(day.ga_result.total_wait_time for day in result.days),
        "total_distance_km": round(sum(day.ga_result.total_distance_km for day in result.days), 2),
        "total_cost": round(sum(day.ga_result.total_day_cost for day in result.days)),
        "validation": validation_dict,
        "days": days,
    }


def _day_density_penalty(ga: Any, visited_count: int) -> int:
    """Compute density + sparse + distance + travel penalties for one day."""
    available_minutes = (
        ga.total_travel_time + ga.total_visit_time + ga.total_wait_time + ga.idle_time
    )
    if available_minutes <= 0:
        return 0

    # Density
    target_poi_count = max(1, round(available_minutes / 150))
    density_penalty = abs(visited_count - target_poi_count) * 200

    # Dense-day: avg_minutes_per_poi < 90
    avg_minutes_per_poi = available_minutes / max(1, visited_count)
    dense_day_penalty = 500 if avg_minutes_per_poi < 90 else 0

    # Sparse-day
    unused_minutes = ga.idle_time  # total - used
    sparse_day_penalty = (
        600 if (available_minutes >= 720 and visited_count <= 2 and unused_minutes >= 240) else 0
    )

    # Distance
    dist_km = ga.total_distance_km
    distance_penalty = 0
    if dist_km > 60:
        distance_penalty += int((dist_km - 60) * 20)
    if dist_km > 80:
        distance_penalty += int((dist_km - 80) * 50)
    if dist_km > 100:
        distance_penalty += 2000

    # Travel-time
    t = ga.total_travel_time
    travel_penalty = 0
    if t > 180:
        travel_penalty += (t - 180) * 5
    if t > 240:
        travel_penalty += (t - 240) * 10
    if t > 300:
        travel_penalty += 2000

    return density_penalty + dense_day_penalty + sparse_day_penalty + distance_penalty + travel_penalty


def _score_result(result: planner.MultiDayResult) -> tuple[float, str]:
    score = 0.0
    reject_reason = ""

    total_travel_minutes = 0
    total_wait_minutes = 0
    total_cost = 0
    total_budget_limit = 0
    visited_count = 0
    total_two_tower_score = 0.0
    total_extra_penalty = 0

    if hasattr(result, "validation_result") and result.validation_result:
        if not result.validation_result.is_feasible:
            reject_reason = "time_feasible == False"

    for day in result.days:
        ga = day.ga_result
        day_visited = len(day.visited_pois)
        total_travel_minutes += ga.total_travel_time
        total_wait_minutes += ga.total_wait_time
        total_cost += ga.total_day_cost
        total_budget_limit += ga.budget_limit
        visited_count += day_visited

        day_restaurants = 0
        for entry in ga.schedule:
            if entry.wait_time > 90:
                reject_reason = "max_poi_wait > 90"
            if getattr(entry, "is_restaurant", False) or getattr(entry, "place_type", "") == "restaurant":
                day_restaurants += 1
            if not getattr(entry, "is_return_to_hotel", False) and getattr(entry, "place_type", "") != "hotel":
                total_two_tower_score += getattr(entry, "two_tower_score", 0.0)

        if day_restaurants > 2:
            reject_reason = "restaurant_count > 2"

        total_extra_penalty += _day_density_penalty(ga, day_visited)

    over_budget_ratio = 0.0
    if total_budget_limit > 0 and total_cost > total_budget_limit:
        over_budget_ratio = (total_cost - total_budget_limit) / total_budget_limit
        if over_budget_ratio > 0.5:
            reject_reason = "budget_over_ratio > 0.5"

    score = (
        1000 * total_two_tower_score
        + 80 * visited_count
        - 2 * total_travel_minutes
        - 5 * total_wait_minutes
        - (total_cost // 10000)
        - 10000 * max(0, over_budget_ratio)
        - total_extra_penalty
    )

    if reject_reason:
        score -= 100000

    return score, reject_reason

def _winner_hint(ga_result: planner.MultiDayResult, scheduler_result: planner.MultiDayResult) -> str:
    ga_score, ga_reason = _score_result(ga_result)
    v2_score, v2_reason = _score_result(scheduler_result)
    
    ga_reject = f" (Rejected: {ga_reason})" if ga_reason else ""
    v2_reject = f" (Rejected: {v2_reason})" if v2_reason else ""
    
    if v2_score >= ga_score:
        return f"winner_by_utility_score: scheduler_v2 (score {v2_score:.1f} vs {ga_score:.1f}){v2_reject}"
    return f"winner_by_utility_score: ga_v1 (score {ga_score:.1f} vs {v2_score:.1f}){ga_reject}"


def _log_result(label: str, result: planner.MultiDayResult, elapsed_ms: int) -> None:
    logger.info(
        "[%s] elapsed=%sms hotel=%s days=%s total_visited=%s",
        label,
        elapsed_ms,
        result.hotel.name,
        result.num_days,
        sum(len(day.visited_pois) for day in result.days),
    )
    for day in result.days:
        ga = day.ga_result
        logger.info(
            "[%s][Day %s] fitness=%.4f candidates=%s visited=%s skipped=%s travel=%s wait=%s idle=%s visit=%s restaurant=%s cost=%s stopped=%s@%s",
            label,
            day.day,
            ga.fitness,
            len(day.pois),
            len(day.visited_pois),
            ga.skipped_count,
            ga.total_travel_time,
            ga.total_wait_time,
            ga.idle_time,
            ga.total_visit_time,
            ga.restaurant_count,
            round(ga.total_day_cost),
            ga.stopped_reason,
            ga.generations_run,
        )


def _print_comparison(
    ga_result: planner.MultiDayResult,
    scheduler_result: planner.MultiDayResult,
    comparison: dict[str, Any],
) -> None:
    print("\n========== ITINERARY ENGINE COMPARISON ==========")
    for label, result in (("GA_V1", ga_result), ("SCHEDULER_V2", scheduler_result)):
        print(f"\n--- {label} ---")
        total_cost = sum(day.ga_result.total_day_cost for day in result.days)
        total_limit = sum(day.ga_result.budget_limit for day in result.days)
        over_budget = max(0, total_cost - total_limit)
        over_ratio = (over_budget / total_limit) if total_limit > 0 else 0
        is_feasible = True
        if hasattr(result, "validation_result") and result.validation_result:
            is_feasible = result.validation_result.is_feasible
        score, reason = _score_result(result)

        print(f"Total Cost: {total_cost:,.0f} VND | Budget Limit: {total_limit:,.0f} VND")
        print(f"Over Budget: {over_budget:,.0f} VND | Over Ratio: {over_ratio:.1%}")
        print(f"Time Feasible: {is_feasible} | Budget Feasible: {over_ratio <= 0.5}")
        print(f"Winner Score: {score:,.1f} | Rejected Reason: {reason or 'None'}")
        
        for day in result.days:
            ga = day.ga_result
            return_time = ga.schedule[-1].arrival_str if ga.schedule else "N/A"
            print(
                f"Day {day.day}: visited={len(day.visited_pois)}/{len(day.pois)} "
                f"restaurant={ga.restaurant_count} return_time={return_time} "
                f"cost={round(ga.total_day_cost)} fitness={ga.fitness:.2f} "
                f"stop={ga.stopped_reason}"
            )
            for seq, entry in enumerate([e for e in ga.schedule if not getattr(e, "is_return_to_hotel", False)], start=1):
                print(
                    f"  {seq:02d}. {entry.service_start_str}-{entry.departure_str} "
                    f"[{entry.place_type}] {entry.location_name} "
                    f"move={entry.travel_minutes}m wait={entry.wait_time}m "
                    f"cost={round(entry.estimated_cost)}"
                )
    print(f"\nWinner hint: {comparison.get('winner_hint')}")
    print("=================================================\n")


def _to_planner_place(
    raw: dict[str, Any],
    day_idx: int = 0,
    start_date: datetime.date | None = None,
) -> planner.Place:
    place_type = _normalize_place_type(raw)
    open_time, close_time, unknown_hours = _extract_time_window(raw, day_idx, start_date)
    default_duration = 60 if place_type == "restaurant" else 90
    if place_type == "cafe":
        default_duration = 45
    if place_type == "hotel":
        default_duration = 0
    best_time, best_time_source = _normalize_best_time(raw)

    return planner.Place(
        id=str(raw["id"]),
        name=str(raw["name"]),
        place_type=place_type,
        source=str(raw.get("source") or ""),
        type_id=str(raw.get("type_id") or ""),
        type_name=str(raw.get("type_name") or ""),
        longitude=float(raw["longitude"]),
        latitude=float(raw["latitude"]),
        open_time=open_time,
        close_time=close_time,
        visit_duration=int(raw.get("visit_duration") or default_duration),
        rating=float(raw.get("average_rating") or 0),
        unknown_hours=unknown_hours,
        open_hour=str(raw.get("open_hour") or ""),
        open_hour_compressed=str(raw.get("open_hour_compressed") or ""),
        candidate_rank=int(raw.get("candidate_rank") or 0),
        candidate_total=max(1, int(raw.get("candidate_total") or 1)),
        estimated_cost=float(raw.get("estimated_cost") or 0),
        price_basis=str(raw.get("price_basis") or "unknown"),
        price_inferred=raw.get("price_inferred"),
        best_time=best_time,
        best_time_source=best_time_source,
    )


def _normalize_best_time(raw: dict[str, Any]) -> tuple[str, str]:
    allowed = {"MORNING", "AFTERNOON", "NIGHT", "ALL_DAY"}
    value = str(raw.get("best_time") or "").strip().upper()
    if value in allowed:
        return value, str(raw.get("best_time_source") or "database")

    type_name = planner.normalize_text(raw.get("type_name") or "")
    category_name = planner.normalize_text(raw.get("category_name") or "")
    label = f"{type_name} {category_name}".strip()
    morning = (
        "cong trinh ton giao",
        "thien nhien",
        "bai bien",
        "di tich",
    )
    afternoon = (
        "bao tang",
        "lang nghe",
        "nong trai",
    )
    night = ("pho di bo",)
    if any(keyword in label for keyword in morning):
        return "MORNING", "category_fallback"
    if any(keyword in label for keyword in afternoon):
        return "AFTERNOON", "category_fallback"
    if any(keyword in label for keyword in night):
        return "NIGHT", "category_fallback"
    return "ALL_DAY", "default_all_day"


def _normalize_place_type(raw: dict[str, Any]) -> str:
    explicit = (raw.get("place_type") or "").strip().lower()
    slot = (raw.get("slot_type") or raw.get("category") or "").strip().lower()
    category_id = (raw.get("category_id") or "").strip().lower()
    category_name = planner.normalize_text(raw.get("category_name") or "")
    type_name = planner.normalize_text(raw.get("type_name") or "")

    value = explicit or slot
    if value in {"hotel", "accommodation"}:
        return "hotel"
    if value == "cafe":
        return "cafe"
    if value == "entertainment":
        return "entertainment"
    if value == "restaurant":
        return "restaurant"
    if any(keyword in type_name for keyword in ("cafe", "coffee", "tra sua", "milk tea", "do uong")):
        return "cafe"
    if category_id == FOOD_CATEGORY_ID:
        return "restaurant"
    if any(keyword in category_name for keyword in planner.MEAL_TYPE_NAME_KEYWORDS):
        return "restaurant"
    if any(keyword in type_name for keyword in planner.MEAL_TYPE_NAME_KEYWORDS):
        return "restaurant"
    return "attraction"


def _parse_trip_start_date(value: str | None) -> datetime.date:
    if not value:
        return datetime.date.today()
    try:
        return datetime.date.fromisoformat(value)
    except ValueError:
        return datetime.date.today()


def _extract_time_window(
    raw: dict[str, Any],
    day_idx: int = 0,
    start_date: datetime.date | None = None,
) -> tuple[int, int, bool]:
    base_date = start_date or datetime.date.today()
    today_idx = (base_date.weekday() + day_idx) % 7
    compressed = raw.get("open_hour_compressed") or ""
    open_hour = raw.get("open_hour") or ""
    time_window = planner.get_time_for_day_json(open_hour, today_idx)
    if time_window is None:
        time_window = planner.get_time_for_day_json(compressed, today_idx)
    if time_window is None:
        time_window = planner.get_time_for_day(compressed, today_idx)
    if time_window is None:
        return 0, 1440, True
    return time_window[0], time_window[1], False


def _serialize_result(
    result: planner.MultiDayResult,
    input_places: int,
    total_ms: int = 0,
    matrix_ms: int = 0,
    ga_ms: int = 0,
    planner_engine: str = "ga_v1",
    solver_ms: int = 0,
    validation: ValidationResult | None = None,
    comparison: dict[str, Any] | None = None,
    travel_source_counts: dict[str, int] | None = None,
) -> ItineraryPlanResponse:
    days = [_serialize_day(day) for day in result.days]
    assignment_warnings = (
        result.assignment_result.warnings
        if result.assignment_result is not None
        else []
    )
    assignment_day_loads = (
        result.assignment_result.day_loads
        if result.assignment_result is not None
        else []
    )
    assignment_debug = _serialize_assignment_debug(result)
    validation_result = validation or result.validation_result
    validation_dict = (
        validation_result.to_dict()
        if validation_result is not None and hasattr(validation_result, "to_dict")
        else {"is_feasible": True, "violations": [], "warnings": []}
    )
    return ItineraryPlanResponse(
        hotel_id=result.hotel.id,
        hotel_name=result.hotel.name,
        num_days=result.num_days,
        input_places=input_places,
        total_visited=sum(day.visited_count for day in days),
        total_ms=total_ms,
        matrix_ms=matrix_ms,
        ga_ms=ga_ms,
        planner_engine=planner_engine,
        solver_ms=solver_ms,
        assignment_day_loads=assignment_day_loads,
        assignment_warnings=assignment_warnings,
        assignment_debug=assignment_debug,
        travel_source_counts=travel_source_counts or {},
        validation_is_feasible=bool(validation_dict["is_feasible"]),
        validation_violations=validation_dict["violations"],
        validation_warnings=validation_dict["warnings"],
        comparison=comparison,
        days=days,
    )


def _serialize_assignment_debug(result: planner.MultiDayResult) -> list[dict[str, Any]]:
    assignment = result.assignment_result
    if assignment is None:
        return []

    pools: list[dict[str, Any]] = []
    for index, pool in enumerate(assignment.day_pools):
        places: list[dict[str, Any]] = []
        seen: set[str] = set()
        for key, default_role in (
            ("attractions", "attraction"),
            ("restaurants", "restaurant"),
        ):
            for place in pool.get(key, []):
                place_id = str(place.id)
                if place_id in seen:
                    continue
                seen.add(place_id)
                places.append(
                    {
                        "id": place_id,
                        "name": str(place.name),
                        "role": str(getattr(place, "place_type", default_role)),
                        "latitude": float(place.latitude),
                        "longitude": float(place.longitude),
                        "candidate_rank": int(getattr(place, "candidate_rank", 0)),
                        "retrieval_score": float(
                            getattr(place, "retrieval_score", 0.0)
                        ),
                    }
                )

        center = pool.get("day_cluster_center")
        pools.append(
            {
                "day": index + 1,
                "load_minutes": (
                    assignment.day_loads[index]
                    if index < len(assignment.day_loads)
                    else None
                ),
                "allocation_method": pool.get("allocation_method"),
                "cluster_center": (
                    [float(center[0]), float(center[1])] if center else None
                ),
                "places": places,
            }
        )
    return pools


def _serialize_day(day_result: planner.DayResult) -> ItineraryDayResponse:
    ga = day_result.ga_result
    schedule = [_serialize_entry(entry) for entry in ga.schedule]
    total_visit_minutes = sum(
        entry.active_duration_minutes
        for entry in schedule
        if not entry.is_return_to_hotel
    )
    best_time_metrics = _best_time_metrics(ga.schedule)
    return ItineraryDayResponse(
        day=day_result.day,
        candidates=len(day_result.pois),
        visited_count=len(day_result.visited_pois),
        target_visited_count=max(
            planner.POI_TARGET_MIN_PER_DAY,
            min(
                planner.POI_TARGET_MAX_PER_DAY,
                (ga.total_visit_time + ga.total_travel_time + ga.total_wait_time + ga.idle_time)
                // planner.POI_TARGET_TIME_SLICE_MINUTES,
            ),
        ),
        total_travel_minutes=ga.total_travel_time,
        total_distance_km=round(ga.total_distance_km, 2),
        total_visit_minutes=total_visit_minutes,
        total_wait_minutes=ga.total_wait_time,
        total_activity_cost=round(ga.total_activity_cost),
        total_transport_cost=round(ga.total_transport_cost),
        total_day_cost=round(ga.total_day_cost),
        budget_limit=round(ga.budget_limit),
        budget_overage=round(ga.budget_overage),
        budget_penalty=round(ga.budget_penalty, 4),
        skipped_count=ga.skipped_count,
        total_hard_violations=ga.total_hard_violations,
        meal_violations=ga.meal_violations,
        restaurant_count=ga.restaurant_count,
        **best_time_metrics,
        fitness=round(ga.fitness, 4),
        stopped_reason=f"{ga.stopped_reason}@{ga.generations_run}",
        schedule=schedule,
    )


def _serialize_entry(entry: planner.ScheduleEntry) -> ScheduleEntryResponse:
    base_duration = max(0, int(entry.base_duration or 0))
    active_duration = 0 if entry.is_return_to_hotel else (
        base_duration if base_duration > 0 else entry.active_duration
    )
    departure_time = entry.departure_str
    if active_duration > 0:
        departure_time = planner.minutes_to_time(
            entry.service_start_time + active_duration
        )

    best_time = str(entry.best_time or "ALL_DAY").upper()
    preferred_window = BEST_TIME_WINDOWS.get(best_time)
    deviation = 0
    matched: bool | None = None
    if (
        preferred_window is not None
        and entry.best_time_applicable
        and not entry.is_return_to_hotel
    ):
        matched = preferred_window[0] <= entry.service_start_time <= preferred_window[1]
        if entry.service_start_time < preferred_window[0]:
            deviation = preferred_window[0] - entry.service_start_time
        elif entry.service_start_time > preferred_window[1]:
            deviation = entry.service_start_time - preferred_window[1]

    return ScheduleEntryResponse(
        location_id=entry.location_id,
        location_name=entry.location_name,
        travel_from_id=entry.travel_from_id,
        travel_from_name=entry.travel_from_name,
        travel_minutes=entry.travel_minutes,
        raw_travel_minutes=entry.raw_travel_minutes,
        travel_buffer_minutes=entry.travel_buffer_minutes,
        travel_buffer_source=entry.travel_buffer_source,
        distance_km=round(entry.distance_km, 2),
        travel_source=entry.travel_source,
        arrival_time=entry.arrival_str,
        service_start_time=entry.service_start_str,
        departure_time=departure_time,
        wait_minutes=entry.wait_time,
        base_duration_minutes=base_duration,
        active_duration_minutes=active_duration,
        estimated_cost=round(entry.estimated_cost),
        price_basis=entry.price_basis,
        price_inferred=entry.price_inferred,
        best_time=best_time,
        best_time_source=entry.best_time_source,
        best_time_deviation_minutes=deviation,
        best_time_matched=matched,
        place_type=entry.place_type,
        is_restaurant=entry.is_restaurant,
        unknown_hours=entry.unknown_hours,
        is_return_to_hotel=entry.is_return_to_hotel,
    )


def _best_time_metrics(
    schedule: list[planner.ScheduleEntry],
) -> dict[str, int | float]:
    eligible = 0
    matched = 0
    slight = 0
    large = 0
    penalty_minutes = 0
    for entry in schedule:
        if entry.is_return_to_hotel or not entry.best_time_applicable:
            continue
        window = BEST_TIME_WINDOWS.get(str(entry.best_time or "").upper())
        if window is None:
            continue
        eligible += 1
        start = entry.service_start_time
        if window[0] <= start <= window[1]:
            matched += 1
            continue
        deviation = window[0] - start if start < window[0] else start - window[1]
        penalty_minutes += deviation
        if deviation <= 30:
            slight += 1
        else:
            large += 1
    return {
        "best_time_eligible_count": eligible,
        "best_time_matched_count": matched,
        "best_time_slight_mismatch_count": slight,
        "best_time_large_mismatch_count": large,
        "best_time_match_rate": round(matched / eligible, 4) if eligible else 1.0,
        "best_time_penalty_minutes": penalty_minutes,
    }

