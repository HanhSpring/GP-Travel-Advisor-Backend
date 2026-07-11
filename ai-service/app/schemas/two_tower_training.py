from __future__ import annotations

from typing import Optional

from pydantic import BaseModel, Field


class PrepareDatasetRequest(BaseModel):
    run_id: Optional[str] = Field(None, description="Mac dinh: timestamp UTC hien tai")


class PrepareDatasetResponse(BaseModel):
    run_id: str
    r2_prefix: str
    n_interactions: int
    n_users: int
    n_places: int
    date_range_start: Optional[str] = None
    date_range_end: Optional[str] = None
    generated_at: str
    started_at: str
    completed_at: str
    duration_seconds: float


class TrainRequest(BaseModel):
    run_id: str = Field(..., description="Id duy nhat cho lan train nay, lien ket voi training_runs/model_versions")
    dataset_r2_prefix: str = Field(..., description="vd training-datasets/two_tower/{run_id} (tu prepare-dataset)")
    warm_start_weights_r2_key: Optional[str] = Field(None, description="R2 key weights cua version dang active, de warm-start")
    warm_start_vocab_r2_key: Optional[str] = Field(None, description="R2 key vocab cua version dang active, de warm-start")
    include_yelp: Optional[bool] = Field(None, description="Mac dinh: khong warm-start -> True, co warm-start -> False")
    is_demo_mode: bool = Field(False, description="True: chay nhanh/re de test luong end-to-end, khong dung cho bao cao")


class TrainResponse(BaseModel):
    status: str
    modal_call_id: Optional[str] = None


class ReloadRequest(BaseModel):
    weights_r2_key: str = Field(..., description="vd two-tower/versions/{run_id}/best_model.weights.h5")
    vocab_r2_key: str = Field(..., description="vd two-tower/versions/{run_id}/vocab.pkl")
    model_version_id: Optional[str] = Field(None, description="id ai_config.model_versions, chi de tra ve/log")


class ReloadResponse(BaseModel):
    success: bool
    model_version_id: Optional[str] = None
    started_at: str
    completed_at: str
    duration_seconds: float
