from pydantic_settings import BaseSettings


class Settings(BaseSettings):
    app_env: str = "development"
    app_port: int = 8000
    model_weights_dir: str = "weights"
    api_service_url: str = "http://localhost:3000"
    hf_home: str = ".cache/huggingface"

    # Recommender (mục "Có thể bạn sẽ thích" ở Place Detail)
    # Khi R2 được cấu hình, hai đường dẫn này bị bỏ qua (dùng cache từ R2).
    reco_artifact_dir: str = "recommender_artifacts"
    reco_data_dir: str = "data"

    # Cloudflare R2 — lưu artifact offline thay vì local disk.
    # Endpoint dạng: https://<account_id>.r2.cloudflarestorage.com
    r2_endpoint_url: str = ""
    r2_access_key_id: str = ""
    r2_secret_access_key: str = ""
    r2_bucket_name: str = "ai-artifacts"
    # Thư mục cache cục bộ — tồn tại giữa các lần restart process.
    artifact_cache_dir: str = "/tmp/ai_cache"

    # Supabase (đọc/ghi cấu hình thuật toán trong schema ai_config qua PostgREST)
    supabase_url: str = ""
    supabase_key: str = ""
    ai_config_schema: str = "ai_config"

    class Config:
        env_file = ".env"


settings = Settings()
