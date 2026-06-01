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
