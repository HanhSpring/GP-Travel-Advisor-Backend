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


class ItineraryPlanRequest(BaseModel):
    places: list[ItineraryPlaceInput]
    num_days: int = Field(..., ge=1)
    daily_start_time: str = Field(default="08:00", pattern=r"^([0-1]?[0-9]|2[0-3]):[0-5][0-9]$")
    daily_end_time: str = Field(default="21:00", pattern=r"^([0-1]?[0-9]|2[0-3]):[0-5][0-9]$")
    selected_hotel_id: str | None = None
    return_to_hotel: bool = False
    use_goong: bool = False
    goong_api_key: str = ""
    travel_vehicle: str = Field(default="car", pattern=r"^(car|bike|taxi|truck)$")
    travel_cache_path: str | None = None
    speed_kmh: float = 30.0
    population_size: int = Field(default=50, ge=2)
    generations: int = Field(default=200, ge=1)
    mutation_rate: float = Field(default=0.30, ge=0, le=1)
    seed: int | None = 42

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
    active_duration_minutes: int
    place_type: str = "attraction"
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
    total_ms: int = 0
    matrix_ms: int = 0
    ga_ms: int = 0
    days: list[ItineraryDayResponse]
