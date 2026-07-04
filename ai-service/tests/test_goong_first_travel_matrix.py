import json
from types import SimpleNamespace

from app.services.itinerary import planner


def test_goong_results_are_cached_and_failed_pairs_fall_back(
    monkeypatch,
    tmp_path,
):
    coords = {
        "a": (106.7000, 10.7700),
        "b": (106.7100, 10.7800),
    }
    cache_path = tmp_path / "travel_matrix_cache.json"

    def fake_goong(*args, **kwargs):
        return {("a", "b"): 8}, {("a", "b"): 3.2}

    monkeypatch.setattr(planner, "build_travel_data_goong", fake_goong)

    times, distances, sources, _ = planner.build_travel_matrix(
        coords,
        api_key="test-key",
        vehicle="car",
        cache_path=str(cache_path),
    )

    assert times[("a", "b")] == 8
    assert distances[("a", "b")] == 3.2
    assert sources[("a", "b")] == "goong"
    assert sources[("b", "a")] == "haversine"

    cache = json.loads(cache_path.read_text(encoding="utf-8"))
    assert cache["car:a:b"]["distance_source"] == "goong"
    assert "car:b:a" not in cache


def test_day_pool_refresh_falls_back_when_goong_is_rate_limited(
    monkeypatch,
    tmp_path,
):
    coords = {
        "hotel": (106.7000, 10.7700),
        "poi": (106.7100, 10.7800),
    }
    travel_times = planner.build_travel_times_haversine(coords)
    travel_distances = planner.build_distances_haversine(coords)
    travel_sources = {pair: "haversine" for pair in travel_times}

    monkeypatch.setattr(planner, "_load_distance_matrix_db", lambda *_: {})
    monkeypatch.setattr(
        planner,
        "build_travel_data_goong",
        lambda *_args, **_kwargs: (_ for _ in ()).throw(
            RuntimeError("Goong HTTP 429: OVER_RATE_LIMIT")
        ),
    )

    refreshed = planner.refresh_travel_matrix_for_day_pools(
        coords=coords,
        day_pools=[
            {
                "attractions": [SimpleNamespace(id="poi")],
                "restaurants": [],
            }
        ],
        hotel_id="hotel",
        travel_times=travel_times,
        travel_distances=travel_distances,
        travel_sources=travel_sources,
        travel_reliability={},
        api_key="test-key",
        cache_path=str(tmp_path / "cache.json"),
        require_goong=False,
    )

    assert refreshed == 0
    assert travel_sources[("hotel", "poi")] == "haversine"
