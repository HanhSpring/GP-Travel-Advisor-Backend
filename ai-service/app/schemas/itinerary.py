from pydantic import BaseModel, Field


class ItineraryPlaceInput(BaseModel):
    id: str
    name: str
    longitude: float
    latitude: float
    place_type: str | None = Field(
        default=None,
        description="hotel | restaurant | attraction. If omitted, slot_type/category/source is used.",
    )
    slot_type: str | None = None
    category: str | None = None
    source: str = ""
    type_id: str = ""
    type_name: str = ""
    open_hour: str | None = None
    open_hour_compressed: str | None = None
    visit_duration: int | None = None
    average_rating: float | None = None


class ItineraryPlanRequest(BaseModel):
    places: list[ItineraryPlaceInput]
    num_days: int = Field(..., ge=1)
    daily_start_time: str = Field(default="08:00", pattern=r"^([0-1]?[0-9]|2[0-3]):[0-5][0-9]$")
    daily_end_time: str = Field(default="21:00", pattern=r"^([0-1]?[0-9]|2[0-3]):[0-5][0-9]$")
    selected_hotel_id: str | None = None
    return_to_hotel: bool = False
    use_goong: bool = False
    goong_api_key: str = ""
    travel_cache_path: str | None = None
    speed_kmh: float = 30.0
    population_size: int = Field(default=50, ge=2)
    generations: int = Field(default=200, ge=1)
    mutation_rate: float = Field(default=0.30, ge=0, le=1)
    seed: int | None = 42


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
    active_duration_minutes: int
    is_restaurant: bool
    unknown_hours: bool
    is_return_to_hotel: bool


class ItineraryDayResponse(BaseModel):
    day: int
    visited_count: int
    total_travel_minutes: int
    total_distance_km: float
    total_visit_minutes: int
    total_wait_minutes: int
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
    days: list[ItineraryDayResponse]
