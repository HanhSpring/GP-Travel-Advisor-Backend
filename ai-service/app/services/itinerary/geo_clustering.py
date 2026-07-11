import math
import numpy as np
from typing import Any, List, Dict, Tuple, Optional

try:
    from sklearn.cluster import HDBSCAN
except ImportError:
    HDBSCAN = None

from app.services.itinerary.assignment import (
    AssignmentConfig,
    AssignmentResult,
    MEAL_DURATION_MINUTES,
)
from app.services.itinerary.clustering_debug_viz import ClusteringDebugRecorder
from app.services.itinerary import utils


class GeoClusteringAssignment:
    """HDBSCAN + Assignment Refinement geo-clustering."""

    BALANCED_SPLIT_MAX_ITER = 20
    MAX_MERGE_MINUTES = 45
    MIN_VIABLE_COUNT = 2
    REMOTE_THRESHOLD_MINUTES = 60
    # Higher bar than REMOTE_THRESHOLD_MINUTES (used internally for noise-point
    # merging) — this one gates whether we bother the user with a "do you want
    # to visit this far-away cluster" confirmation. Should only fire for
    # genuine day-trip-away regions (e.g. Cần Giờ), not merely "a bit far".
    REMOTE_CONFIRM_THRESHOLD_MINUTES = 90

    def __init__(
        self,
        config: AssignmentConfig,
        travel_matrix: Dict[Tuple[str, str], int],
    ):
        self.config = config
        self.travel_matrix = travel_matrix

    def assign(
        self,
        places: List[Any],
        region_day_allocations: Optional[List[Dict[str, Any]]] = None,
    ) -> AssignmentResult:
        all_places = self._deduplicate(places)
        # Cafes are deliberately excluded from the K-Means day-split input —
        # see _inject_cafes for why (a dense cafe cluster near one day's
        # centroid could otherwise dominate that day's attraction slots).
        primary = [
            p for p in all_places if p.place_type in {"attraction", "entertainment"}
        ]
        restaurants = [p for p in all_places if p.place_type == "restaurant"]
        cafes = [p for p in all_places if p.place_type == "cafe"]

        if not primary:
            return self._empty_result()

        if self.config.num_days == 1 or not HDBSCAN:
            return self._fallback_result(primary, restaurants, cafes)

        params = self._compute_adaptive_params(primary)
        debug = ClusteringDebugRecorder(f"assign-{self.config.num_days}days")

        # Region-allocation wizard (see GeoClusteringAssignment.detect_regions)
        # has already asked the user how many days each region gets — force
        # those day-pools directly instead of re-discovering/re-balancing
        # anything via DBSCAN. Every region (not just remote ones) goes
        # through this path once the wizard has run.
        forced_day_pools: List[dict] = []
        reserved_days = 0
        allocated_ids: set = set()
        if region_day_allocations:
            for allocation in region_day_allocations:
                place_ids = {str(pid) for pid in allocation.get("place_ids", [])}
                days = max(1, int(allocation.get("days", 1)))
                points = [p for p in primary if str(p.id) in place_ids]
                if not points:
                    continue
                allocated_ids.update(str(p.id) for p in points)
                subs = self._constrained_kmeans_split(points, days) if days > 1 else [points]
                for sub in subs:
                    forced_day_pools.append({
                        "attractions": sorted(sub, key=self._rank_key),
                        "restaurants": [],
                        "cafes": [],
                    })
                reserved_days += len(subs)

            if reserved_days > self.config.num_days:
                raise ValueError(
                    "Số ngày cần cho các khu vực đã chọn "
                    f"({reserved_days} ngày) vượt quá số ngày chuyến đi "
                    f"({self.config.num_days} ngày). Vui lòng bỏ bớt khu vực "
                    "hoặc tăng thêm ngày cho chuyến đi."
                )

            debug.record(
                "5. K-Means chia ngày theo vùng đã chọn",
                {
                    f"Day {i + 1}": pool["attractions"]
                    for i, pool in enumerate(forced_day_pools)
                },
            )

        # Anything not covered by an explicit allocation (normally empty,
        # since the caller filters candidates down to confirmed regions
        # before this point) still goes through the ordinary geo-clustering
        # pipeline for whatever day budget remains.
        remaining_primary = [p for p in primary if str(p.id) not in allocated_ids]
        available_days = max(0, self.config.num_days - reserved_days)

        if remaining_primary and available_days > 0:
            clusters, noise = self._dbscan_cluster(remaining_primary)
            day_pools, remaining_days, deferred = self._initial_day_assignment(
                clusters, params, available_days
            )
            dropped = self._process_noise(noise, day_pools, forced_day_pools)
            self._balance_day_count(
                day_pools, remaining_days, deferred, dropped, available_days
            )
        else:
            day_pools, dropped = [], []

        all_day_pools = day_pools + forced_day_pools
        self._compute_cluster_stats(all_day_pools)

        self._inject_restaurants(all_day_pools, restaurants)
        self._inject_cafes(all_day_pools, cafes)

        debug.save()

        return self._build_result(all_day_pools, dropped, params)

    def detect_regions(self, places: List[Any], num_days: int) -> Dict[str, Any]:
        """Cheap, hotel-independent macro-region detection for the region
        allocation wizard. Runs DBSCAN, folds noise into the nearest
        cluster, then reports each region's size/estimated max days
        relative to the central (most-POI) region — no CP-SAT and no real
        travel matrix required, since no hotel exists yet at this point.
        """
        debug = ClusteringDebugRecorder(f"detect-regions-{num_days}days")

        all_places = self._deduplicate(places)
        # Same place-type set as assign()'s K-Means day-split input (line ~50
        # below) — cafes are excluded there too (see comment on `assign`), so
        # excluding them here too keeps a region's reported size consistent
        # with how many points K-Means will actually split into days later.
        # Using a wider set here (e.g. including cafe) previously made the
        # wizard's region sizes disagree with the real day-split counts.
        primary = [
            p for p in all_places if p.place_type in {"attraction", "entertainment"}
        ]
        if not primary:
            return {"regions": [], "estimated_total_days": 0, "num_days": num_days}

        if len(primary) <= 3 or not HDBSCAN:
            clusters: Dict[int, List[Any]] = {0: list(primary)}
            noise: List[Any] = []
        else:
            clusters, noise = self._dbscan_cluster(primary)

        debug.record("1. HDBSCAN raw clusters", clusters, noise)

        if not clusters:
            clusters = {0: list(primary)}
            noise = []

        for point in noise:
            best_label, best_travel = None, float("inf")
            for label, points in clusters.items():
                travel = min(self._pairwise_travel(point, peer) for peer in points)
                if travel < best_travel:
                    best_label, best_travel = label, travel
            if best_label is not None:
                clusters[best_label].append(point)

        debug.record("2. Sau khi gộp điểm noise vào cụm gần nhất", clusters)

        # DBSCAN's density-driven eps can fragment one sparse area (e.g. a
        # remote day-trip region) into several small clusters even though a
        # traveller would call it "one place". Merge clusters whose centroids
        # sit within MAX_MERGE_MINUTES of each other so the wizard offers
        # one region per practical destination, not one per DBSCAN fragment.
        merge_labels = sorted(clusters.keys(), key=lambda label: -len(clusters[label]))
        merged_clusters: Dict[int, List[Any]] = {}
        merged_centroids: Dict[int, Tuple[float, float]] = {}
        for label in merge_labels:
            points = clusters[label]
            centroid = self._pool_center({"attractions": points})
            target_label = None
            if centroid is not None:
                for existing_label, existing_centroid in merged_centroids.items():
                    if self._center_travel_minutes(existing_centroid, centroid) <= self.MAX_MERGE_MINUTES:
                        target_label = existing_label
                        break
            if target_label is None:
                merged_clusters[label] = list(points)
                if centroid is not None:
                    merged_centroids[label] = centroid
            else:
                merged_clusters[target_label].extend(points)
                merged_centroids[target_label] = self._pool_center(
                    {"attractions": merged_clusters[target_label]}
                )
        clusters = merged_clusters

        debug.record("3. Sau khi gộp vùng phân mảnh (region merge)", clusters)

        ordered_labels = sorted(clusters.keys(), key=lambda label: -len(clusters[label]))
        central_centroid = self._pool_center({"attractions": clusters[ordered_labels[0]]})

        class _Anchor:
            def __init__(self, lat: float, lon: float):
                self.id = "__virtual_central_anchor__"
                self.latitude = lat
                self.longitude = lon

        virtual_hotel = _Anchor(*central_centroid) if central_centroid else None
        previous_hotel = self.config.hotel
        self.config.hotel = virtual_hotel
        try:
            attraction_budget = self._compute_adaptive_params(primary)["attraction_budget"]
            regions = []
            for idx, label in enumerate(ordered_labels):
                points = clusters[label]
                centroid = self._pool_center({"attractions": points})
                total_visit_minutes = sum(self._poi_cost(p) for p in points)
                max_days = max(1, math.ceil(total_visit_minutes / attraction_budget))
                if idx == 0 or not virtual_hotel or not centroid:
                    travel_minutes_from_central = 0
                else:
                    travel_minutes_from_central = self._travel_to_centroid_from_place(
                        virtual_hotel, centroid
                    )
                regions.append({
                    "region_name": self._region_display_name(idx, points, centroid),
                    "place_ids": [str(p.id) for p in points],
                    "place_names": sorted(getattr(p, "name", "") for p in points),
                    "max_days": max_days,
                    "total_visit_minutes": total_visit_minutes,
                    "travel_minutes_from_central": travel_minutes_from_central,
                    "is_remote": travel_minutes_from_central > self.REMOTE_CONFIRM_THRESHOLD_MINUTES,
                })
        finally:
            self.config.hotel = previous_hotel

        # Suggested day allocation so the wizard can present a ready-to-submit
        # default instead of an empty form: the central region (regions[0],
        # already ordered densest-first) always gets first pick up to its own
        # max_days, then any still-unallocated days are borrowed from the
        # remaining regions in order of travel distance from the center
        # (nearest first) — not density order — since "borrow from the next
        # region" should mean geographically closest, not merely 2nd-largest.
        for region in regions:
            region["suggested_days"] = 0
        if regions:
            remaining = num_days
            regions[0]["suggested_days"] = min(regions[0]["max_days"], remaining)
            remaining -= regions[0]["suggested_days"]
            if remaining > 0 and len(regions) > 1:
                nearest_first = sorted(
                    range(1, len(regions)),
                    key=lambda i: regions[i]["travel_minutes_from_central"],
                )
                for i in nearest_first:
                    if remaining <= 0:
                        break
                    give = min(regions[i]["max_days"], remaining)
                    regions[i]["suggested_days"] = give
                    remaining -= give

        debug.record(
            "4. Vùng cuối cùng (region_name)",
            {r["region_name"]: clusters[label] for label, r in zip(ordered_labels, regions)},
        )
        debug.save()

        total_suggested_days = sum(r["suggested_days"] for r in regions)
        return {
            "regions": regions,
            "estimated_total_days": sum(r["max_days"] for r in regions),
            "num_days": num_days,
            # > 0 when even every detected region combined can't fill the
            # trip's day count — lets the wizard show ONE consolidated
            # "not enough places" notice instead of a hard failure later.
            "shortfall_days": max(0, num_days - total_suggested_days),
        }

    _REGION_NAME_ADMIN_KEYWORDS = (
        "Phường ", "Xã ", "Thị trấn ", "Quận ", "Huyện ", "Thị xã ", "Thành phố ",
    )

    def _region_display_name(self, idx: int, points: List[Any], centroid: Optional[Tuple[float, float]]) -> str:
        """Real, human-meaningful region name derived from the address of the
        POI nearest the region's centroid (no external geocoding call — just
        parses the ward/district segment out of the address already stored on
        the place, e.g. "..., Phường Vĩnh Ninh, Thành phố Huế" -> "Phường Vĩnh
        Ninh"). Falls back to the old generic "Vùng N" label when the nearest
        POI has no usable address segment, so this never breaks the wizard.
        """
        fallback = f"Vùng {idx + 1}"
        if not points or not centroid:
            return fallback
        anchor = type("_C", (), {"latitude": centroid[0], "longitude": centroid[1]})()
        nearest = min(points, key=lambda p: self._haversine_km(anchor, p))
        address = getattr(nearest, "address", None) or ""
        for segment in (s.strip() for s in address.split(",")):
            if any(segment.startswith(kw) for kw in self._REGION_NAME_ADMIN_KEYWORDS):
                return segment
        return fallback

    def _empty_result(self) -> AssignmentResult:
        pools = [
            {"attractions": [], "restaurants": [], "cafes": []}
            for _ in range(self.config.num_days)
        ]
        return AssignmentResult(day_pools=pools, day_loads=[0] * self.config.num_days)

    def _fallback_result(
        self, primary: List[Any], restaurants: List[Any], cafes: Optional[List[Any]] = None
    ) -> AssignmentResult:
        # For 1 day or missing sklearn, just put everything in day 1 (or round-robin)
        day_pools = []
        n = self.config.num_days
        for i in range(n):
            day_pools.append({
                "attractions": [p for idx, p in enumerate(primary) if idx % n == i],
                "restaurants": [],
                "cafes": [],
            })
        self._inject_restaurants(day_pools, restaurants)
        self._inject_cafes(day_pools, cafes or [])
        return self._build_result(day_pools, [], {"target_per_day": 0})

    def _deduplicate(self, places: List[Any]) -> List[Any]:
        seen = set()
        unique = []
        for p in sorted(places, key=self._rank_key):
            if str(p.id) not in seen:
                seen.add(str(p.id))
                unique.append(p)
        return unique

    @staticmethod
    def _rank_key(place: Any) -> float:
        return float(getattr(place, "candidate_rank", getattr(place, "rank", 999)))

    def _compute_adaptive_params(self, primary: List[Any]) -> dict:
        available = self.config.daily_available
        meal_reserve = MEAL_DURATION_MINUTES * self.config.meal_slots_per_day
        attraction_budget = max(120, available - meal_reserve - 40)

        costs = [self._poi_cost(p) for p in primary]
        avg_cost = sum(costs) / len(costs) if costs else 90
        target_per_day = max(2, min(8, round(attraction_budget / avg_cost)))

        return {
            "attraction_budget": attraction_budget,
            "avg_cost": avg_cost,
            "target_per_day": target_per_day,
        }

    def _poi_cost(self, place: Any) -> int:
        base = max(30, int(getattr(place, "visit_duration", 0) or 0))
        hotel_travel = self._travel_from_hotel(place)
        buffer = min(60, max(15, round(hotel_travel * 0.65)))
        return base + buffer

    def _travel_from_hotel(self, place: Any) -> int:
        if not self.config.hotel:
            return 0
        t = self.travel_matrix.get((self.config.hotel.id, place.id))
        if t is not None:
            return int(t)
        t = self.travel_matrix.get((place.id, self.config.hotel.id))
        if t is not None:
            return int(t)
        return self._haversine_minutes(self.config.hotel, place)

    def _haversine_minutes(self, a: Any, b: Any) -> int:
        km = self._haversine_km(a, b)
        return max(5, int(km / 30.0 * 60.0))

    def _haversine_km(self, p1: Any, p2: Any) -> float:
        return utils.haversine_km_places(p1, p2)

    def _dbscan_cluster(self, primary: List[Any]) -> Tuple[Dict[int, List[Any]], List[Any]]:
        if len(primary) <= 3:
            self.dynamic_max_merge_minutes = 20
            return {0: list(primary)}, []

        coords = np.array([[float(p.latitude), float(p.longitude)] for p in primary])
        coords_rad = np.radians(coords)

        clusterer = HDBSCAN(min_cluster_size=3, metric='haversine')
        labels = clusterer.fit_predict(coords_rad)

        clusters: Dict[int, List[Any]] = {}
        noise: List[Any] = []
        for place, label in zip(primary, labels):
            if label == -1:
                noise.append(place)
            else:
                clusters.setdefault(int(label), []).append(place)

        # HDBSCAN has no eps to derive a merge-distance budget from, unlike
        # the old DBSCAN+_auto_eps approach. Estimate an equivalent density
        # signal directly from what HDBSCAN actually found: the average
        # haversine spacing between points inside each cluster it returned,
        # converted to a travel-time budget with the same formula as before.
        cluster_avg_kms = []
        for points in clusters.values():
            if len(points) < 2:
                continue
            pair_dists = [
                self._haversine_km(points[i], points[j])
                for i in range(len(points))
                for j in range(i + 1, len(points))
            ]
            if pair_dists:
                cluster_avg_kms.append(sum(pair_dists) / len(pair_dists))

        if cluster_avg_kms:
            avg_km = sum(cluster_avg_kms) / len(cluster_avg_kms)
            self.dynamic_max_merge_minutes = max(15, min(60, int(avg_km * 2.0) + 15))
        else:
            self.dynamic_max_merge_minutes = self.MAX_MERGE_MINUTES

        return clusters, noise

    def _initial_day_assignment(
        self,
        clusters: Dict[int, List[Any]],
        params: dict,
        available_days: Optional[int] = None,
    ) -> Tuple[List[dict], int, List[dict]]:
        target_per_day = params["target_per_day"]
        remaining_days = self.config.num_days if available_days is None else available_days
        day_pools = []
        deferred_far = []

        # Clusters that genuinely need multiple days get first claim on the
        # shared day budget. Processing strictly by size (old behavior) let a
        # single large cluster consume every remaining day and starve a
        # smaller-but-still-multi-day cluster into being crammed onto one day.
        def cluster_priority(item: Tuple[int, List[Any]]) -> Tuple[int, int]:
            _, points = item
            needed = max(1, round(len(points) / target_per_day)) if target_per_day else 1
            return (-needed, -len(points))

        sorted_clusters = sorted(clusters.items(), key=cluster_priority)

        for label, points in sorted_clusters:
            if len(points) < self.MIN_VIABLE_COUNT:
                continue

            centroid = self._pool_center({"attractions": points})
            travel_from_hotel = self._travel_to_centroid_from_place(self.config.hotel, centroid) if self.config.hotel and centroid else 0
            n_sub = max(1, round(len(points) / target_per_day))
            n_sub = min(n_sub, remaining_days)

            if n_sub == 0:
                continue

            if n_sub == 1 and travel_from_hotel > self.REMOTE_THRESHOLD_MINUTES:
                deferred_far.append({"label": label, "points": points, "centroid": centroid})
                continue

            if n_sub > 1:
                subs = self._constrained_kmeans_split(points, n_sub)
            else:
                subs = [points]

            for sub in subs:
                day_pools.append({
                    "attractions": sorted(sub, key=self._rank_key),
                    "restaurants": [],
                    "cafes": [],
                })
            remaining_days -= len(subs)

        return day_pools, remaining_days, deferred_far

    def _pool_center(self, pool: dict) -> Optional[Tuple[float, float]]:
        return utils.compute_centroid(pool.get("attractions", []))

    def _travel_to_centroid_from_place(self, place: Any, centroid: Tuple[float, float]) -> int:
        class Dummy:
            def __init__(self, lat, lon):
                self.latitude = lat
                self.longitude = lon
        return self._haversine_minutes(place, Dummy(*centroid))

    def _center_travel_minutes(self, c1: Tuple[float, float], c2: Tuple[float, float]) -> int:
        class Dummy:
            def __init__(self, lat, lon):
                self.latitude = lat
                self.longitude = lon
        return self._haversine_minutes(Dummy(*c1), Dummy(*c2))

    def _constrained_kmeans_split(self, points: List[Any], n_sub: int) -> List[List[Any]]:
        """Split `points` into `n_sub` geographically-compact, size-balanced
        groups.

        Was angle-sweep-from-hotel, then plain K-Means; plain K-Means only
        optimizes for geographic compactness, so an uneven spatial density
        can still leave one group with 2-3 points while another gets 8+.
        Since the caller always knows n_sub up front (a user-chosen day
        count), assign a hard per-group capacity (floor/ceil of an even
        split) and use it to steer a capacity-constrained K-Means: same
        Lloyd's-iteration idea as plain K-Means, but each round assigns
        points to their nearest centroid greedily in "regret" order
        (biggest gap between 1st and 2nd nearest centroid goes first) while
        respecting each cluster's remaining capacity, then recomputes
        centroids from that assignment. Mirrors the regret-based capacity
        assignment in assignment.py::ConstrainedKMeansAssignment, kept
        self-contained here since this function only deals with geography
        and counts, not travel-matrix loads or restaurant seeding.
        """
        n_sub = max(1, min(n_sub, len(points)))
        if n_sub <= 1 or len(points) <= 1:
            return [list(points)]

        from sklearn.cluster import KMeans

        n = len(points)
        base = n // n_sub
        remainder = n % n_sub
        capacities = [base + (1 if i < remainder else 0) for i in range(n_sub)]

        coords = np.array([[float(p.latitude), float(p.longitude)] for p in points])
        centroids = KMeans(n_clusters=n_sub, n_init=10, random_state=42).fit(coords).cluster_centers_

        assignments = [-1] * n
        for _ in range(self.BALANCED_SPLIT_MAX_ITER):
            dists = np.linalg.norm(coords[:, None, :] - centroids[None, :, :], axis=2)
            order = sorted(
                range(n),
                key=lambda i: -(np.partition(dists[i], 1)[1] - dists[i].min()),
            )
            remaining = list(capacities)
            new_assignments = [-1] * n
            for i in order:
                for cluster in np.argsort(dists[i]):
                    if remaining[cluster] > 0:
                        new_assignments[i] = int(cluster)
                        remaining[cluster] -= 1
                        break

            if new_assignments == assignments:
                assignments = new_assignments
                break
            assignments = new_assignments

            for c in range(n_sub):
                member_idx = [i for i in range(n) if assignments[i] == c]
                if member_idx:
                    centroids[c] = coords[member_idx].mean(axis=0)

        subs: List[List[Any]] = [[] for _ in range(n_sub)]
        for p, c in zip(points, assignments):
            subs[c].append(p)
        return subs

    def _process_noise(
        self,
        noise: List[Any],
        day_pools: List[dict],
        remote_day_pools: Optional[List[dict]] = None,
    ) -> List[Any]:
        remote_day_pools = remote_day_pools or []
        dropped = []
        for point in noise:
            # A stray point that's genuinely part of an already-confirmed
            # remote cluster (e.g. a 5th Cần Giờ POI that DBSCAN treated as
            # noise instead of grouping with the other 4) belongs with that
            # cluster regardless of how far it is from the hotel — the user
            # already agreed to pay that day's access cost once, so folding
            # this point in is free. Check remote pools before the
            # hotel-distance gate below, not after.
            if remote_day_pools:
                best_remote_idx, best_remote_travel = None, float("inf")
                for idx, pool in enumerate(remote_day_pools):
                    if not pool["attractions"]:
                        continue
                    travel = min(
                        self._pairwise_travel(point, peer)
                        for peer in pool["attractions"]
                    )
                    if travel < best_remote_travel:
                        best_remote_idx, best_remote_travel = idx, travel
                if (
                    best_remote_idx is not None
                    and best_remote_travel
                    <= getattr(self, "dynamic_max_merge_minutes", self.MAX_MERGE_MINUTES)
                ):
                    remote_day_pools[best_remote_idx]["attractions"].append(point)
                    continue

            if not day_pools:
                dropped.append(point)
                continue

            # A noise point that is genuinely far from the hotel (real travel
            # time, not straight-line haversine) should never be merged just
            # because it happens to be haversine-close to some day's centroid.
            # Centroids are virtual coordinates, so distance-to-centroid can
            # only ever use haversine and silently underestimates travel time
            # across rivers/highway loops/etc. Gate on the real hotel travel
            # time first.
            if self._travel_from_hotel(point) > self.REMOTE_THRESHOLD_MINUTES:
                dropped.append(point)
                continue

            best_idx, best_travel = None, float("inf")
            for idx, pool in enumerate(day_pools):
                if pool["attractions"]:
                    travel = min(
                        self._pairwise_travel(point, peer)
                        for peer in pool["attractions"]
                    )
                else:
                    center = self._pool_center(pool)
                    if center is None:
                        continue
                    travel = self._travel_to_centroid_from_place(point, center)
                if travel < best_travel:
                    best_idx, best_travel = idx, travel
            if best_travel <= getattr(self, "dynamic_max_merge_minutes", self.MAX_MERGE_MINUTES) and best_idx is not None:
                day_pools[best_idx]["attractions"].append(point)
            else:
                dropped.append(point)
        return dropped

    def _balance_day_count(
        self,
        day_pools: List[dict],
        remaining_days: int,
        deferred_far: List[dict],
        dropped: List[Any],
        available_days: Optional[int] = None,
    ):
        target_days = self.config.num_days if available_days is None else available_days
        while len(day_pools) < target_days and deferred_far:
            best = deferred_far.pop(0)
            day_pools.append({
                "attractions": sorted(best["points"], key=self._rank_key),
                "restaurants": [],
                "cafes": [],
            })

        while len(day_pools) < target_days:
            largest_idx = max(range(len(day_pools)), key=lambda i: len(day_pools[i]["attractions"]), default=-1)
            if largest_idx == -1:
                break
            pool = day_pools[largest_idx]
            if len(pool["attractions"]) < 2:
                day_pools.append({"attractions": [], "restaurants": [], "cafes": []})
                continue
            subs = self._constrained_kmeans_split(pool["attractions"], 2)
            day_pools[largest_idx] = {
                "attractions": sorted(subs[0], key=self._rank_key),
                "restaurants": [],
                "cafes": [],
            }
            if len(subs) > 1:
                day_pools.append({
                    "attractions": sorted(subs[1], key=self._rank_key),
                    "restaurants": [],
                    "cafes": [],
                })
            else:
                day_pools.append({"attractions": [], "restaurants": [], "cafes": []})

        while len(day_pools) > target_days:
            best_pair, best_dist = None, float("inf")
            for i in range(len(day_pools)):
                for j in range(i + 1, len(day_pools)):
                    ci = self._pool_center(day_pools[i])
                    cj = self._pool_center(day_pools[j])
                    if ci and cj:
                        d = self._center_travel_minutes(ci, cj)
                        if d < best_dist:
                            best_pair, best_dist = (i, j), d
            if best_pair is None:
                day_pools.pop()
                continue
            i, j = best_pair
            day_pools[i]["attractions"].extend(day_pools[j]["attractions"])
            day_pools.pop(j)

    def _compute_cluster_stats(self, day_pools: List[dict]):
        for pool in day_pools:
            pool["day_cluster_center"] = self._pool_center(pool)
            pool["capacity_used"] = sum(self._poi_cost(p) for p in pool["attractions"])

    def _pairwise_travel(self, a: Any, b: Any) -> int:
        t = self.travel_matrix.get((a.id, b.id))
        if t is not None:
            return int(t)
        t = self.travel_matrix.get((b.id, a.id))
        if t is not None:
            return int(t)
        return self._haversine_minutes(a, b)

    def _inject_restaurants(self, day_pools: List[dict], restaurants: List[Any]):
        """Assign each restaurant candidate to its nearest day-pool, greedily
        by real distance — NOT independently per pool. Each pool used to
        rank all restaurants against only its own centroid and claim its own
        top-N, so the same nearby restaurant could end up a candidate for
        several different days at once. That's harmless when a day has
        several backup candidates, but starves a day whose sole nearby
        option was already "claimed" by another day with more candidates to
        spare — exactly the "day has no valid restaurant" failure mode.
        Here, a restaurant is only ever a candidate for the ONE day it's
        genuinely closest to among those that still have room.
        """
        if not restaurants:
            return

        centers = [self._pool_center(pool) for pool in day_pools]
        pairs = []
        for pool_idx, center in enumerate(centers):
            if center is None:
                continue
            for r in restaurants:
                dist = self._travel_to_centroid_from_place(r, center)
                pairs.append((dist, pool_idx, r))
        pairs.sort(key=lambda item: item[0])

        limit = self.config.restaurant_option_limit
        pool_counts = [0] * len(day_pools)
        assigned_ids: set = set()
        for _, pool_idx, r in pairs:
            r_id = str(r.id)
            if r_id in assigned_ids or pool_counts[pool_idx] >= limit:
                continue
            day_pools[pool_idx]["restaurants"].append(r)
            assigned_ids.add(r_id)
            pool_counts[pool_idx] += 1

    def _inject_cafes(self, day_pools: List[dict], cafes: List[Any]):
        """Same greedy nearest-day-pool assignment as _inject_restaurants,
        kept as its own pass with its own per-pool cap (config.cafe_option_limit)
        rather than folded into the restaurant count. Cafes are excluded from
        the K-Means day-split input entirely (see assign()) precisely so a
        geographically dense cafe cluster near one day's centroid can't
        dominate that day — without a separate greedy pass + its own cap,
        every nearby cafe would otherwise compete as an "attraction" candidate
        for the same day (the "6 cups of milk tea in one day" bug).
        """
        if not cafes:
            return

        centers = [self._pool_center(pool) for pool in day_pools]
        pairs = []
        for pool_idx, center in enumerate(centers):
            if center is None:
                continue
            for c in cafes:
                dist = self._travel_to_centroid_from_place(c, center)
                pairs.append((dist, pool_idx, c))
        pairs.sort(key=lambda item: item[0])

        limit = self.config.cafe_option_limit
        pool_counts = [0] * len(day_pools)
        assigned_ids: set = set()
        for _, pool_idx, c in pairs:
            c_id = str(c.id)
            if c_id in assigned_ids or pool_counts[pool_idx] >= limit:
                continue
            day_pools[pool_idx]["cafes"].append(c)
            assigned_ids.add(c_id)
            pool_counts[pool_idx] += 1

    def _build_result(self, day_pools: List[dict], dropped: List[Any], params: dict) -> AssignmentResult:
        for pool in day_pools:
            pool.setdefault("cafes", [])
            pool["allocation_method"] = "geo_clustering"
            pool["primary_load_minutes"] = sum(self._poi_cost(p) for p in pool["attractions"])
            pool["final_candidate_count"] = (
                len(pool["attractions"]) + len(pool["restaurants"]) + len(pool["cafes"])
            )

        day_loads = [
            sum(self._poi_cost(p) for p in pool["attractions"] + pool["restaurants"] + pool["cafes"])
            for pool in day_pools
        ]

        warnings = [
            f"geo_clustering num_days={self.config.num_days} "
            f"target_per_day={params.get('target_per_day', 0)} "
            f"dropped={len(dropped)}"
        ]
        for idx, pool in enumerate(day_pools):
            if not pool["attractions"]:
                warnings.append(f"Day {idx+1}: empty attraction pool")
            if not pool["restaurants"]:
                warnings.append(f"Day {idx+1}: no restaurant option")

        return AssignmentResult(
            day_pools=day_pools,
            day_loads=day_loads,
            warnings=warnings,
            dropped_points=dropped,
        )
