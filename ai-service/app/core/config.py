from pydantic_settings import BaseSettings
from typing import Optional


class Settings(BaseSettings):
    app_env: str = "development"
    app_port: int = 8000
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

    class Config:
        env_file = ".env"


settings = Settings()
