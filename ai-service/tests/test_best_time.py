from app.services.itinerary import planner
from app.services.itinerary.scheduler_v2 import (
    best_time_deviation_minutes,
    preferred_time_window,
)
from app.services.itinerary_service import _normalize_best_time


def _poi(best_time: str, open_time: int = 0, close_time: int = 1440) -> planner.POI:
    return planner.POI(
        id="poi-1",
        name="POI",
        place_type="attraction",
        open_time=open_time,
        close_time=close_time,
        visit_duration=60,
        best_time=best_time,
    )


def test_normalize_best_time_uses_database_value() -> None:
    assert _normalize_best_time(
        {"best_time": " morning ", "type_name": "Bảo tàng"}
    ) == ("MORNING", "database")


def test_normalize_best_time_falls_back_from_category() -> None:
    assert _normalize_best_time(
        {"best_time": None, "type_name": "Bảo tàng & Không gian trưng bày"}
    ) == ("AFTERNOON", "category_fallback")


def test_all_day_has_no_preferred_window_or_penalty() -> None:
    poi = _poi("ALL_DAY")
    assert preferred_time_window(poi, 8 * 60, 21 * 60) is None
    assert best_time_deviation_minutes(poi, 20 * 60, 8 * 60, 21 * 60) == 0


def test_morning_deviation_is_zero_inside_window() -> None:
    poi = _poi("MORNING")
    assert best_time_deviation_minutes(
        poi, 9 * 60, 8 * 60, 21 * 60
    ) == 0


def test_morning_deviation_counts_minutes_outside_window() -> None:
    poi = _poi("MORNING")
    assert best_time_deviation_minutes(
        poi, 12 * 60, 8 * 60, 21 * 60
    ) == 30


def test_opening_hours_take_priority_over_best_time() -> None:
    poi = _poi("MORNING", open_time=18 * 60, close_time=22 * 60)
    assert preferred_time_window(poi, 8 * 60, 21 * 60) is None
    assert best_time_deviation_minutes(
        poi, 18 * 60, 8 * 60, 21 * 60
    ) == 0
