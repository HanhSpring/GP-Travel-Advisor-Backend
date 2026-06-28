from pydantic import BaseModel, Field


class WeightsResponse(BaseModel):
    algorithm: str
    is_active: bool
    distance_weight: float
    model_weight: float  # luôn = 1 - distance_weight
    default_distance_weight: float | None = None
    candidate_count: int
    default_candidate_count: int | None = None


class UpdateDistanceWeightRequest(BaseModel):
    distance_weight: float | None = Field(
        default=None,
        ge=0.0,
        le=1.0,
        description="Hệ số khoảng cách trong [0, 1]. Hệ số model = 1 - distance_weight.",
    )
    candidate_count: int | None = Field(
        default=None,
        ge=1,
        le=50,
        description="So ket qua goi y mac dinh truyen vao tham so k cua Hybrid Recommender.",
    )
    actor: str | None = Field(
        default=None, description="Ai thực hiện (email/username) — để ghi vào algorithm_logs."
    )
