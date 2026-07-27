import pytest

from app.schemas.optimize import ActivityInput, RouteAnchor
from app.services import itinerary_optimizer
from app.services.itinerary_optimizer import optimize_day_schedule


def _activity(
    *,
    activity_id: str,
    duration: int,
    is_restaurant: bool = False,
    is_locked: bool = False,
    locked_arrive_time: str | None = None,
) -> ActivityInput:
    return ActivityInput(
        id=activity_id,
        # Dùng cùng place_id để thời gian di chuyển bằng 0, giúp test chỉ đo
        # đúng ràng buộc thời lượng và khung giờ ăn trưa.
        place_id="same-place",
        duration_minutes=duration,
        is_restaurant=is_restaurant,
        is_locked=is_locked,
        locked_arrive_time=locked_arrive_time,
        open_time="10:00",
        close_time="14:00",
    )


def test_keeps_user_edited_activity_and_reduces_only_unlocked_activities():
    activities = [
        _activity(
            activity_id="user-edited",
            duration=180,
            is_locked=True,
            locked_arrive_time="10:00",
        ),
        _activity(
            activity_id="lunch",
            duration=60,
            is_restaurant=True,
        ),
        _activity(
            activity_id="other-place",
            duration=120,
        ),
    ]

    optimized, _, _ = optimize_day_schedule(
        activities=activities,
        day_start_time="10:00",
        day_end_time="14:00",
        allow_reduce_time=True,
        use_goong=False,
    )

    by_id = {activity.id: activity for activity in optimized}

    # Thay đổi của người dùng là hard constraint: không đổi giờ và thời lượng.
    assert by_id["user-edited"].arrival_time == "10:00"
    assert by_id["user-edited"].departure_time == "13:00"
    assert by_id["user-edited"].duration_minutes == 180

    # Lịch chỉ khả thi nếu một điểm chưa chỉnh được giảm sâu hơn giới hạn 50%
    # cũ (120 -> dưới 60 phút).
    assert 15 <= by_id["other-place"].duration_minutes < 60

    # Bữa trưa vẫn nằm trong khung và không bị rút xuống dưới 30 phút.
    assert "10:30" <= by_id["lunch"].arrival_time <= "14:00"
    assert by_id["lunch"].duration_minutes >= 30


def test_rejects_locked_lunch_outside_window_before_building_matrix(monkeypatch):
    def fail_if_matrix_is_built(*args, **kwargs):
        pytest.fail("travel matrix must not be built for an invalid locked lunch")

    monkeypatch.setattr(
        itinerary_optimizer,
        "build_real_travel_matrix",
        fail_if_matrix_is_built,
    )

    activities = [
        _activity(
            activity_id="lunch",
            duration=60,
            is_restaurant=True,
            is_locked=True,
            locked_arrive_time="14:30",
        ),
    ]

    with pytest.raises(ValueError, match="LUNCH_CONFLICT"):
        optimize_day_schedule(
            activities=activities,
            day_start_time="07:00",
            day_end_time="22:00",
            allow_reduce_time=True,
        )


def test_adds_travel_time_from_start_location_to_first_activity(monkeypatch):
    activities = [
        ActivityInput(
            id="first-place",
            place_id="first-place",
            duration_minutes=60,
            open_time="07:00",
            close_time="22:00",
        ),
    ]
    start_location = RouteAnchor(id="hotel", place_id="hotel")

    monkeypatch.setattr(
        itinerary_optimizer,
        "build_real_travel_matrix",
        lambda *args, **kwargs: (
            {("hotel", "first-place"): 25},
            {("hotel", "first-place"): 10.0},
        ),
    )

    optimized, _, total_transit = optimize_day_schedule(
        activities=activities,
        day_start_time="08:00",
        day_end_time="12:00",
        use_goong=False,
        start_location=start_location,
    )

    assert optimized[0].arrival_time == "08:25"
    assert optimized[0].departure_time == "09:25"
    assert total_transit == 25


def test_inserts_new_activity_at_earliest_time_after_travel(monkeypatch):
    activities = [
        ActivityInput(
            id="previous-place",
            place_id="previous-place",
            duration_minutes=60,
            is_locked=True,
            locked_arrive_time="17:00",
            open_time="07:00",
            close_time="22:00",
        ),
        ActivityInput(
            id="new-place",
            place_id="new-place",
            duration_minutes=60,
            is_new=True,
            open_time="18:00",
            close_time="22:00",
        ),
    ]

    monkeypatch.setattr(
        itinerary_optimizer,
        "build_real_travel_matrix",
        lambda *args, **kwargs: (
            {
                ("previous-place", "new-place"): 40,
                ("new-place", "previous-place"): 40,
            },
            {
                ("previous-place", "new-place"): 20.0,
                ("new-place", "previous-place"): 20.0,
            },
        ),
    )

    optimized, _, _ = optimize_day_schedule(
        activities=activities,
        day_start_time="07:00",
        day_end_time="22:00",
        use_goong=False,
    )

    by_id = {activity.id: activity for activity in optimized}
    assert by_id["previous-place"].departure_time == "18:00"
    assert by_id["new-place"].arrival_time == "18:40"
    assert by_id["new-place"].departure_time == "19:40"
