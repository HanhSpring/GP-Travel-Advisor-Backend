"""Cấu hình chung cho retrain pipeline.

Đọc biến môi trường từ `ai-service/.env` (cùng file mà service đang dùng) —
KHÔNG import code của ai-service để pipeline độc lập hoàn toàn với service
đang chạy. Có thể override bằng biến môi trường thật hoặc file
`retrain/.env.retrain` (ưu tiên cao hơn .env của service).
"""

from __future__ import annotations

import os
from pathlib import Path

RETRAIN_DIR = Path(__file__).resolve().parent
AI_SERVICE_DIR = RETRAIN_DIR.parent

# Thư mục làm việc của pipeline (tất cả nằm gọn trong retrain/, không đụng service)
OUTPUT_DIR = RETRAIN_DIR / "output"
OUTPUT_DATA_DIR = OUTPUT_DIR / "data"
OUTPUT_ARTIFACT_DIR = OUTPUT_DIR / "recommender_artifacts"
STATE_DIR = RETRAIN_DIR / "state"
BACKUP_DIR = RETRAIN_DIR / "backups"
LOG_DIR = RETRAIN_DIR / "logs"

STATE_FILE = STATE_DIR / "retrain_state.json"
TOURIST_MAP_FILE = STATE_DIR / "tourist_user_map.csv"

# User thật (UUID) được cấp id số bắt đầu từ mốc này để không đụng id Foody.
TOURIST_NUMERIC_ID_BASE = 1_000_000_000


def _load_env_file(path: Path) -> None:
    """Nạp file .env đơn giản (KEY=VALUE) vào os.environ nếu key chưa tồn tại."""
    if not path.exists():
        return
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, val = line.partition("=")
        key, val = key.strip(), val.strip().strip('"').strip("'")
        if key and key not in os.environ:
            os.environ[key] = val


def load_env() -> dict:
    """Trả về dict cấu hình sau khi nạp .env.retrain (ưu tiên) rồi .env của service."""
    _load_env_file(RETRAIN_DIR / ".env.retrain")
    _load_env_file(AI_SERVICE_DIR / ".env")

    return {
        # Supabase — bắt buộc cho export
        "supabase_url": os.environ.get("SUPABASE_URL", ""),
        "supabase_key": os.environ.get("SUPABASE_KEY", ""),
        # R2 — tùy chọn; thiếu thì chỉ deploy local
        "r2_endpoint_url": os.environ.get("R2_ENDPOINT_URL", ""),
        "r2_access_key_id": os.environ.get("R2_ACCESS_KEY_ID", ""),
        "r2_secret_access_key": os.environ.get("R2_SECRET_ACCESS_KEY", ""),
        "r2_bucket_name": os.environ.get("R2_BUCKET_NAME", "ai-artifacts"),
        # Cache local mà ai-service dùng khi R2 bật (settings.artifact_cache_dir)
        "artifact_cache_dir": os.environ.get("ARTIFACT_CACHE_DIR", "/tmp/ai_cache"),
        # Đường dẫn local mà ai-service fallback khi R2 tắt
        "service_artifact_dir": os.environ.get(
            "RECO_ARTIFACT_DIR", str(AI_SERVICE_DIR / "recommender_artifacts")
        ),
        "service_data_dir": os.environ.get(
            "RECO_DATA_DIR", str(AI_SERVICE_DIR / "data")
        ),
        # Ratings Foody lịch sử (JSONL: user_id, id, stars)
        "foody_ratings_jsonl": os.environ.get(
            "RETRAIN_FOODY_RATINGS_JSONL",
            str(
                AI_SERVICE_DIR.parent.parent
                / "Recommendation_System"
                / "foody_two_tower_training_data_with_place_id.jsonl"
            ),
        ),
        # Lệnh restart ai-service sau khi deploy (tùy chọn, vd lệnh pm2/nssm/taskkill)
        "restart_cmd": os.environ.get("RETRAIN_RESTART_CMD", ""),
        # Ngưỡng chấp nhận RMSE mới so với bản cũ (mặc định xấu hơn tối đa 2%)
        "rmse_tolerance": float(os.environ.get("RETRAIN_RMSE_TOLERANCE", "0.02")),
    }


def ensure_dirs() -> None:
    for d in (OUTPUT_DATA_DIR, OUTPUT_ARTIFACT_DIR, STATE_DIR, BACKUP_DIR, LOG_DIR):
        d.mkdir(parents=True, exist_ok=True)
