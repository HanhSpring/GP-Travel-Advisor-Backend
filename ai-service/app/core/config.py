import os
from pathlib import Path

from dotenv import dotenv_values, load_dotenv
from pydantic_settings import BaseSettings
from typing import Optional
from pathlib import Path
from pydantic import ConfigDict


AI_SERVICE_ROOT = Path(__file__).resolve().parents[2]
BACKEND_ROOT = AI_SERVICE_ROOT.parent

load_dotenv(AI_SERVICE_ROOT / ".env", override=False)

# NestJS owns the active database configuration. Reuse exactly the same
# Supabase URL/key so AI config and review jobs cannot drift to another DB.
api_env = dotenv_values(BACKEND_ROOT / "api-service" / ".env")
for key in ("SUPABASE_URL", "SUPABASE_KEY"):
    value = str(api_env.get(key) or "").strip()
    if value:
        os.environ[key] = value


class Settings(BaseSettings):
    model_config = ConfigDict(
        env_file=str(AI_SERVICE_ROOT / ".env"),
        extra="ignore",
        protected_namespaces=(),
    )

    app_env:    str = "development"
    app_port:   int = 8000
    model_weights_dir: str = "weights"
    api_service_url: str = "http://localhost:3000"
    hf_home: str = ".cache/huggingface"
    hf_token: Optional[str] = None
    preload_bge_m3: bool = False
    embedding_wait_timeout_seconds: float = 5.0
    review_pipeline_wait_timeout_seconds: float = 10.0

    # Supabase (service_role bypasses RLS)
    supabase_url: str = ""
    supabase_key: str = ""
    ai_config_schema: str = "ai_config"

    # Pipeline output
    pipeline_output_dir: str = "./output"
    pipeline_save_json: bool = False

    # PhoBERT path (optional)
    phobert_time_model_path: Optional[str] = None
    phobert_time_model_r2_prefix: Optional[str] = None
    phobert_time_model_cache_dir: str = "/tmp/ai_cache/phobert_timelabel/checkpoint-476"

    # Recommender local paths
    reco_artifact_dir: str = "recommender_artifacts"
    reco_data_dir: str = "data"

    # Session-Aware CF Reranker local path (artifact riêng, không đè lên reco_artifact_dir của Ngọc)
    session_cf_artifact_dir: str = "artifacts_session_cf"

    # Cloudflare R2
    r2_endpoint_url: str = ""
    r2_access_key_id: str = ""
    r2_secret_access_key: str = ""
    r2_bucket_name: str = "ai-artifacts"
    artifact_cache_dir: str = "/tmp/ai_cache"

    # Two-Tower local paths
    two_tower_vocab_path:   str = "weights/vocab.pkl"
    two_tower_weights_path: str = "weights/best_model.weights.h5"

    # Two-Tower R2 keys
    two_tower_vocab_r2_key:    str = "two-tower/vocab.pkl"
    two_tower_weights_r2_key:  str = "two-tower/best_model.weights.h5"

    # Goong Maps API (empty = Haversine fallback)
    goong_api_key: str = ""

    # Modal.com (docs/trigger/06-modal-primary-plan.md) — trigger job GPU train Two-Tower thật.
    # modal_trigger_training_url = URL cua Modal Web Endpoint "trigger_training" (in ra sau khi
    # `modal deploy modal_training/modal_app.py`). modal_trigger_secret PHAI khop
    # MODAL_TRIGGER_SECRET dat trong Modal Secret "training-callback-secret".
    modal_trigger_training_url: str = ""
    modal_trigger_secret: str = ""

    # Kaggle Notebooks (docs/trigger/09-migrate-modal-to-kaggle.md) -- phuong an du phong khong
    # can the thanh toan, thay the tam thoi cho Modal. training_backend chon nhanh nao dang dung o
    # two_tower_training.py::train() -- doi ve "modal" bat ky luc nao (xem muc 11, rollback) ma
    # khong can sua code. kaggle_username/kaggle_key: dung "Legacy API Key" (khong phai token don
    # KAGGLE_API_TOKEN moi cua Kaggle -- CLI kaggle chua ho tro loai token do, xem muc 3 cua doc).
    kaggle_username: str = ""
    kaggle_key: str = ""
    kaggle_kernel_slug: str = "gp-travel-two-tower-training"
    kaggle_dataset_slug: str = "gp-travel-two-tower-training-src"
    training_backend: str = "modal"   # "modal" | "kaggle"

    # Debug-only: dump a Leaflet HTML map per geo-clustering pipeline stage
    # (HDBSCAN raw clusters -> noise/region merge -> K-Means day-split ->
    # weekday matching) into api-service's shared debug-log folder. Off by
    # default — purely a developer tool, never needed for normal planning.
    enable_clustering_debug_viz: bool = False


settings = Settings()
