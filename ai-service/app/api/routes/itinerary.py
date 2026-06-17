import logging

from fastapi import APIRouter, HTTPException

from app.schemas.itinerary import ItineraryPlanRequest, ItineraryPlanResponse
from app.services.itinerary_service import plan_itinerary

router = APIRouter()
logger = logging.getLogger(__name__)


@router.post("/plan", response_model=ItineraryPlanResponse)
def create_itinerary_plan(req: ItineraryPlanRequest):
    try:
        return plan_itinerary(req)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except RuntimeError as e:
        raise HTTPException(status_code=503, detail=str(e))
    except Exception as e:
        logger.exception("Unexpected itinerary planner error")
        raise HTTPException(status_code=500, detail=f"Unexpected itinerary planner error: {e}")
