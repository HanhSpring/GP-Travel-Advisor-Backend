from __future__ import annotations

import math
from dataclasses import dataclass, field
from typing import Any

from app.services.itinerary import utils


MIN_POOL_PER_DAY = 4
MAX_LOAD_RATIO = 1.0
LUNCH_BLOCK_MINUTES = 80
POI_TARGET_TIME_SLICE_MINUTES = 90
POI_TARGET_MAX_PER_DAY = 10
MEAL_DURATION_MINUTES = 75
MAX_RESTAURANT_OPTIONS_PER_DAY = 2
# Cafes are injected via their own greedy nearest-cluster pass (separate from
# restaurants, separate from attraction K-Means) — cap at 2/day (bumped from 1)
# so a dense cafe cluster near a day's centroid can't stack many cafe stops
# onto the same day (e.g. "6 cups of milk tea in one day"), while still giving
# the CP-SAT solver a spare candidate so a cafe doesn't vanish entirely once
# scheduling gets tight (cafes are still soft-prioritized, not enforced like
# the lunch/dinner restaurant slot — see scheduler_v2.py's cafe utility weight).
MAX_CAFE_OPTIONS_PER_DAY = 2
REBALANCE_MAX_ITERATIONS = 48
BACKUP_NONMEAL_PER_DAY = 2
CANDIDATE_POOL_LOAD_RATIO = 1.25
BOUNDARY_REBALANCE_RATIO = 1.35
BOUNDARY_CLUSTER_MAX_MINUTES = 90
BOUNDARY_MOVE_MAX_EXTRA_MINUTES = 45
REMOTE_FROM_HOTEL_MINUTES = 60


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

    @property
    def max_nonmeal_per_day(self) -> int:
        if self.daily_effective <= 0:
            return self.target_nonmeal_per_day
        by_time = max(
            self.target_nonmeal_per_day,
            self.daily_effective // POI_TARGET_TIME_SLICE_MINUTES,
        )
        return max(1, min(POI_TARGET_MAX_PER_DAY, int(by_time)))

    @property
    def max_nonmeal_total(self) -> int:
        return max(0, self.num_days * self.max_nonmeal_per_day)

    @property
    def planner_pool_cap_per_day(self) -> int:
        return max(1, self.max_nonmeal_per_day + BACKUP_NONMEAL_PER_DAY)

    @property
    def meal_slots_per_day(self) -> int:
        return 2 if self.daily_end_time >= 19 * 60 else 1

    @property
    def restaurant_option_limit(self) -> int:
        return max(1, min(MAX_RESTAURANT_OPTIONS_PER_DAY, self.meal_slots_per_day))

    @property
    def cafe_option_limit(self) -> int:
        return MAX_CAFE_OPTIONS_PER_DAY

    @property
    def primary_daily_effective(self) -> int:
        reserve = MEAL_DURATION_MINUTES + (30 if self.meal_slots_per_day > 1 else 0)
        return max(120, self.daily_effective - reserve)


@dataclass
class AssignmentResult:
    day_pools: list[dict[str, list[Any]]]
    day_loads: list[int]
    warnings: list[str] = field(default_factory=list)
    dropped_points: list[Any] = field(default_factory=list)


class ConstrainedKMeansAssignment:
    """Capacity-constrained geographic clustering shared by GA and CP-SAT."""

    def __init__(
        self,
        config: AssignmentConfig,
        travel_matrix: dict[tuple[str, str], int],
        max_iterations: int = 30,
    ):
        self.config = config
        self.travel_matrix = travel_matrix
        self.max_iterations = max(1, max_iterations)

    def assign(self, places: list[Any]) -> AssignmentResult:
        candidates = self._deduplicate(
            [
                place
                for place in places
                if place.place_type
                in {"attraction", "restaurant", "cafe", "entertainment"}
            ]
        )
        primary = [
            place for place in candidates if place.place_type != "restaurant"
        ]
        restaurants = [
            place for place in candidates if place.place_type == "restaurant"
        ]
        day_pools = self._new_day_pools()
        if not primary:
            return AssignmentResult(
                day_pools=day_pools,
                day_loads=[0] * self.config.num_days,
                warnings=["constrained_kmeans: no non-food candidates"],
            )

        cluster_count = min(self.config.num_days, len(primary))
        # Clustering decides which POIs belong together geographically; it must
        # not decide how many POIs the day will finally visit.  Keep every
        # non-meal candidate available to the day solver and use only a very
        # small lower bound to avoid an empty day.
        lower = 1 if len(primary) >= cluster_count else 0
        upper = len(primary)
        seeds = self._initialize_centroids(primary, [], cluster_count)
        locked_seed_ids = {str(seed.id): index for index, seed in enumerate(seeds)}
        centroids = [(float(seed.latitude), float(seed.longitude)) for seed in seeds]
        assignments: dict[str, int] = {}

        for _ in range(self.max_iterations):
            updated = self._assign_with_capacity(
                primary,
                centroids,
                upper,
                locked_seed_ids,
            )
            new_centroids = self._update_centroids(primary, updated, centroids)
            converged = updated == assignments and self._centroids_close(
                centroids, new_centroids
            )
            assignments = updated
            centroids = new_centroids
            if converged:
                break

        self._repair_lower_capacity(primary, assignments, centroids, lower)

        for cluster_index in range(cluster_count):
            cluster_places = [
                place
                for place in primary
                if assignments.get(str(place.id)) == cluster_index
            ]
            pool = day_pools[cluster_index]
            for place in sorted(cluster_places, key=self._rank_key):
                pool["attractions"].append(place)
            pool["allocation_method"] = "constrained_kmeans"
            pool["day_cluster_center"] = centroids[cluster_index]
            pool["base_candidate_count"] = len(cluster_places)
            pool["capacity_lower"] = lower
            pool["capacity_upper"] = upper

        rebalanced_count = self._rebalance_day_pools(day_pools, lower, upper)
        self._refresh_day_cluster_centers(day_pools)

        self._inject_restaurant_options(
            day_pools,
            restaurants,
            max_options=self.config.restaurant_option_limit,
        )
        for pool in day_pools:
            pool["injected_restaurant_count"] = len(pool["restaurants"])
            pool["final_candidate_count"] = (
                len(pool["attractions"]) + len(pool["restaurants"])
            )
            pool["primary_load_minutes"] = self._primary_day_load(pool)

        day_loads = [self._day_load(pool) for pool in day_pools]
        warnings = [
            (
                "constrained_kmeans "
                f"k={self.config.num_days} primary={len(primary)} "
                f"soft_lower={lower} upper={upper} "
                f"restaurant_options={len(restaurants)} "
                f"primary_daily_effective={self.config.primary_daily_effective} "
                "pool_cap=unbounded "
                f"rebalance_moves={rebalanced_count} retained={len(primary)}"
            )
        ]
        for index, pool in enumerate(day_pools):
            primary_count = len(pool["attractions"])
            if primary_count < lower:
                warnings.append(
                    f"Day {index + 1}: primary cluster size={primary_count} "
                    f"below soft lower={lower}"
                )
            primary_load = self._primary_day_load(pool)
            if primary_load > self.config.primary_daily_effective * 1.05:
                warnings.append(
                    f"Day {index + 1}: primary load={primary_load}m "
                    f"above effective={self.config.primary_daily_effective}m "
                    f"(pool_ratio={CANDIDATE_POOL_LOAD_RATIO})"
                )
            if not pool["restaurants"]:
                warnings.append(f"Day {index + 1}: no nearby restaurant option")
        return AssignmentResult(
            day_pools=day_pools,
            day_loads=day_loads,
            warnings=warnings,
        )

    def _inject_restaurant_options(
        self,
        day_pools: list[dict[str, list[Any]]],
        restaurants: list[Any],
        max_options: int,
    ) -> None:
        if not restaurants:
            return
        for pool in day_pools:
            center = pool.get("day_cluster_center")
            if center is None:
                continue
            ranked = sorted(
                restaurants,
                key=lambda restaurant: (
                    self._haversine_km(
                        restaurant.latitude,
                        restaurant.longitude,
                        center[0],
                        center[1],
                    ),
                    self._rank_key(restaurant),
                ),
            )
            pool["restaurants"] = ranked[:max_options]

    def _new_day_pools(self) -> list[dict[str, list[Any]]]:
        return [
            {"attractions": [], "restaurants": []}
            for _ in range(self.config.num_days)
        ]

    @staticmethod
    def _deduplicate(places: list[Any]) -> list[Any]:
        seen: set[str] = set()
        result: list[Any] = []
        for place in sorted(places, key=ConstrainedKMeansAssignment._rank_key):
            place_id = str(place.id)
            if place_id in seen:
                continue
            seen.add(place_id)
            result.append(place)
        return result

    @staticmethod
    def _rank_key(place: Any) -> tuple[int, str]:
        return int(getattr(place, "candidate_rank", 10**9)), str(place.id)

    @staticmethod
    def _capacity_bounds(
        total: int,
        clusters: int,
        hard_upper: int,
    ) -> tuple[int, int]:
        if clusters <= 0:
            return 0, 0
        average = total / clusters
        tolerance = 1 if total >= clusters * 2 else 0
        lower = max(0, math.floor(average) - tolerance)
        upper = max(1, min(hard_upper, math.ceil(average) + tolerance))
        while lower * clusters > total:
            lower -= 1
        while upper * clusters < total:
            upper += 1
            if upper >= hard_upper:
                upper = hard_upper
                break
        return lower, upper

    def _initialize_centroids(
        self,
        candidates: list[Any],
        restaurants: list[Any],
        cluster_count: int,
    ) -> list[Any]:
        ordered_restaurants = sorted(restaurants, key=self._rank_key)
        ordered_candidates = sorted(candidates, key=self._rank_key)
        seed_pool = ordered_restaurants or ordered_candidates
        seeds = [seed_pool[0]]

        while len(seeds) < cluster_count:
            preferred_pool = [
                place
                for place in ordered_restaurants
                if str(place.id) not in {str(seed.id) for seed in seeds}
            ]
            fallback_pool = [
                place
                for place in ordered_candidates
                if str(place.id) not in {str(seed.id) for seed in seeds}
            ]
            pool = preferred_pool or fallback_pool
            if not pool:
                break
            next_seed = max(
                pool,
                key=lambda place: (
                    min(
                        self._haversine_km(
                            place.latitude,
                            place.longitude,
                            seed.latitude,
                            seed.longitude,
                        )
                        for seed in seeds
                    ),
                    -self._rank_key(place)[0],
                ),
            )
            seeds.append(next_seed)
        return seeds

    def _assign_with_capacity(
        self,
        candidates: list[Any],
        centroids: list[tuple[float, float]],
        upper: int,
        locked_seed_ids: dict[str, int],
    ) -> dict[str, int]:
        assignments = dict(locked_seed_ids)
        sizes = [0] * len(centroids)
        restaurant_sizes = [0] * len(centroids)
        loads = [0] * len(centroids)
        candidates_by_id = {str(place.id): place for place in candidates}
        for place_id, cluster_index in locked_seed_ids.items():
            place = candidates_by_id[place_id]
            sizes[cluster_index] += 1
            loads[cluster_index] += self._poi_load(place, centroids[cluster_index])
            if place.place_type == "restaurant":
                restaurant_sizes[cluster_index] += 1

        unassigned = [
            place for place in candidates if str(place.id) not in locked_seed_ids
        ]
        remaining_restaurants = [
            place for place in unassigned if place.place_type == "restaurant"
        ]
        remaining_nonrestaurants = [
            place for place in unassigned if place.place_type != "restaurant"
        ]
        restaurant_targets = self._balanced_targets(
            sum(1 for place in candidates if place.place_type == "restaurant"),
            len(centroids),
        )

        def distances(place: Any) -> list[float]:
            return [
                self._haversine_km(
                    place.latitude,
                    place.longitude,
                    centroid[0],
                    centroid[1],
                )
                for centroid in centroids
            ]

        distance_cache = {str(place.id): distances(place) for place in unassigned}

        def regret(place: Any) -> tuple[float, int]:
            ordered = sorted(distance_cache[str(place.id)])
            value = ordered[1] - ordered[0] if len(ordered) > 1 else ordered[0]
            return value, -self._rank_key(place)[0]

        def assign_batch(batch: list[Any], restaurant_batch: bool) -> None:
            for place in sorted(batch, key=regret, reverse=True):
                ordered_clusters = sorted(
                    range(len(centroids)),
                    key=lambda index: (
                        distance_cache[str(place.id)][index],
                        sizes[index],
                        index,
                    ),
                )
                eligible = [
                    index
                    for index in ordered_clusters
                    if sizes[index] < upper
                    and (
                        loads[index]
                        + self._poi_load(place, centroids[index])
                        <= self.config.primary_daily_effective
                        * CANDIDATE_POOL_LOAD_RATIO
                    )
                    and (
                        not restaurant_batch
                        or restaurant_sizes[index] < restaurant_targets[index]
                    )
                ]
                if not eligible:
                    # When every cluster is above its soft time load, proximity
                    # wins. OR-Tools will later choose the feasible subset.
                    eligible = ordered_clusters
                target = eligible[0]
                assignments[str(place.id)] = target
                sizes[target] += 1
                loads[target] += self._poi_load(place, centroids[target])
                if restaurant_batch:
                    restaurant_sizes[target] += 1

        # Allocate meal coverage before other POIs so a dense attraction region
        # cannot consume all capacity and leave another day without a restaurant.
        assign_batch(remaining_restaurants, restaurant_batch=True)
        assign_batch(remaining_nonrestaurants, restaurant_batch=False)
        return assignments

    @staticmethod
    def _balanced_targets(total: int, clusters: int) -> list[int]:
        if clusters <= 0:
            return []
        base = total // clusters
        remainder = total % clusters
        return [
            base + (1 if index < remainder else 0)
            for index in range(clusters)
        ]

    def _repair_lower_capacity(
        self,
        candidates: list[Any],
        assignments: dict[str, int],
        centroids: list[tuple[float, float]],
        lower: int,
    ) -> None:
        if lower <= 0:
            return
        by_id = {str(place.id): place for place in candidates}
        sizes = [
            sum(1 for cluster in assignments.values() if cluster == index)
            for index in range(len(centroids))
        ]
        restaurant_counts = [
            sum(
                1
                for place_id, cluster in assignments.items()
                if cluster == index and by_id[place_id].place_type == "restaurant"
            )
            for index in range(len(centroids))
        ]

        for target in range(len(centroids)):
            while sizes[target] < lower:
                donors = [
                    index
                    for index in range(len(centroids))
                    if sizes[index] > lower
                ]
                if not donors:
                    return
                movable: list[tuple[float, Any, int]] = []
                for allow_restaurant in (False, True):
                    for donor in donors:
                        for place_id, cluster in assignments.items():
                            if cluster != donor:
                                continue
                            place = by_id[place_id]
                            if place.place_type == "restaurant":
                                if not allow_restaurant:
                                    continue
                                if restaurant_counts[target] > 0:
                                    continue
                                if restaurant_counts[donor] <= 1:
                                    continue
                            distance = self._haversine_km(
                                place.latitude,
                                place.longitude,
                                centroids[target][0],
                                centroids[target][1],
                            )
                            movable.append((distance, place, donor))
                    if movable:
                        break
                if not movable:
                    return
                _, place, donor = min(
                    movable,
                    key=lambda item: (item[0], self._rank_key(item[1])),
                )
                assignments[str(place.id)] = target
                sizes[donor] -= 1
                sizes[target] += 1
                if place.place_type == "restaurant":
                    restaurant_counts[donor] -= 1
                    restaurant_counts[target] += 1

    def _update_centroids(
        self,
        candidates: list[Any],
        assignments: dict[str, int],
        previous: list[tuple[float, float]],
    ) -> list[tuple[float, float]]:
        result: list[tuple[float, float]] = []
        for cluster_index in range(len(previous)):
            members = [
                place
                for place in candidates
                if assignments.get(str(place.id)) == cluster_index
            ]
            centroid = utils.compute_centroid(members)
            result.append(centroid if centroid is not None else previous[cluster_index])
        return result

    @staticmethod
    def _centroids_close(
        old: list[tuple[float, float]],
        new: list[tuple[float, float]],
        epsilon: float = 1e-7,
    ) -> bool:
        return all(
            abs(old_lat - new_lat) <= epsilon
            and abs(old_lng - new_lng) <= epsilon
            for (old_lat, old_lng), (new_lat, new_lng) in zip(old, new)
        )

    def _warnings(
        self,
        day_pools: list[dict[str, list[Any]]],
        restaurants_count: int,
        lower: int,
        upper: int,
        total_candidates: int,
    ) -> list[str]:
        warnings = [
            (
                "constrained_kmeans "
                f"k={self.config.num_days} candidates={total_candidates} "
                f"capacity=[{lower},{upper}] restaurant_seeds="
                f"{min(restaurants_count, self.config.num_days)}"
            )
        ]
        if restaurants_count < self.config.num_days:
            warnings.append(
                "restaurant coverage infeasible: "
                f"restaurants={restaurants_count} days={self.config.num_days}"
            )
        for index, pool in enumerate(day_pools):
            size = len(pool["attractions"]) + len(pool["restaurants"])
            if size < lower or size > upper:
                warnings.append(
                    f"Day {index + 1}: cluster size={size} outside [{lower},{upper}]"
                )
            if not pool["restaurants"]:
                warnings.append(f"Day {index + 1}: no restaurant assigned")
        return warnings

    def _rebalance_day_pools(
        self,
        day_pools: list[dict[str, list[Any]]],
        lower: int,
        upper: int,
    ) -> int:
        moves = 0
        if len(day_pools) <= 1:
            return moves

        for _ in range(max(REBALANCE_MAX_ITERATIONS, self.config.num_days * 8)):
            day_loads = [self._primary_day_load(pool) for pool in day_pools]
            move_options: list[tuple[float, int, int, int, Any]] = []

            for source_idx, source_pool in enumerate(day_pools):
                if len(source_pool["attractions"]) <= max(1, lower):
                    continue
                source_center = self._pool_center(source_pool)
                if source_center is None:
                    continue

                for target_idx, target_pool in enumerate(day_pools):
                    if target_idx == source_idx:
                        continue
                    target_center = self._pool_center(target_pool)
                    if target_center is None:
                        continue
                    target_load = max(1, day_loads[target_idx])
                    if day_loads[source_idx] <= target_load * BOUNDARY_REBALANCE_RATIO:
                        continue
                    if (
                        self._center_travel_minutes(source_center, target_center)
                        > BOUNDARY_CLUSTER_MAX_MINUTES
                    ):
                        continue

                    for place in source_pool["attractions"]:
                        source_fit = self._travel_to_pool(place, source_pool)
                        target_fit = self._travel_to_pool(place, target_pool)
                        extra_minutes = target_fit - source_fit
                        if extra_minutes > BOUNDARY_MOVE_MAX_EXTRA_MINUTES:
                            continue
                        # Keep genuinely remote POIs with their remote cluster;
                        # only ordinary boundary points may cross clusters.
                        if (
                            self._travel_from_hotel(place)
                            >= REMOTE_FROM_HOTEL_MINUTES
                            and target_fit > source_fit
                        ):
                            continue

                        source_place_load = self._poi_load(place, source_center)
                        target_place_load = self._poi_load(place, target_center)
                        old_gap = abs(day_loads[source_idx] - day_loads[target_idx])
                        new_gap = abs(
                            (day_loads[source_idx] - source_place_load)
                            - (day_loads[target_idx] + target_place_load)
                        )
                        if new_gap >= old_gap:
                            continue
                        move_options.append(
                            (
                                extra_minutes,
                                new_gap,
                                source_idx,
                                target_idx,
                                place,
                            )
                        )

            if not move_options:
                break
            _, _, source_idx, target_idx, place = min(
                move_options,
                key=lambda option: (
                    option[0],
                    option[1],
                    self._rank_key(option[4]),
                ),
            )
            day_pools[source_idx]["attractions"].remove(place)
            day_pools[target_idx]["attractions"].append(place)
            self._refresh_day_cluster_centers(day_pools)
            moves += 1
        return moves

    def _trim_primary_candidates(
        self,
        day_pools: list[dict[str, list[Any]]],
        upper: int,
    ) -> int:
        trimmed = 0
        max_load = self.config.primary_daily_effective * CANDIDATE_POOL_LOAD_RATIO
        for pool in day_pools:
            while pool["attractions"] and (
                len(pool["attractions"]) > upper
                or self._primary_day_load(pool) > max_load
            ):
                center = self._pool_center(pool)
                removed = max(
                    pool["attractions"],
                    key=lambda place: (
                        self._removability_weight(place),
                        self._poi_load(place, center),
                        self._travel_from_hotel(place),
                        -self._rank_key(place)[0],
                    ),
                )
                pool["attractions"].remove(removed)
                trimmed += 1
        return trimmed

    def _refresh_day_cluster_centers(
        self,
        day_pools: list[dict[str, list[Any]]],
    ) -> None:
        for pool in day_pools:
            centroid = utils.compute_centroid(pool.get("attractions", []))
            if centroid is not None:
                pool["day_cluster_center"] = centroid

    def _pool_center(self, pool: dict[str, list[Any]]) -> tuple[float, float] | None:
        centroid = utils.compute_centroid(pool.get("attractions", []))
        if centroid is not None:
            return centroid
        return pool.get("day_cluster_center")

    def _day_fit_cost(self, place: Any, pool: dict[str, list[Any]]) -> tuple[float, int]:
        center = self._pool_center(pool)
        if center is None:
            return (0.0, self._travel_from_hotel(place))
        return (
            self._haversine_km(
                float(place.latitude),
                float(place.longitude),
                float(center[0]),
                float(center[1]),
            ),
            self._travel_from_hotel(place),
        )

    def _travel_to_pool(self, place: Any, pool: dict[str, list[Any]]) -> int:
        peers = [
            peer
            for peer in pool.get("attractions", [])
            if str(peer.id) != str(place.id)
        ]
        travel_values = []
        for peer in peers:
            value = self.travel_matrix.get((place.id, peer.id))
            if value is None:
                value = self.travel_matrix.get((peer.id, place.id))
            if value is not None and int(value) >= 0:
                travel_values.append(int(value))
        if travel_values:
            nearest = sorted(travel_values)[:3]
            return round(sum(nearest) / len(nearest))
        center = self._pool_center(pool)
        return self._estimate_cluster_minutes(place, center) if center else 0

    def _center_travel_minutes(
        self,
        left: tuple[float, float],
        right: tuple[float, float],
    ) -> int:
        distance_km = self._haversine_km(
            float(left[0]),
            float(left[1]),
            float(right[0]),
            float(right[1]),
        )
        return max(1, round(distance_km * 4.5))

    def _primary_day_load(self, pool: dict[str, list[Any]]) -> int:
        center = self._pool_center(pool)
        return sum(
            self._poi_load(place, center)
            for place in pool["attractions"]
        )

    @staticmethod
    def _removability_weight(place: Any) -> int:
        place_type = str(getattr(place, "place_type", "attraction"))
        if place_type == "attraction":
            return 3
        if place_type == "cafe":
            return 2
        if place_type == "entertainment":
            return 1
        return 0

    def _day_load(self, pool: dict[str, list[Any]]) -> int:
        return sum(
            self._poi_load(place, self._pool_center(pool))
            for place in pool["attractions"] + pool["restaurants"]
        )

    def _poi_load(
        self,
        place: Any,
        center: tuple[float, float] | None = None,
    ) -> int:
        base_duration = max(30, int(getattr(place, "visit_duration", 0) or 0))
        hotel_travel = self._travel_from_hotel(place)
        anchor_travel = hotel_travel
        if center is not None:
            cluster_travel = self._estimate_cluster_minutes(place, center)
            anchor_travel = min(hotel_travel, cluster_travel)
        local_allowance = min(60, max(15, round(anchor_travel * 0.65)))
        return base_duration + local_allowance

    def _travel_from_hotel(self, place: Any) -> int:
        return int(self.travel_matrix.get((self.config.hotel.id, place.id), 25))

    def _estimate_cluster_minutes(
        self,
        place: Any,
        center: tuple[float, float],
    ) -> int:
        distance_km = self._haversine_km(
            float(place.latitude),
            float(place.longitude),
            float(center[0]),
            float(center[1]),
        )
        return max(10, int(round(distance_km * 4.5)))

    @staticmethod
    def _haversine_km(
        lat1: float,
        lng1: float,
        lat2: float,
        lng2: float,
    ) -> float:
        return utils.haversine_km_coords(lat1, lng1, lat2, lng2)


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
        trimmed_count = self._trim_overloaded_days(day_pools)
        day_loads = [self._day_load(pool) for pool in day_pools]
        warnings = self._warnings(day_pools, day_loads)
        warnings.insert(
            0,
            (
                "assignment_v2 "
                f"max_nonmeal_per_day={self.config.max_nonmeal_per_day} "
                f"max_nonmeal_total={self.config.max_nonmeal_total} "
                f"daily_effective={self.config.daily_effective} "
                f"trimmed={trimmed_count}"
            ),
        )
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
        current_total = sum(len(pool["attractions"]) for pool in day_pools)
        remaining_slots = max(0, self.config.max_nonmeal_total - current_total)
        for place in ordered[:remaining_slots]:
            place_load = self._poi_load(place)
            candidates = [
                idx
                for idx, pool in enumerate(day_pools)
                if len(pool["attractions"]) < self.config.max_nonmeal_per_day
                and self._day_load(pool) + place_load
                <= self.config.daily_effective * MAX_LOAD_RATIO
            ]
            if not candidates:
                candidates = [
                    idx
                    for idx, pool in enumerate(day_pools)
                    if len(pool["attractions"])
                    < min(
                        MIN_POOL_PER_DAY,
                        self.config.target_nonmeal_per_day,
                        self.config.max_nonmeal_per_day,
                    )
                ]
            if not candidates:
                break
            target_idx = min(
                candidates,
                key=lambda idx: (
                    self._sector_distance(place, idx),
                    self._day_load(day_pools[idx]),
                    len(day_pools[idx]["attractions"]),
                ),
            )
            day_pools[target_idx]["attractions"].append(place)

        # Do not force every remaining candidate into the daily GA pools.
        # Two-Tower may return many backups; daily GA should only receive the
        # amount a user can realistically visit in the selected time window.

    def _rebalance(self, day_pools: list[dict[str, list[Any]]]) -> None:
        if self.config.num_days <= 1:
            return

        for idx, pool in enumerate(day_pools):
            while len(pool["attractions"]) < self.config.target_nonmeal_per_day:
                donor_idx = self._richest_donor(day_pools)
                if donor_idx is None or donor_idx == idx:
                    break
                if len(pool["attractions"]) >= self.config.max_nonmeal_per_day:
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
                    if len(day_pools[target_idx]["attractions"])
                    < self.config.max_nonmeal_per_day
                    and (
                        len(day_pools[target_idx]["attractions"])
                        < self.config.target_nonmeal_per_day
                        or self._day_load(day_pools[target_idx])
                        < self.config.daily_effective
                    )
                ]
                if not movable:
                    continue
                moved = max(movable, key=lambda p: self._travel_from_hotel(p))
                pool["attractions"].remove(moved)
                day_pools[target_idx]["attractions"].append(moved)
                changed = True

    def _trim_overloaded_days(self, day_pools: list[dict[str, list[Any]]]) -> int:
        max_load = self.config.daily_effective * MAX_LOAD_RATIO
        if max_load <= 0:
            return 0
        trimmed_count = 0
        for pool in day_pools:
            while len(pool["attractions"]) > 1 and self._day_load(pool) > max_load:
                removed = max(
                    pool["attractions"],
                    key=lambda place: (
                        self._poi_load(place),
                        place.candidate_rank,
                    ),
                )
                pool["attractions"].remove(removed)
                trimmed_count += 1
        return trimmed_count

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
