from __future__ import annotations

import datetime
import logging
import os
import time
from typing import Any

from app.schemas.itinerary import (
    ItineraryDayResponse,
    ItineraryPlanRequest,
    ItineraryPlanResponse,
    ScheduleEntryResponse,
)
from app.services.itinerary import planner
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
    goong_key = req.goong_api_key or os.getenv("GOONG_API_KEY", "")
    if not req.use_goong:
        goong_key = ""

    matrix_started_at = time.perf_counter()
    travel_times, travel_distances, travel_sources, travel_reliability = planner.build_travel_matrix(
        coords,
        api_key=goong_key,
        vehicle=req.travel_vehicle,
        cache_path=travel_cache,
        speed_kmh=req.speed_kmh,
        require_goong=req.require_goong,
    )

    engine = planner.MultiDayTripPlanner(
        places=places,
        num_days=req.num_days,
        travel_times=travel_times,
        travel_distances=travel_distances,
        travel_sources=travel_sources,
        travel_reliability=travel_reliability,
        selected_hotel_id=req.selected_hotel_id,
        day_start_time=planner.time_to_minutes(req.daily_start_time),
        day_end_time=planner.time_to_minutes(req.daily_end_time),
        population_size=req.population_size,
        generations=req.generations,
        mutation_rate=req.mutation_rate,
        return_to_hotel=req.return_to_hotel,
        require_goong_edges=req.require_goong,
        budget_per_person=req.budget_per_person,
        adult_count=req.adult_count,
        child_count=req.child_count,
        travel_vehicle=req.travel_vehicle,
        trip_start_date=req.trip_start_date,
    )
    matrix_ms = round((time.perf_counter() - matrix_started_at) * 1000)
    ga_started_at = time.perf_counter()
    result = engine.run(seed=req.seed)
    places_map = {place.id: place for place in places}
    for day_idx in range(req.num_days):
        weekday_idx = (trip_start_date.weekday() + day_idx) % 7
        for place in places:
            places_map[(day_idx + 1, place.id)] = place.to_poi_for_day(weekday_idx)
    validation = FeasibilityValidator().validate(result, places_map)
    result.validation_result = validation
    ga_ms = round((time.perf_counter() - ga_started_at) * 1000)
    total_ms = round((time.perf_counter() - started_at) * 1000)

    logger.info(
        "[Planner] completed total=%sms matrix=%sms ga=%sms hotel=%s (%s)",
        total_ms,
        matrix_ms,
        ga_ms,
        result.hotel.name,
        result.hotel.id,
    )
    for day in result.days:
        ga = day.ga_result
        logger.info(
            "[GA][Day %s] fitness=%.4f candidates=%s visited=%s skipped=%s travel=%s wait=%s idle=%s visit=%s restaurant=%s stopped=%s@%s",
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
            ga.stopped_reason,
            ga.generations_run,
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
        validation=validation,
    )


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
    )


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
    validation: ValidationResult | None = None,
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
        assignment_day_loads=assignment_day_loads,
        assignment_warnings=assignment_warnings,
        validation_is_feasible=bool(validation_dict["is_feasible"]),
        validation_violations=validation_dict["violations"],
        validation_warnings=validation_dict["warnings"],
        days=days,
    )


def _serialize_day(day_result: planner.DayResult) -> ItineraryDayResponse:
    ga = day_result.ga_result
    schedule = [_serialize_entry(entry) for entry in ga.schedule]
    total_visit_minutes = sum(
        entry.active_duration_minutes
        for entry in schedule
        if not entry.is_return_to_hotel
    )
    return ItineraryDayResponse(
        day=day_result.day,
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
        place_type=entry.place_type,
        is_restaurant=entry.is_restaurant,
        unknown_hours=entry.unknown_hours,
        is_return_to_hotel=entry.is_return_to_hotel,
    )
