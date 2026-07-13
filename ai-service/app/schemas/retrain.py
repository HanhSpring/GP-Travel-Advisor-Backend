from typing import Literal

from pydantic import BaseModel
from uuid import UUID


class StartRetrainRequest(BaseModel):
    run_id: UUID
    force: bool = True
    trigger_type: Literal["manual", "scheduled"] = "manual"


class StartRetrainResponse(BaseModel):
    run_id: str
    status: str
    message: str
