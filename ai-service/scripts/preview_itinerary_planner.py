from __future__ import annotations

import argparse
import os
import sys
from pathlib import Path

SERVICE_ROOT = Path(__file__).resolve().parents[1]
if str(SERVICE_ROOT) not in sys.path:
    sys.path.insert(0, str(SERVICE_ROOT))
if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")

from app.schemas.itinerary import ItineraryPlanRequest, ItineraryPlaceInput
from app.services.itinerary import planner
from app.services.itinerary_service import plan_itinerary


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Preview retrieval candidates from local CSV, then run GA itinerary planner."
    )
    parser.add_argument("--city-id", default=planner.DEMO_CITY_ID)
    parser.add_argument("--limit", type=int, default=30)
    parser.add_argument("--days", type=int, default=2)
    parser.add_argument("--start", default="08:00")
    parser.add_argument("--end", default="21:00")
    parser.add_argument("--seed", type=int, default=42)
    parser.add_argument("--csv-path", default=planner.DEMO_CSV_PATH)
    parser.add_argument("--types-path", default=planner.DEMO_TYPES_CSV_PATH)
    parser.add_argument("--travel-cache", default=planner.TRAVEL_CACHE_PATH)
    parser.add_argument("--no-type-filter", action="store_true")
    parser.add_argument("--pop", type=int, default=50)
    parser.add_argument("--gen", type=int, default=120)
    args = parser.parse_args()

    planner.TYPE_BY_ID = planner.load_types_from_csv(args.types_path)
    rows = planner.fetch_places_from_csv(
        args.csv_path,
        city_id=args.city_id,
        limit=args.limit,
        seed=args.seed,
        type_filter=not args.no_type_filter,
    )

    if not rows:
        print("No candidate places found. Check --city-id or CSV paths.")
        return 1

    print("\nCandidate places sampled from local data")
    print("=" * 72)
    for idx, row in enumerate(rows, start=1):
        type_info = planner.TYPE_BY_ID.get(row.get("type_id") or "") or {}
        slot = "restaurant" if planner.is_lunch_restaurant_row(row) else "attraction"
        print(f"{idx:>2}. [{slot:<10}] {row.get('name')} | {type_info.get('name', '-')}")

    places = [_row_to_input(row) for row in rows]
    response = plan_itinerary(
        ItineraryPlanRequest(
            places=places,
            num_days=args.days,
            daily_start_time=args.start,
            daily_end_time=args.end,
            travel_cache_path=args.travel_cache,
            use_goong=False,
            population_size=args.pop,
            generations=args.gen,
            seed=args.seed,
        )
    )

    print("\nGA itinerary result")
    print("=" * 72)
    print(f"Hotel/base: {response.hotel_name}")
    print(f"Visited: {response.total_visited}/{response.input_places} places")
    for day in response.days:
        print(f"\nDay {day.day}: {day.visited_count} places, "
              f"{day.total_distance_km:.1f} km, travel {day.total_travel_minutes} min")
        for entry in day.schedule:
            if entry.is_return_to_hotel:
                print(f"   -> Return to hotel at {entry.arrival_time}")
                continue
            label = "Lunch" if entry.is_restaurant else "Visit"
            print(
                f"  {entry.service_start_time}-{entry.departure_time} "
                f"{label:<5} {entry.location_name} "
                f"({entry.travel_minutes} min from {entry.travel_from_name})"
            )

    return 0


def _row_to_input(row: dict) -> ItineraryPlaceInput:
    type_info = planner.TYPE_BY_ID.get(row.get("type_id") or "") or {}
    slot = "restaurant" if planner.is_lunch_restaurant_row(row) else "attraction"
    return ItineraryPlaceInput(
        id=str(row["id"]),
        name=str(row["name"]),
        longitude=float(row["longitude"]),
        latitude=float(row["latitude"]),
        place_type=slot,
        slot_type=slot,
        source=row.get("source") or "",
        type_id=row.get("type_id") or "",
        type_name=type_info.get("name") or "",
        open_hour=row.get("open_hour") or None,
        open_hour_compressed=row.get("open_hour_compressed") or None,
        visit_duration=int(row["visit_duration"]) if row.get("visit_duration") else None,
        average_rating=float(row["average_rating"]) if row.get("average_rating") else None,
    )


if __name__ == "__main__":
    raise SystemExit(main())
