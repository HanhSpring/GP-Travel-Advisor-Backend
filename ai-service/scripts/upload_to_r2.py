"""Upload data/ và recommender_artifacts/ lên Cloudflare R2.

Chạy một lần duy nhất từ máy local có sẵn các file.

Cách dùng:
    pip install boto3
    python scripts/upload_to_r2.py

Yêu cầu: đặt 4 biến môi trường bên dưới (hoặc điền trực tiếp vào script):
    R2_ENDPOINT_URL      https://<account_id>.r2.cloudflarestorage.com
    R2_ACCESS_KEY_ID     <access_key>
    R2_SECRET_ACCESS_KEY <secret_key>
    R2_BUCKET_NAME       ai-artifacts   (hoặc tên bucket bạn chọn)
"""

from __future__ import annotations

import os
import sys
from pathlib import Path

import boto3
from botocore.config import Config
from boto3.s3.transfer import TransferConfig

# ── Load .env tự động ────────────────────────────────────────────────────────
def _load_dotenv():
    env_path = Path(__file__).parent.parent / ".env"
    if not env_path.exists():
        return
    for line in env_path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, val = line.partition("=")
        key = key.strip()
        val = val.strip()
        if key and key not in os.environ:
            os.environ[key] = val

_load_dotenv()

# ── Cấu hình ─────────────────────────────────────────────────────────────────
ENDPOINT_URL = os.environ.get("R2_ENDPOINT_URL", "")
ACCESS_KEY   = os.environ.get("R2_ACCESS_KEY_ID", "")
SECRET_KEY   = os.environ.get("R2_SECRET_ACCESS_KEY", "")
BUCKET       = os.environ.get("R2_BUCKET_NAME", "ai-artifacts")
TRANSFER_CONFIG = TransferConfig(
    multipart_threshold=64 * 1024 ** 2,
    multipart_chunksize=64 * 1024 ** 2,
    max_concurrency=4,
)
FORCE_UPLOAD = os.environ.get("R2_FORCE_UPLOAD", "").strip().lower() in {
    "1",
    "true",
    "yes",
    "y",
    "on",
}

# Thư mục nguồn (đường dẫn tương đối so với script này)
SCRIPT_DIR   = Path(__file__).parent.parent   # gốc ai-service/
UPLOAD_DIRS  = {
    "recommender_artifacts": SCRIPT_DIR / "recommender_artifacts",
    "data": SCRIPT_DIR / "data",
    "phobert_timelabel/checkpoint-264": SCRIPT_DIR / "app" / "models" / "phobert_timelabel" / "checkpoint-264",
}

# File / thư mục không cần thiết cho serving (bỏ qua khi upload)
SKIP_NAMES   = {"README.md", "samples_csv"}
SKIP_SUFFIXES = {".md"}
# ─────────────────────────────────────────────────────────────────────────────


def main():
    if not all([ENDPOINT_URL, ACCESS_KEY, SECRET_KEY]):
        print("❌ Thiếu biến môi trường R2. Xem hướng dẫn đầu file.")
        sys.exit(1)

    client = boto3.client(
        "s3",
        endpoint_url=ENDPOINT_URL,
        aws_access_key_id=ACCESS_KEY,
        aws_secret_access_key=SECRET_KEY,
        config=Config(signature_version="s3v4"),
        region_name="auto",
    )

    # Kiểm tra bucket tồn tại
    try:
        client.head_bucket(Bucket=BUCKET)
        print(f"✅ Bucket '{BUCKET}' đã tồn tại.")
    except Exception:
        print(f"⚠ Bucket '{BUCKET}' chưa có — tạo mới...")
        client.create_bucket(Bucket=BUCKET)
        print(f"✅ Đã tạo bucket '{BUCKET}'.")

    total_uploaded = 0
    total_skipped  = 0

    for prefix, local_dir in UPLOAD_DIRS.items():
        if not local_dir.exists():
            print(f"⚠ Thư mục '{local_dir}' không tồn tại — bỏ qua.")
            continue

        print(f"\n📁 Upload '{local_dir.name}/' → R2:{BUCKET}/{prefix}/")

        for local_path in sorted(local_dir.rglob("*")):
            if not local_path.is_file():
                continue

            # Bỏ qua theo tên / đuôi / thư mục cha
            rel = local_path.relative_to(local_dir)
            parts = rel.parts
            if any(p in SKIP_NAMES for p in parts):
                continue
            if local_path.suffix.lower() in SKIP_SUFFIXES:
                continue

            r2_key = f"{prefix}/{rel.as_posix()}"
            size_mb = local_path.stat().st_size / 1024 / 1024

            # Kiểm tra đã upload chưa (so sánh size)
            try:
                head = None if FORCE_UPLOAD else client.head_object(Bucket=BUCKET, Key=r2_key)
                if head and head["ContentLength"] == local_path.stat().st_size:
                    print(f"  ⏭ Skip (đã có): {r2_key}")
                    total_skipped += 1
                    continue
            except Exception:
                pass  # object chưa có → upload

            print(f"  ⬆ Uploading {r2_key:<55} ({size_mb:.1f} MB)...", end="", flush=True)
            client.upload_file(
                str(local_path), BUCKET, r2_key,
                Config=TRANSFER_CONFIG,
            )
            print(" ✓")
            total_uploaded += 1

    print(f"\n🎉 Xong! Upload mới: {total_uploaded} file, bỏ qua: {total_skipped} file.")
    print(f"   Bucket: {BUCKET}  |  Endpoint: {ENDPOINT_URL}")


if __name__ == "__main__":
    main()
