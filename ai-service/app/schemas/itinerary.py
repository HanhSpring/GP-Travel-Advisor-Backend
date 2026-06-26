from typing import Any

from pydantic import BaseModel, Field


class ItineraryPlaceInput(BaseModel):
    id: str
    name: str
    longitude: float
    latitude: float
    place_type: str | None = Field(
        default=None,
        description="hotel | restaurant | cafe | entertainment | attraction. If omitted, slot_type/category/source is used.",
    )
    slot_type: str | None = None
    category: str | None = None
    source: str = ""
    type_id: str = ""
    type_name: str = ""
    category_id: str | None = None
    category_name: str | None = None
    open_hour: str | None = None
    open_hour_compressed: str | None = None
    visit_duration: int | None = None
    average_rating: float | None = None
    retrieval_score: float | None = None
    candidate_rank: int | None = None
    candidate_total: int | None = None
    estimated_cost: float | None = None
    price_min: float | None = None
    price_max: float | None = None
    price_basis: str | None = None
    price_inferred: bool | None = None
    planner_source: str | None = None


class ItineraryPlanRequest(BaseModel):
    places: list[ItineraryPlaceInput]
    num_days: int = Field(..., ge=1)
    daily_start_time: str = Field(default="08:00", pattern=r"^([0-1]?[0-9]|2[0-3]):[0-5][0-9]$")
    daily_end_time: str = Field(default="21:00", pattern=r"^([0-1]?[0-9]|2[0-3]):[0-5][0-9]$")
    trip_start_date: str | None = Field(default=None, pattern=r"^\d{4}-\d{2}-\d{2}$")
    adult_count: int = Field(default=1, ge=1)
    child_count: int = Field(default=0, ge=0)
    budget_per_person: float = Field(default=0, ge=0)
    selected_hotel_id: str | None = None
    return_to_hotel: bool = False
    use_goong: bool = False
    require_goong: bool = False
    goong_api_key: str = ""
    travel_vehicle: str = Field(default="car", pattern=r"^(car|bike)$")
    travel_cache_path: str | None = None
    speed_kmh: float = 30.0
    population_size: int = Field(default=50, ge=2)
    generations: int = Field(default=200, ge=1)
    mutation_rate: float = Field(default=0.30, ge=0, le=1)
    seed: int | None = 42
    planner_engine: str = Field(
        default="ga_v1",
        description="ga_v1 | scheduler_v2 | compare. compare is intended for preview/debug only.",
    )

    model_config = {
        "json_schema_extra": {
            "example": {
                "places": [
                    {
                        "id": "hotel-1",
                        "name": "Demo Hotel",
                        "longitude": 108.2208,
                        "latitude": 16.0678,
                        "place_type": "hotel",
                        "slot_type": "accommodation",
                        "category": "accommodation",
                        "source": "swagger",
                        "type_id": "hotel",
                        "type_name": "Hotel",
                        "open_hour_compressed": None,
                        "visit_duration": 60,
                        "average_rating": 4.5,
                    },
                    {
                        "id": "attraction-1",
                        "name": "Cau Rong",
                        "longitude": 108.2274,
                        "latitude": 16.0611,
                        "place_type": "attraction",
                        "slot_type": "attraction",
                        "category": "attraction",
                        "source": "swagger",
                        "type_id": "attraction",
                        "type_name": "Attraction",
                        "open_hour_compressed": "08:00-22:00",
                        "visit_duration": 90,
                        "average_rating": 4.7,
                    },
                    {
                        "id": "restaurant-1",
                        "name": "Demo Restaurant",
                        "longitude": 108.2244,
                        "latitude": 16.0682,
                        "place_type": "restaurant",
                        "slot_type": "restaurant",
                        "category": "restaurant",
                        "source": "swagger",
                        "type_id": "restaurant",
                        "type_name": "Restaurant",
                        "open_hour_compressed": "10:00-21:00",
                        "visit_duration": 60,
                        "average_rating": 4.3,
                    },
                ],
                "num_days": 1,
                "daily_start_time": "08:00",
                "daily_end_time": "21:00",
                "selected_hotel_id": "hotel-1",
                "return_to_hotel": False,
                "use_goong": False,
                "goong_api_key": "",
                "speed_kmh": 30,
                "population_size": 20,
                "generations": 40,
                "mutation_rate": 0.3,
                "seed": 42,
            }
        }
    }


class ScheduleEntryResponse(BaseModel):
    location_id: str
    location_name: str
    travel_from_id: str
    travel_from_name: str
    travel_minutes: int
    raw_travel_minutes: int
    travel_buffer_minutes: int
    travel_buffer_source: str
    distance_km: float
    travel_source: str
    arrival_time: str
    service_start_time: str
    departure_time: str
    wait_minutes: int
    base_duration_minutes: int = 0
    active_duration_minutes: int
    estimated_cost: float = 0
    price_basis: str | None = None
    price_inferred: bool | None = None
    place_type: str = "attraction"
    is_restaurant: bool
    unknown_hours: bool
    is_return_to_hotel: bool


class ItineraryDayResponse(BaseModel):
    day: int
    visited_count: int
    target_visited_count: int = 4
    total_travel_minutes: int
    total_distance_km: float
    total_visit_minutes: int
    total_wait_minutes: int
    total_activity_cost: float = 0
    total_transport_cost: float = 0
    total_day_cost: float = 0
    budget_limit: float = 0
    budget_overage: float = 0
    budget_penalty: float = 0
    skipped_count: int = 0
    total_hard_violations: int = 0
    meal_violations: int = 0
    restaurant_count: int
    fitness: float
    stopped_reason: str
    schedule: list[ScheduleEntryResponse]


class ItineraryPlanResponse(BaseModel):
    hotel_id: str
    hotel_name: str
    num_days: int
    input_places: int
    total_visited: int
    total_ms: int = 0
    matrix_ms: int = 0
    ga_ms: int = 0
    planner_engine: str = "ga_v1"
    solver_ms: int = 0
    assignment_day_loads: list[int] = Field(default_factory=list)
    assignment_warnings: list[str] = Field(default_factory=list)
    validation_is_feasible: bool = True
    validation_violations: list[dict] = Field(default_factory=list)
    validation_warnings: list[str] = Field(default_factory=list)
    comparison: dict[str, Any] | None = None
    days: list[ItineraryDayResponse]
