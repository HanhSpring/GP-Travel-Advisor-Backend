from types import SimpleNamespace

from app.services.itinerary.validator import FeasibilityValidator
from app.services.itinerary.scheduler_v2 import SchedulerV2Planner


def _schedule(day_costs: list[float], visited_per_day: int = 1):
    days = []
    for index, cost in enumerate(day_costs, start=1):
        ga_result = SimpleNamespace(
            restaurant_count=1,
            stopped_reason="",
            skipped_count=0,
            budget_overage=0,
            total_day_cost=cost,
            schedule=[],
        )
        days.append(
            SimpleNamespace(
                day=index,
                ga_result=ga_result,
                visited_pois=[object()] * visited_per_day,
            )
        )
    return SimpleNamespace(days=days)


def test_group_budget_is_a_hard_global_constraint():
    result = FeasibilityValidator().validate(
        _schedule([2_000_000, 2_000_000]),
        {},
        trip_budget_total=5_000_000,
        hotel_total_cost=2_000_000,
    )

    assert result.is_feasible is False
    assert any(
        violation.violation_type == "budget_exceeded"
        for violation in result.violations
    )


def test_group_budget_accepts_total_equal_to_budget():
    result = FeasibilityValidator().validate(
        _schedule([1_500_000, 1_500_000]),
        {},
        trip_budget_total=5_000_000,
        hotel_total_cost=2_000_000,
    )

    assert result.is_feasible is True


def test_empty_schedule_returns_user_facing_hard_violation():
    result = FeasibilityValidator().validate(
        _schedule([0], visited_per_day=0),
        {},
        trip_budget_total=5_000_000,
        hotel_total_cost=1_000_000,
    )

    assert result.is_feasible is False
    assert any(
        violation.violation_type == "no_feasible_activities"
        for violation in result.violations
    )


def test_travel_minutes_round_up_to_next_five():
    assert SchedulerV2Planner._round_travel_minutes(9) == 10
    assert SchedulerV2Planner._round_travel_minutes(11) == 15
    assert SchedulerV2Planner._round_travel_minutes(18) == 20
    assert SchedulerV2Planner._round_travel_minutes(20) == 20
