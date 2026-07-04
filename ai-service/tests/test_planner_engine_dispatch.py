from unittest.mock import Mock

import pytest

from app.services import itinerary_service


@pytest.mark.parametrize(
    ("value", "expected"),
    [
        (None, "scheduler_v2"),
        ("scheduler_v2", "scheduler_v2"),
        ("or_tools", "scheduler_v2"),
        ("ga_v1", "ga_v1"),
        (" GA ", "ga_v1"),
    ],
)
def test_normalize_planner_engine_aliases(value, expected):
    assert itinerary_service._normalize_planner_engine(value) == expected


def test_normalize_planner_engine_rejects_unknown_value():
    with pytest.raises(ValueError):
        itinerary_service._normalize_planner_engine("both")


def test_dispatch_scheduler_does_not_call_ga(monkeypatch):
    result = Mock()
    validation = Mock()
    scheduler = Mock(return_value=(result, 125, validation))
    ga = Mock()
    monkeypatch.setattr(itinerary_service, "_run_scheduler_v2_engine", scheduler)
    monkeypatch.setattr(itinerary_service, "_run_ga_engine", ga)

    dispatched = itinerary_service._dispatch_planner_engine(
        "scheduler_v2", Mock(), [], {}, {}, {}, {}, "key"
    )

    assert dispatched == (result, 0, 125, validation, "scheduler_v2")
    scheduler.assert_called_once()
    ga.assert_not_called()


def test_dispatch_ga_does_not_call_scheduler(monkeypatch):
    result = Mock()
    validation = Mock()
    ga = Mock(return_value=(result, 250, validation))
    scheduler = Mock()
    monkeypatch.setattr(itinerary_service, "_run_ga_engine", ga)
    monkeypatch.setattr(itinerary_service, "_run_scheduler_v2_engine", scheduler)

    dispatched = itinerary_service._dispatch_planner_engine(
        "ga_v1", Mock(), [], {}, {}, {}, {}, "key"
    )

    assert dispatched == (result, 250, 0, validation, "ga_v1")
    ga.assert_called_once()
    scheduler.assert_not_called()
