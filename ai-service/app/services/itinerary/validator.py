from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any


HARD_VIOLATIONS = {
    "closed",
    "late_departure",
    "missing_lunch",
    "budget_exceeded",
    "no_feasible_activities",
}


@dataclass
class Violation:
    day: int
    location_id: str
    location_name: str
    violation_type: str
    detail: str


@dataclass
class ValidationResult:
    is_feasible: bool
    violations: list[Violation] = field(default_factory=list)
    warnings: list[str] = field(default_factory=list)

    def to_dict(self) -> dict[str, Any]:
        return {
            "is_feasible": self.is_feasible,
            "violations": [violation.__dict__ for violation in self.violations],
            "warnings": self.warnings,
        }


class FeasibilityValidator:
    def validate(
        self,
        schedule: Any,
        places_map: dict[str, Any],
        trip_budget_total: float = 0,
        hotel_total_cost: float = 0,
    ) -> ValidationResult:
        violations: list[Violation] = []
        warnings: list[str] = []

        for day_result in schedule.days:
            ga = day_result.ga_result
            if ga.restaurant_count < 1:
                # Don't flag missing_lunch if it was intentionally skipped
                # (e.g., day 1 late check-in, or infeasible fallback)
                reason = getattr(ga, "stopped_reason", "") or ""
                if "no_lunch" not in reason and "greedy_fallback" not in reason:
                    violations.append(
                        Violation(
                            day=day_result.day,
                            location_id="",
                            location_name="",
                            violation_type="missing_lunch",
                            detail="Day has no valid restaurant/lunch stop",
                        )
                    )
            if ga.skipped_count > 3:
                warnings.append(
                    f"Day {day_result.day}: skipped_count={ga.skipped_count} (>3), assignment may be overloaded"
                )
            if len(day_result.visited_pois) < 4:
                warnings.append(
                    f"Day {day_result.day}: visited_count={len(day_result.visited_pois)} (<4)"
                )
            if ga.budget_overage > 0:
                warnings.append(
                    f"Day {day_result.day}: budget overage {round(ga.budget_overage)} VND"
                )

            for entry in ga.schedule:
                if entry.is_return_to_hotel:
                    continue
                place = places_map.get((day_result.day, entry.location_id))
                if place is None:
                    place = places_map.get(entry.location_id)
                if place is None:
                    warnings.append(
                        f"Day {day_result.day}: missing place metadata for {entry.location_id}"
                    )
                    continue
                if not getattr(place, "unknown_hours", False):
                    if entry.service_start_time < place.open_time:
                        violations.append(
                            Violation(
                                day=day_result.day,
                                location_id=entry.location_id,
                                location_name=entry.location_name,
                                violation_type="closed",
                                detail=(
                                    f"Start {entry.service_start_str} before open "
                                    f"{self._fmt(place.open_time)}"
                                ),
                            )
                        )
                    if entry.departure_time > place.close_time:
                        violations.append(
                            Violation(
                                day=day_result.day,
                                location_id=entry.location_id,
                                location_name=entry.location_name,
                                violation_type="late_departure",
                                detail=(
                                    f"Depart {entry.departure_str} after close "
                                    f"{self._fmt(place.close_time)}"
                                ),
                            )
                        )

        scheduled_cost = sum(
            max(0.0, float(day_result.ga_result.total_day_cost or 0))
            for day_result in schedule.days
        )
        trip_cost = max(0.0, float(hotel_total_cost or 0)) + scheduled_cost
        budget = max(0.0, float(trip_budget_total or 0))
        if budget > 0 and trip_cost > budget:
            violations.append(
                Violation(
                    day=0,
                    location_id="",
                    location_name="",
                    violation_type="budget_exceeded",
                    detail=(
                        f"Không tìm được lịch trình trong ngân sách: "
                        f"tổng chi phí {round(trip_cost)} VND vượt "
                        f"ngân sách nhóm {round(budget)} VND."
                    ),
                )
            )

        visited_count = sum(len(day_result.visited_pois) for day_result in schedule.days)
        if visited_count == 0:
            violations.append(
                Violation(
                    day=0,
                    location_id="",
                    location_name="",
                    violation_type="no_feasible_activities",
                    detail=(
                        "Không tìm được địa điểm phù hợp đồng thời với ngân sách, "
                        "thời gian và giờ mở cửa. Vui lòng tăng ngân sách hoặc nới "
                        "thời gian chuyến đi."
                    ),
                )
            )

        is_feasible = not any(
            violation.violation_type in HARD_VIOLATIONS
            for violation in violations
        )
        return ValidationResult(
            is_feasible=is_feasible,
            violations=violations,
            warnings=warnings,
        )

    def _fmt(self, minutes: int) -> str:
        h = (minutes // 60) % 24
        m = minutes % 60
        return f"{h:02d}:{m:02d}"
