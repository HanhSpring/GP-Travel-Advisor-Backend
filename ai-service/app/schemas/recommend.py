from pydantic import BaseModel, ConfigDict, Field


# ---------------------------------------------------------------------------
# Generic recommend (existing)
# ---------------------------------------------------------------------------

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
    model_config = ConfigDict(protected_namespaces=())

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


# ---------------------------------------------------------------------------
# Two-Tower query encoding
# ---------------------------------------------------------------------------

class EncodeQueryRequest(BaseModel):
    user_id:      str = Field(..., description="Supabase UUID hoặc 'anonymous'")
    city:         str = Field(..., description="Tên thành phố điểm đến")
    trip_intent:  str = Field(..., description="Loại chuyến đi, phải khớp model vocab")
    intent_vibe:  str = Field("",  description="Vibe tuỳ chọn, để trống nếu không có")
    history_types: list[str] = Field(default_factory=list, description="Loại địa điểm đã đến (tối đa 30)")
    history_vibes: list[str] = Field(default_factory=list, description="Vibes đã trải nghiệm (tối đa 30)")
    history_biz:   list[str] = Field(default_factory=list, description="Place IDs đã đến (tối đa 30)")

    model_config = {"json_schema_extra": {
        "example": {
            "user_id":       "550e8400-e29b-41d4-a716-446655440000",
            "city":          "Hà Nội",
            "trip_intent":   "Khám phá tổng hợp",
            "intent_vibe":   "",
            "history_types": ["Bảo tàng", "Café"],
            "history_vibes": ["chill", "vintage"],
            "history_biz":   [],
        }
    }}


class EncodeQueryResponse(BaseModel):
    embedding: list[float] = Field(..., description="256-dim L2-normalized query vector")
    dim: int = 256
