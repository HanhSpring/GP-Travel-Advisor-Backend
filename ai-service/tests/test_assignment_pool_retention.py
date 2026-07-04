from dataclasses import dataclass

from app.services.itinerary.assignment import AssignmentConfig, ConstrainedKMeansAssignment


@dataclass
class Candidate:
    id: str
    latitude: float
    longitude: float
    place_type: str = "attraction"
    candidate_rank: int = 0
    visit_duration: int = 60


@dataclass
class Hotel:
    id: str = "hotel"
    latitude: float = 10.0
    longitude: float = 106.0


def test_constrained_kmeans_retains_all_primary_candidates():
    candidates = [
        Candidate(
            id=f"poi-{index}",
            latitude=10.0 + (index % 3) * 0.2 + index * 0.0001,
            longitude=106.0 + (index % 3) * 0.2,
            candidate_rank=index,
        )
        for index in range(36)
    ]
    restaurants = [
        Candidate(
            id=f"restaurant-{index}",
            latitude=10.0 + (index % 3) * 0.2,
            longitude=106.0 + (index % 3) * 0.2,
            place_type="restaurant",
            candidate_rank=100 + index,
            visit_duration=75,
        )
        for index in range(12)
    ]
    assignment = ConstrainedKMeansAssignment(
        AssignmentConfig(
            num_days=3,
            daily_start_time=8 * 60,
            daily_end_time=21 * 60,
            trip_intent="general",
            hotel=Hotel(),
        ),
        travel_matrix={},
    ).assign(candidates + restaurants)

    retained_ids = {
        place.id
        for pool in assignment.day_pools
        for place in pool["attractions"]
    }

    assert retained_ids == {place.id for place in candidates}
    assert sum(len(pool["attractions"]) for pool in assignment.day_pools) == 36
    assert all(len(pool["restaurants"]) <= 2 for pool in assignment.day_pools)
    assert "pool_cap=unbounded" in assignment.warnings[0]


def test_boundary_rebalance_moves_only_close_pois_and_reduces_load_gap():
    assignment = ConstrainedKMeansAssignment(
        AssignmentConfig(
            num_days=2,
            daily_start_time=8 * 60,
            daily_end_time=21 * 60,
            trip_intent="general",
            hotel=Hotel(),
        ),
        travel_matrix={},
    )
    heavy = [
        Candidate(
            id=f"heavy-{index}",
            latitude=10.0 + index * 0.0002,
            longitude=106.0,
            candidate_rank=index,
        )
        for index in range(16)
    ]
    light = [
        Candidate(
            id=f"light-{index}",
            latitude=10.025 + index * 0.0002,
            longitude=106.0,
            candidate_rank=100 + index,
        )
        for index in range(6)
    ]
    pools = [
        {"attractions": heavy.copy(), "restaurants": []},
        {"attractions": light.copy(), "restaurants": []},
    ]
    before = [
        assignment._primary_day_load(pool)  # noqa: SLF001
        for pool in pools
    ]

    moves = assignment._rebalance_day_pools(pools, lower=1, upper=22)  # noqa: SLF001
    after = [
        assignment._primary_day_load(pool)  # noqa: SLF001
        for pool in pools
    ]

    assert moves > 0
    assert abs(after[0] - after[1]) < abs(before[0] - before[1])
    assert sum(len(pool["attractions"]) for pool in pools) == 22
