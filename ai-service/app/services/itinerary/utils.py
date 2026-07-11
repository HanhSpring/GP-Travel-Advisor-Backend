"""Shared pure-geometry helpers for the itinerary planners.

Deliberately narrow scope: only math with zero algorithmic/policy nuance
(haversine distance, centroid) lives here. Deduplication, restaurant/cafe
injection, and ranking logic stay in their own files — they embed
per-engine policy (e.g. geo_clustering.py's global-greedy injection vs.
assignment.py's per-pool injection for the legacy ga_v1 engine) that must
not silently change during a "pure" DRY pass.
"""
from __future__ import annotations

import math
from typing import Any, List, Optional, Tuple


def haversine_km_coords(lat1: float, lng1: float, lat2: float, lng2: float) -> float:
    """Great-circle distance in km between two lat/lng coordinates."""
    try:
        lat1_rad, lng1_rad = math.radians(float(lat1)), math.radians(float(lng1))
        lat2_rad, lng2_rad = math.radians(float(lat2)), math.radians(float(lng2))
        dlat = lat2_rad - lat1_rad
        dlng = lng2_rad - lng1_rad
        a = (
            math.sin(dlat / 2) ** 2
            + math.cos(lat1_rad) * math.cos(lat2_rad) * math.sin(dlng / 2) ** 2
        )
        return 6371.0 * 2 * math.atan2(math.sqrt(a), math.sqrt(1 - a))
    except (ValueError, TypeError):
        return 0.0


def haversine_km_places(place1: Any, place2: Any) -> float:
    """Same as haversine_km_coords, for two place-like objects with
    .latitude/.longitude attributes."""
    try:
        return haversine_km_coords(
            float(place1.latitude), float(place1.longitude),
            float(place2.latitude), float(place2.longitude),
        )
    except (ValueError, TypeError, AttributeError):
        return 0.0


def haversine_minutes_coords(
    lat1: float, lng1: float, lat2: float, lng2: float, speed_kmh: float = 30.0
) -> int:
    """Straight-line travel-time estimate (minutes) at a flat assumed speed."""
    km = haversine_km_coords(lat1, lng1, lat2, lng2)
    return max(5, int(km / speed_kmh * 60.0))


def compute_centroid(places: List[Any]) -> Optional[Tuple[float, float]]:
    """Mean lat/lng of a list of place-like objects, or None if empty."""
    if not places:
        return None
    return (
        sum(float(p.latitude) for p in places) / len(places),
        sum(float(p.longitude) for p in places) / len(places),
    )
