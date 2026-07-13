from __future__ import annotations

from typing import Dict, Optional
from pydantic import BaseModel, Field


class SessionCfTrainingRequest(BaseModel):
    lookback_days: int = Field(90, description="So ngay activity_logs lay ve (mac dinh 90)")
    upload_r2: bool = Field(True, description="Tu upload artifact len R2 ngay sau khi train xong")
    dry_run: bool = Field(False, description="Chi train + eval, khong ghi artifact/upload R2")


class SessionCfTrainingResponse(BaseModel):
    success: bool
    run_id: str
    n_users: int
    n_items: int
    n_interactions: int
    n_explicit: int
    n_implicit: int
    overlap_places: int
    model_type: str
    global_mean: float
    n_train: int
    n_test: int
    metrics: Dict[str, float]
    artifact_dir: str
    exported: bool
    uploaded_r2: bool
    n_artifact_users: Optional[int] = None
    n_artifact_items: Optional[int] = None
    started_at: str
    completed_at: str
    duration_seconds: float
    error: Optional[str] = None
