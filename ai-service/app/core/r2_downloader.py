"""Download artifact/data từ Cloudflare R2 về cache cục bộ khi khởi động.

- R2 tương thích S3 API → dùng boto3 với endpoint tùy chỉnh.
- File đã có local (size khớp) → bỏ qua, không download lại.
- Fallback: nếu R2 chưa cấu hình → dùng đường dẫn local cũ.
"""

from __future__ import annotations

import os
from pathlib import Path

from app.core.logger import get_logger

logger = get_logger(__name__)

# Các file được phép skip (tài liệu, không dùng lúc serve)
_SKIP_SUFFIXES = {".md", ".txt"}
_SKIP_DIRS = {"samples_csv"}


def ensure_artifacts(settings) -> tuple[Path, Path]:
    """Đảm bảo artifact và data có ở local cache; trả về (artifact_dir, data_dir).

    Nếu R2 chưa cấu hình: trả về đường dẫn local từ settings (hành vi cũ).
    Nếu R2 đã cấu hình: download về cache rồi trả về đường dẫn cache.
    """
    if not _r2_configured(settings):
        logger.info("R2 chưa cấu hình → dùng local: %s / %s",
                    settings.reco_artifact_dir, settings.reco_data_dir)
        return Path(settings.reco_artifact_dir), Path(settings.reco_data_dir)

    cache = Path(settings.artifact_cache_dir)
    artifact_dir = cache / "recommender_artifacts"
    data_dir = cache / "data"
    artifact_dir.mkdir(parents=True, exist_ok=True)
    data_dir.mkdir(parents=True, exist_ok=True)

    client = _make_client(settings)
    bucket = settings.r2_bucket_name

    logger.info("🔄 Đồng bộ artifact từ R2 bucket '%s'...", bucket)
    _sync_prefix(
        client,
        bucket,
        "recommender_artifacts/",
        artifact_dir,
        skip_suffixes=_SKIP_SUFFIXES,
        skip_dirs=_SKIP_DIRS,
    )
    _sync_prefix(
        client,
        bucket,
        "data/",
        data_dir,
        skip_suffixes=_SKIP_SUFFIXES,
        skip_dirs=_SKIP_DIRS,
    )
    logger.info("✅ Artifact đã sẵn sàng tại %s", cache)

    return artifact_dir, data_dir


def ensure_r2_prefix(settings, prefix: str, local_dir: Path) -> Path:
    """Ensure all objects under an R2 prefix exist in a local cache directory.

    This is useful for model directories such as HuggingFace checkpoints, where
    transformers expects a normal filesystem path containing config/model files.
    """
    if not prefix:
        raise ValueError("R2 prefix must not be empty")
    if not _r2_configured(settings):
        raise ValueError("R2 is not configured")

    normalized_prefix = prefix.strip("/")
    local_dir.mkdir(parents=True, exist_ok=True)

    client = _make_client(settings)
    bucket = settings.r2_bucket_name
    _sync_prefix(client, bucket, f"{normalized_prefix}/", local_dir)
    return local_dir


# ─────────────────────────── internal ────────────────────────────────────────

def _r2_configured(settings) -> bool:
    return bool(
        settings.r2_endpoint_url
        and settings.r2_access_key_id
        and settings.r2_secret_access_key
        and settings.r2_bucket_name
    )


def _make_client(settings):
    import boto3
    from botocore.config import Config

    return boto3.client(
        "s3",
        endpoint_url=settings.r2_endpoint_url,
        aws_access_key_id=settings.r2_access_key_id,
        aws_secret_access_key=settings.r2_secret_access_key,
        config=Config(signature_version="s3v4"),
        region_name="auto",
    )


def _sync_prefix(
    client,
    bucket: str,
    prefix: str,
    local_dir: Path,
    skip_suffixes: set[str] | None = None,
    skip_dirs: set[str] | None = None,
) -> None:
    """Download tất cả object dưới prefix; bỏ qua nếu local size đã khớp."""
    paginator = client.get_paginator("list_objects_v2")
    total, skipped, downloaded = 0, 0, 0

    for page in paginator.paginate(Bucket=bucket, Prefix=prefix):
        for obj in page.get("Contents", []):
            key: str = obj["Key"]
            # Bỏ prefix để lấy tên tương đối
            rel = key[len(prefix):]
            if not rel:
                continue

            # Bỏ qua subdirectory không cần thiết
            parts = rel.split("/")
            if skip_dirs and len(parts) > 1 and parts[0] in skip_dirs:
                continue

            # Bỏ qua file tài liệu
            if skip_suffixes and Path(rel).suffix.lower() in skip_suffixes:
                continue

            total += 1
            local_path = local_dir / rel
            local_path.parent.mkdir(parents=True, exist_ok=True)

            remote_size: int = obj["Size"]
            if local_path.exists() and local_path.stat().st_size == remote_size:
                skipped += 1
                logger.debug("Bỏ qua (đã có): %s", rel)
                continue

            mb = remote_size / 1024 / 1024
            logger.info("⬇ Downloading %-45s (%.1f MB)...", rel, mb)
            client.download_file(bucket, key, str(local_path))
            downloaded += 1
            logger.info("  ✓ %s", rel)

    logger.info(
        "Prefix '%s': %d file, %d tải mới, %d đã có.",
        prefix, total, downloaded, skipped,
    )
