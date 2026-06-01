from fastapi import APIRouter, HTTPException
from app.schemas.review import ReviewClassifyRequest, ReviewClassifyResponse
from app.services.review_service import classify_reviews

router = APIRouter()


@router.post("/classify", response_model=ReviewClassifyResponse)
def classify(req: ReviewClassifyRequest):
    try:
        results = classify_reviews(req.reviews)
        return ReviewClassifyResponse(results=results)
    except RuntimeError as e:
        raise HTTPException(status_code=503, detail=str(e))
