from types import SimpleNamespace

from app.services.itinerary.scheduler_v2 import (
    SKIPPED_POI_PENALTY,
    TAIL_IDLE_EXCESS_PENALTY_PER_MIN,
    TAIL_IDLE_GRACE_MINUTES,
    SchedulerV2Planner,
)


def _bare_scheduler() -> SchedulerV2Planner:
    scheduler = SchedulerV2Planner.__new__(SchedulerV2Planner)
    scheduler.day_start_time = 8 * 60
    scheduler.day_end_time = 21 * 60
    scheduler.target_pois_per_day = 8
    scheduler.trip_budget_total = 0
    scheduler.daily_budget_soft = 0
    scheduler.config = SimpleNamespace(check_in_time=None)
    return scheduler


def test_dynamic_target_bounds_follow_available_time():
    scheduler = _bare_scheduler()

    assert scheduler._calculate_target_bounds(12, 8 * 60) == (5, 8)
    assert scheduler._calculate_target_bounds(3, 8 * 60) == (3, 3)
    assert scheduler._calculate_target_bounds(1, 18 * 60) == (1, 1)
    assert scheduler._calculate_target_bounds(0, 8 * 60) == (0, 0)


def test_target_min_falls_back_before_greedy():
    scheduler = _bare_scheduler()
    calls = []
    expected = object()
    greedy = object()
    pois = [
        SimpleNamespace(
            open_time=7 * 60,
            close_time=22 * 60,
            estimated_cost=0,
        )
        for _ in range(8)
    ]

    def solve(*args, **kwargs):
        calls.append((kwargs["enforce_lunch"], kwargs["target_min"]))
        if kwargs["enforce_lunch"] and kwargs["target_min"] == 2:
            return expected
        return None

    scheduler._solve_day_core = solve
    scheduler._greedy_fallback = lambda *args: greedy

    result = scheduler._solve_day_with_fallback(2, pois, is_day_1=False)

    assert result is expected
    assert calls == [
        (True, 5),
        (True, 4),
        (True, 3),
        (True, 2),
    ]


def test_density_penalties_use_tuned_values():
    assert SKIPPED_POI_PENALTY == 150
    assert TAIL_IDLE_GRACE_MINUTES == 120
    assert TAIL_IDLE_EXCESS_PENALTY_PER_MIN == 12
