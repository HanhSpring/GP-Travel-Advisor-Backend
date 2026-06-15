from pydantic import BaseModel


class RecommendRequest(BaseModel):
    user_id: str
    top_k: int = 10
    strategy: str = "two_tower"  # "two_tower" | "content_based" | "cf"


class RecommendResponse(BaseModel):
    user_id: str
    item_ids: list[str]
    scores: list[float]
    strategy: str


class PlaceRecommendationItem(BaseModel):
    id: str
    name: str | None = None
    city_name: str | None = None
    category_name: str | None = None
    type_name: str | None = None
    latitude: float | None = None
    longitude: float | None = None
    distance_km: float | None = None
    model_score: float
    distance_score: float
    final_score: float
    rank: int
    source: str  # "BOTH" | "CB" | "CF"


class PlaceRecommendationsResponse(BaseModel):
    place_id: str
    count: int
    items: list[PlaceRecommendationItem]
