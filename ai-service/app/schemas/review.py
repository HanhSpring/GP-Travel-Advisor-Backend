from pydantic import BaseModel


class ReviewClassifyRequest(BaseModel):
    reviews: list[str]


class ReviewClassifyResponse(BaseModel):
    results: list[dict]
    # mỗi dict: { "text": str, "label": "short_term" | "long_term", "confidence": float }
