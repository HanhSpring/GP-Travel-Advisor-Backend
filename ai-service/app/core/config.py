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

    # Supabase — dùng cho review_filter_pipeline
    supabase_url: str = ""
    supabase_key: str = ""

    # Thư mục output cho pipeline (mỗi lần chạy tạo subdirectory mới)
    pipeline_output_dir: str = "./output"

    # Đường dẫn model PhoBERT fine-tune (tuỳ chọn)
    phobert_time_model_path: Optional[str] = None

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

    # Two-Tower model paths (relative to ai-service root)
    two_tower_vocab_path:   str = "weights/vocab.pkl"
    two_tower_weights_path: str = "weights/best_model.weights.h5"


settings = Settings()
