from fastapi import APIRouter, HTTPException, status

from app.schemas.retrain import StartRetrainRequest, StartRetrainResponse
from app.services.retrain_job_service import start_retrain

router = APIRouter(prefix="/retrain", tags=["Recommender Retrain"])


@router.post(
    "/runs",
    response_model=StartRetrainResponse,
    status_code=status.HTTP_202_ACCEPTED,
)
def start_run(request: StartRetrainRequest):
    run_id = str(request.run_id)
    accepted = start_retrain(run_id, request.force)
    if not accepted:
        raise HTTPException(status_code=409, detail="A retrain job is already running")
    return StartRetrainResponse(
        run_id=run_id,
        status="pending",
        message="Retrain job accepted",
    )
