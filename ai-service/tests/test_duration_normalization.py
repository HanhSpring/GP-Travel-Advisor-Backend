from app.services.itinerary_service import _normalize_visit_duration


def test_legacy_hour_values_are_converted_to_minutes():
    assert _normalize_visit_duration(1, 90) == 60
    assert _normalize_visit_duration("2", 90) == 120
    assert _normalize_visit_duration(4, 90) == 240


def test_minute_values_and_missing_values_remain_consistent():
    assert _normalize_visit_duration(45, 90) == 45
    assert _normalize_visit_duration(90, 60) == 90
    assert _normalize_visit_duration(None, 75) == 75
