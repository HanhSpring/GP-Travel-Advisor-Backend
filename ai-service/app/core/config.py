from dotenv import load_dotenv
from pydantic_settings import BaseSettings
from typing import Optional
from pydantic import ConfigDict


load_dotenv(".env", override=False)


class Settings(BaseSettings):
    model_config = ConfigDict(
        env_file=".env",
        extra="ignore",
        protected_namespaces=(),
    )

    app_env:    str = "development"
    app_port:   int = 8000
    model_weights_dir: str = "weights"
    api_service_url: str = "http://localhost:3000"
    hf_home: str = ".cache/huggingface"
    hf_token: Optional[str] = None

    # Supabase (service_role bypasses RLS)
    supabase_url: str = ""
    supabase_key: str = ""
    ai_config_schema: str = "ai_config"

    # Pipeline output
    pipeline_output_dir: str = "./output"

    # PhoBERT path (optional)
    phobert_time_model_path: Optional[str] = None
    phobert_time_model_r2_prefix: Optional[str] = None
    phobert_time_model_cache_dir: str = "/tmp/ai_cache/phobert_timelabel/checkpoint-60"

    # Recommender local paths
    reco_artifact_dir: str = "recommender_artifacts"
    reco_data_dir: str = "data"

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


settings = Settings()
