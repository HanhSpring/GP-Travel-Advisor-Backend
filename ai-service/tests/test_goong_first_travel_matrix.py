import json

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
