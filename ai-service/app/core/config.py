from pydantic_settings import BaseSettings


class Settings(BaseSettings):
    app_env: str = "development"
    app_port: int = 8000
    model_weights_dir: str = "weights"
    api_service_url: str = "http://localhost:3000"
    hf_home: str = ".cache/huggingface"

    class Config:
        env_file = ".env"


settings = Settings()
