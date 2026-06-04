from pydantic_settings import BaseSettings
from pydantic import ConfigDict


class Settings(BaseSettings):
    model_config = ConfigDict(
        env_file=".env",
        extra="ignore",
        protected_namespaces=(),
    )

    app_env:    str = "development"
    app_port:   int = 8000
    model_weights_dir: str = "weights"
    api_service_url:   str = "http://localhost:3000"
    hf_home:           str = ".cache/huggingface"

    # Two-Tower model paths (relative to ai-service root)
    two_tower_vocab_path:   str = "weights/vocab.pkl"
    two_tower_weights_path: str = "weights/best_model.weights.h5"


settings = Settings()
