from pydantic_settings import BaseSettings


class Settings(BaseSettings):
    app_env: str = "development"
    app_port: int = 8000
    model_weights_dir: str = "weights"
    api_service_url: str = "http://localhost:3000"
    hf_home: str = ".cache/huggingface"

    # Recommender (mục "Có thể bạn sẽ thích" ở Place Detail)
    reco_artifact_dir: str = "recommender_artifacts"
    reco_data_dir: str = "data"

    # Supabase (đọc/ghi cấu hình thuật toán trong schema ai_config qua PostgREST)
    supabase_url: str = ""
    supabase_key: str = ""
    ai_config_schema: str = "ai_config"

    class Config:
        env_file = ".env"


settings = Settings()
