from __future__ import annotations

from typing import Any, Dict, List

from scipy.optimize import linear_sum_assignment

from app.services.itinerary import planner

# A POI whose window this weekday is at least this many minutes wider than
# its average window on other weekdays gets a bonus — it signals a
# genuinely special day (e.g. weekend-only opening hours) worth matching.
SPECIAL_DAY_BONUS_THRESHOLD_MINUTES = 30
SPECIAL_DAY_BONUS = 10.0
CLOSED_DAY_PENALTY = 100.0


def score_pool_for_weekday(pool_places: List[Any], weekday_idx: int) -> float:
    """Higher is better. Heavily penalizes assigning a pool to a weekday
    where one of its POIs is explicitly closed, and rewards weekdays that
    line up with a POI's unusually generous hours (e.g. weekend-only spots)
    relative to its other six days."""
    score = 0.0
    for place in pool_places:
        raw = getattr(place, "open_hour_compressed", "") or getattr(place, "open_hour", "")
        if not raw:
            continue

        window = planner.get_time_for_day_json(raw, weekday_idx)
        if window is None:
            if planner.is_day_explicitly_closed(raw, weekday_idx):
                score -= CLOSED_DAY_PENALTY
            continue

        width = max(0, window[1] - window[0])
        other_widths = []
        for other_idx in range(7):
            if other_idx == weekday_idx:
                continue
            other_window = planner.get_time_for_day_json(raw, other_idx)
            if other_window is not None:
                other_widths.append(max(0, other_window[1] - other_window[0]))

        if other_widths:
            avg_other = sum(other_widths) / len(other_widths)
            if width > avg_other + SPECIAL_DAY_BONUS_THRESHOLD_MINUTES:
                score += SPECIAL_DAY_BONUS
    return score


def match_pools_to_weekdays(
    day_pools: List[Dict[str, Any]], start_weekday_idx: int
) -> List[int]:
    """Returns a permutation `perm` such that `perm[slot] = pool_index` —
    i.e. calendar slot `slot` (Day `slot + 1`) should be filled by
    `day_pools[perm[slot]]`. Uses the Hungarian algorithm (scipy) to pick
    the pool-to-weekday pairing that maximizes total opening-hours fit,
    instead of leaving pools in whatever order clustering produced them.
    """
    n = len(day_pools)
    if n <= 1:
        return list(range(n))

    cost = [[0.0] * n for _ in range(n)]
    for pool_idx, pool in enumerate(day_pools):
        pool_places = [
            *pool.get("attractions", []),
            *pool.get("restaurants", []),
            *pool.get("cafes", []),
        ]
        for slot_idx in range(n):
            weekday_idx = (start_weekday_idx + slot_idx) % 7
            cost[pool_idx][slot_idx] = -score_pool_for_weekday(pool_places, weekday_idx)

    pool_indices, slot_indices = linear_sum_assignment(cost)
    perm = [0] * n
    for pool_idx, slot_idx in zip(pool_indices, slot_indices):
        perm[slot_idx] = pool_idx
    return perm
