from __future__ import annotations

import math
from dataclasses import dataclass, field
from typing import Any


MIN_POOL_PER_DAY = 4
MAX_LOAD_RATIO = 1.0
LUNCH_BLOCK_MINUTES = 80


@dataclass
class AssignmentConfig:
    num_days: int
    daily_start_time: int
    daily_end_time: int
    trip_intent: str
    hotel: Any
    target_nonmeal_per_day: int = MIN_POOL_PER_DAY

    @property
    def daily_available(self) -> int:
        return max(0, self.daily_end_time - self.daily_start_time)

    @property
    def daily_effective(self) -> int:
        return max(0, self.daily_available - LUNCH_BLOCK_MINUTES)


@dataclass
class AssignmentResult:
    day_pools: list[dict[str, list[Any]]]
    day_loads: list[int]
    warnings: list[str] = field(default_factory=list)


class AssignmentModule:
    def __init__(
        self,
        config: AssignmentConfig,
        travel_matrix: dict[tuple[str, str], int],
    ):
        self.config = config
        self.travel_matrix = travel_matrix

    def assign(self, places: list[Any]) -> AssignmentResult:
        day_pools = self._new_day_pool()
        restaurants = [p for p in places if p.place_type == "restaurant"]
        nonmeal = [
            p
            for p in places
            if p.place_type in {"attraction", "cafe", "entertainment"}
        ]

        self._assign_restaurants(day_pools, restaurants)
        for role in ("attraction", "cafe", "entertainment"):
            self._assign_balanced_sweep(
                day_pools,
                [place for place in nonmeal if place.place_type == role],
            )

        self._rebalance(day_pools)
        day_loads = [self._day_load(pool) for pool in day_pools]
        warnings = self._warnings(day_pools, day_loads)
        return AssignmentResult(day_pools=day_pools, day_loads=day_loads, warnings=warnings)

    def _new_day_pool(self) -> list[dict[str, list[Any]]]:
        return [
            {
                "attractions": [],
                "restaurants": [],
            }
            for _ in range(self.config.num_days)
        ]

    def _assign_restaurants(
        self,
        day_pools: list[dict[str, list[Any]]],
        restaurants: list[Any],
    ) -> None:
        if not restaurants or self.config.num_days <= 0:
            return
        meals_per_day = 2 if self.config.daily_end_time >= 19 * 60 else 1
        max_restaurants = self.config.num_days * meals_per_day
        for idx, restaurant in enumerate(restaurants[:max_restaurants]):
            day_pools[idx % self.config.num_days]["restaurants"].append(restaurant)

    def _assign_balanced_sweep(
        self,
        day_pools: list[dict[str, list[Any]]],
        places: list[Any],
    ) -> None:
        if not places or self.config.num_days <= 0:
            return
        ordered = sorted(
            places,
            key=lambda place: (
                self._angle_from_hotel(place),
                self._travel_from_hotel(place),
                place.candidate_rank,
            ),
        )
        targets = self._balanced_count_targets(len(ordered))
        cursor = 0
        for day_idx, target in enumerate(targets):
            for _ in range(target):
                if cursor >= len(ordered):
                    break
                day_pools[day_idx]["attractions"].append(ordered[cursor])
                cursor += 1

        while cursor < len(ordered):
            place = ordered[cursor]
            cursor += 1
            target_idx = min(
                range(self.config.num_days),
                key=lambda idx: (
                    len(day_pools[idx]["attractions"]),
                    self._day_load(day_pools[idx]),
                ),
            )
            day_pools[target_idx]["attractions"].append(place)

    def _rebalance(self, day_pools: list[dict[str, list[Any]]]) -> None:
        if self.config.num_days <= 1:
            return

        for idx, pool in enumerate(day_pools):
            while len(pool["attractions"]) < self.config.target_nonmeal_per_day:
                donor_idx = self._richest_donor(day_pools)
                if donor_idx is None or donor_idx == idx:
                    break
                donor = day_pools[donor_idx]["attractions"]
                if len(donor) <= 1:
                    break
                moved = min(donor, key=lambda p: self._sector_distance(p, idx))
                donor.remove(moved)
                pool["attractions"].append(moved)

        changed = True
        guard = 0
        while changed and guard < 1000:
            guard += 1
            changed = False
            for idx, pool in enumerate(day_pools):
                if self._day_load(pool) <= self.config.daily_effective * MAX_LOAD_RATIO:
                    continue
                target_idx = self._lightest_day(day_pools, exclude=idx)
                if target_idx is None:
                    continue
                movable = [
                    p
                    for p in pool["attractions"]
                    if len(day_pools[target_idx]["attractions"]) < self.config.target_nonmeal_per_day
                    or self._day_load(day_pools[target_idx]) < self.config.daily_effective
                ]
                if not movable:
                    continue
                moved = max(movable, key=lambda p: self._travel_from_hotel(p))
                pool["attractions"].remove(moved)
                day_pools[target_idx]["attractions"].append(moved)
                changed = True

    def _warnings(
        self,
        day_pools: list[dict[str, list[Any]]],
        day_loads: list[int],
    ) -> list[str]:
        warnings: list[str] = []
        for idx, pool in enumerate(day_pools):
            attractions = len(pool["attractions"])
            if attractions < min(MIN_POOL_PER_DAY, self.config.target_nonmeal_per_day):
                warnings.append(
                    f"Day {idx + 1}: only {attractions} non-meal POIs after rebalance"
                )
            if not pool["restaurants"]:
                warnings.append(f"Day {idx + 1}: no restaurant assigned")
            if day_loads[idx] > self.config.daily_effective * 1.1:
                warnings.append(
                    f"Day {idx + 1}: assignment overload load={day_loads[idx]}m effective={self.config.daily_effective}m"
                )
        return warnings

    def _day_load(self, pool: dict[str, list[Any]]) -> int:
        return sum(self._poi_load(place) for place in pool["attractions"])

    def _poi_load(self, poi: Any) -> int:
        hotel_travel = self._travel_from_hotel(poi)
        local_allowance = min(60, max(15, round(hotel_travel * 0.65)))
        return max(30, int(poi.visit_duration or 0)) + local_allowance

    def _travel_from_hotel(self, place: Any) -> int:
        return int(self.travel_matrix.get((self.config.hotel.id, place.id), 25))

    def _angle_from_hotel(self, place: Any) -> float:
        angle = math.atan2(
            place.latitude - self.config.hotel.latitude,
            place.longitude - self.config.hotel.longitude,
        )
        return (angle + 2 * math.pi) % (2 * math.pi)

    def _sector_distance(self, place: Any, sector_idx: int) -> float:
        if self.config.num_days <= 1:
            return 0.0
        sector_size = (2 * math.pi) / self.config.num_days
        center = (sector_idx + 0.5) * sector_size
        diff = abs(self._angle_from_hotel(place) - center)
        return min(diff, 2 * math.pi - diff)

    def _balanced_count_targets(self, total_count: int) -> list[int]:
        if self.config.num_days <= 0:
            return []
        base = total_count // self.config.num_days
        remainder = total_count % self.config.num_days
        return [
            base + (1 if idx < remainder else 0)
            for idx in range(self.config.num_days)
        ]

    def _richest_donor(self, day_pools: list[dict[str, list[Any]]]) -> int | None:
        candidates = [
            idx
            for idx, pool in enumerate(day_pools)
            if len(pool["attractions"]) > max(1, self.config.target_nonmeal_per_day)
        ]
        if not candidates:
            candidates = [
                idx for idx, pool in enumerate(day_pools) if len(pool["attractions"]) > 1
            ]
        if not candidates:
            return None
        return max(candidates, key=lambda idx: len(day_pools[idx]["attractions"]))

    def _lightest_day(
        self,
        day_pools: list[dict[str, list[Any]]],
        exclude: int,
    ) -> int | None:
        candidates = [idx for idx in range(self.config.num_days) if idx != exclude]
        if not candidates:
            return None
        return min(candidates, key=lambda idx: self._day_load(day_pools[idx]))
