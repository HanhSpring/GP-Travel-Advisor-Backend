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

logger = logging.getLogger(__name__)
FOOD_CATEGORY_ID = "97029cfb-069b-4dba-a152-dfb3d36634d3"


def plan_itinerary(req: ItineraryPlanRequest) -> ItineraryPlanResponse:
    started_at = time.perf_counter()
    places = [_to_planner_place(item.model_dump()) for item in req.places]
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
    )
    matrix_ms = round((time.perf_counter() - matrix_started_at) * 1000)

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
    )
    ga_started_at = time.perf_counter()
    result = engine.run(seed=req.seed)
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
            "[GA][Day %s] fitness=%.4f candidates=%s visited=%s travel=%s wait=%s idle=%s visit=%s restaurant=%s stopped=%s@%s",
            day.day,
            ga.fitness,
            len(day.pois),
            len(day.visited_pois),
            ga.total_travel_time,
            ga.total_wait_time,
            ga.idle_time,
            ga.total_visit_time,
            ga.restaurant_count,
            ga.stopped_reason,
            ga.generations_run,
        )
    planner.print_multi_day_schedule(result)
    return _serialize_result(result, input_places=len(req.places))


def _to_planner_place(raw: dict[str, Any]) -> planner.Place:
    place_type = _normalize_place_type(raw)
    open_time, close_time, unknown_hours = _extract_time_window(raw)
    default_duration = 60 if place_type == "restaurant" else 90
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
    if value in {"restaurant", "cafe"}:
        return "restaurant"
    if category_id == FOOD_CATEGORY_ID:
        return "restaurant"
    if any(keyword in category_name for keyword in planner.MEAL_TYPE_NAME_KEYWORDS):
        return "restaurant"
    if any(keyword in type_name for keyword in planner.MEAL_TYPE_NAME_KEYWORDS):
        return "restaurant"
    return "attraction"


def _extract_time_window(raw: dict[str, Any]) -> tuple[int, int, bool]:
    today_idx = datetime.date.today().weekday()
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


def _serialize_result(result: planner.MultiDayResult, input_places: int) -> ItineraryPlanResponse:
    days = [_serialize_day(day) for day in result.days]
    return ItineraryPlanResponse(
        hotel_id=result.hotel.id,
        hotel_name=result.hotel.name,
        num_days=result.num_days,
        input_places=input_places,
        total_visited=sum(day.visited_count for day in days),
        days=days,
    )


def _serialize_day(day_result: planner.DayResult) -> ItineraryDayResponse:
    ga = day_result.ga_result
    return ItineraryDayResponse(
        day=day_result.day,
        visited_count=len(day_result.visited_pois),
        total_travel_minutes=ga.total_travel_time,
        total_distance_km=round(ga.total_distance_km, 2),
        total_visit_minutes=ga.total_visit_time,
        total_wait_minutes=ga.total_wait_time,
        restaurant_count=ga.restaurant_count,
        fitness=round(ga.fitness, 4),
        stopped_reason=f"{ga.stopped_reason}@{ga.generations_run}",
        schedule=[_serialize_entry(entry) for entry in ga.schedule],
    )


def _serialize_entry(entry: planner.ScheduleEntry) -> ScheduleEntryResponse:
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
        departure_time=entry.departure_str,
        wait_minutes=entry.wait_time,
        active_duration_minutes=entry.active_duration,
        is_restaurant=entry.is_restaurant,
        unknown_hours=entry.unknown_hours,
        is_return_to_hotel=entry.is_return_to_hotel,
    )
