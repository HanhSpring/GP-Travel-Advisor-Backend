from __future__ import annotations

import argparse
import os
import sys
from pathlib import Path

if sys.platform == "win32":
    sys.stdout.reconfigure(encoding="utf-8")
    sys.stderr.reconfigure(encoding="utf-8")

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
    "phobert_timelabel/checkpoint-476": SCRIPT_DIR / "app" / "models" / "phobert_timelabel" / "checkpoint-476",
    
    "artifacts_session_cf": SCRIPT_DIR / "artifacts_session_cf",
}


SKIP_NAMES   = {"README.md", "samples_csv"}
SKIP_SUFFIXES = {".md"}
# ─────────────────────────────────────────────────────────────────────────────


def _parse_args():
    parser = argparse.ArgumentParser(description="Upload AI-service assets to Cloudflare R2")
    parser.add_argument(
        "--only",
        choices=sorted(UPLOAD_DIRS),
        help="Only upload one configured R2 prefix (default: upload all prefixes)",
    )
    return parser.parse_args()


def make_r2_client():
    if not all([ENDPOINT_URL, ACCESS_KEY, SECRET_KEY]):
        raise RuntimeError(
            "Thiếu biến môi trường R2 (R2_ENDPOINT_URL/R2_ACCESS_KEY_ID/R2_SECRET_ACCESS_KEY)"
        )
    return boto3.client(
        "s3",
        endpoint_url=ENDPOINT_URL,
        aws_access_key_id=ACCESS_KEY,
        aws_secret_access_key=SECRET_KEY,
        config=Config(signature_version="s3v4"),
        region_name="auto",
    )


def ensure_bucket(client) -> None:
    try:
        client.head_bucket(Bucket=BUCKET)
    except Exception:
        client.create_bucket(Bucket=BUCKET)


def upload_prefix(prefix: str, local_dir: Path, client=None) -> dict:
   
    own_client = client is None
    if own_client:
        client = make_r2_client()
        ensure_bucket(client)

    if not local_dir.exists():
        return {"uploaded": 0, "skipped": 0, "error": f"Thư mục '{local_dir}' không tồn tại"}

    uploaded, skipped = 0, 0
    for local_path in sorted(local_dir.rglob("*")):
        if not local_path.is_file():
            continue

        rel = local_path.relative_to(local_dir)
        parts = rel.parts
        if any(p in SKIP_NAMES for p in parts):
            continue
        if local_path.suffix.lower() in SKIP_SUFFIXES:
            continue

        r2_key = f"{prefix}/{rel.as_posix()}"
        size_mb = local_path.stat().st_size / 1024 / 1024

        try:
            head = None if FORCE_UPLOAD else client.head_object(Bucket=BUCKET, Key=r2_key)
            if head and head["ContentLength"] == local_path.stat().st_size:
                print(f"  ⏭ Skip (đã có): {r2_key}")
                skipped += 1
                continue
        except Exception:
            pass  # object chưa có → upload

        print(f"  ⬆ Uploading {r2_key:<55} ({size_mb:.1f} MB)...", end="", flush=True)
        client.upload_file(str(local_path), BUCKET, r2_key, Config=TRANSFER_CONFIG)
        print(" ✓")
        uploaded += 1

    return {"uploaded": uploaded, "skipped": skipped, "error": None}


def main():
    args = _parse_args()

    if not all([ENDPOINT_URL, ACCESS_KEY, SECRET_KEY]):
        print("❌ Thiếu biến môi trường R2. Xem hướng dẫn đầu file.")
        sys.exit(1)

    client = make_r2_client()
    ensure_bucket(client)
    print(f"✅ Bucket '{BUCKET}' sẵn sàng.")

    total_uploaded = 0
    total_skipped  = 0

    upload_dirs = (
        {args.only: UPLOAD_DIRS[args.only]}
        if args.only
        else UPLOAD_DIRS
    )

    for prefix, local_dir in upload_dirs.items():
        if not local_dir.exists():
            print(f"⚠ Thư mục '{local_dir}' không tồn tại — bỏ qua.")
            continue

        print(f"\n📁 Upload '{local_dir.name}/' → R2:{BUCKET}/{prefix}/")
        result = upload_prefix(prefix, local_dir, client=client)
        total_uploaded += result["uploaded"]
        total_skipped += result["skipped"]

    print(f"\n🎉 Xong! Upload mới: {total_uploaded} file, bỏ qua: {total_skipped} file.")
    print(f"   Bucket: {BUCKET}  |  Endpoint: {ENDPOINT_URL}")


if __name__ == "__main__":
    main()
