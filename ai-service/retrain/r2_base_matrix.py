"""Upload/download the immutable base rating matrix through Cloudflare R2."""

from __future__ import annotations

import hashlib
from pathlib import Path

CANONICAL_FILES = (
    "rating_matrix_foody.npz",
    "rating_matrix_foody_users.csv",
    "rating_matrix_foody_items.csv",
)
LEGACY_FILES = (
    "rating_matrix.npz",
    "rating_matrix_users.csv",
    "rating_matrix_items.csv",
)


def _configured(cfg: dict) -> bool:
    return bool(
        cfg["r2_endpoint_url"]
        and cfg["r2_access_key_id"]
        and cfg["r2_secret_access_key"]
        and cfg["r2_bucket_name"]
    )


def _client(cfg: dict):
    import boto3
    from botocore.config import Config

    return boto3.client(
        "s3",
        endpoint_url=cfg["r2_endpoint_url"],
        aws_access_key_id=cfg["r2_access_key_id"],
        aws_secret_access_key=cfg["r2_secret_access_key"],
        config=Config(signature_version="s3v4"),
        region_name="auto",
    )


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def resolve_source_files(source_dir: Path) -> list[tuple[Path, str]]:
    canonical = [source_dir / name for name in CANONICAL_FILES]
    if all(path.is_file() for path in canonical):
        return list(zip(canonical, CANONICAL_FILES))
    legacy = [source_dir / name for name in LEGACY_FILES]
    if all(path.is_file() for path in legacy):
        return list(zip(legacy, CANONICAL_FILES))
    expected = ", ".join(CANONICAL_FILES)
    raise FileNotFoundError(f"Không tìm thấy bộ base rating matrix trong {source_dir}: {expected}")


def upload_base_matrix(cfg: dict, source_dir: Path) -> None:
    if not _configured(cfg):
        raise RuntimeError("Thiếu cấu hình R2")
    client = _client(cfg)
    bucket = cfg["r2_bucket_name"]
    prefix = cfg["r2_base_training_prefix"]
    for source, canonical_name in resolve_source_files(source_dir):
        key = f"{prefix}/{canonical_name}"
        checksum = _sha256(source)
        print(f"[base-r2] Upload {source} -> r2://{bucket}/{key}")
        client.upload_file(
            str(source), bucket, key,
            ExtraArgs={"Metadata": {"sha256": checksum}},
        )
        head = client.head_object(Bucket=bucket, Key=key)
        if int(head["ContentLength"]) != source.stat().st_size:
            raise RuntimeError(f"R2 size mismatch after upload: {key}")
        print(f"[base-r2]   OK size={source.stat().st_size} sha256={checksum[:12]}...")


def download_base_matrix(cfg: dict) -> Path:
    if not _configured(cfg):
        raise RuntimeError("RETRAIN_BASE_RATING_SOURCE=r2 nhưng thiếu cấu hình R2")
    client = _client(cfg)
    bucket = cfg["r2_bucket_name"]
    prefix = cfg["r2_base_training_prefix"]
    cache = Path(cfg["base_rating_cache_dir"]).expanduser().resolve()
    cache.mkdir(parents=True, exist_ok=True)

    for name in CANONICAL_FILES:
        key = f"{prefix}/{name}"
        target = cache / name
        head = client.head_object(Bucket=bucket, Key=key)
        remote_size = int(head["ContentLength"])
        remote_hash = (head.get("Metadata") or {}).get("sha256")
        reusable = target.is_file() and target.stat().st_size == remote_size
        if reusable and remote_hash:
            reusable = _sha256(target) == remote_hash
        if reusable:
            print(f"[base-r2] Cache hit: {target}")
            continue
        temp = target.with_suffix(target.suffix + ".part")
        print(f"[base-r2] Download r2://{bucket}/{key} -> {target}")
        client.download_file(bucket, key, str(temp))
        if temp.stat().st_size != remote_size:
            temp.unlink(missing_ok=True)
            raise RuntimeError(f"R2 download size mismatch: {key}")
        if remote_hash and _sha256(temp) != remote_hash:
            temp.unlink(missing_ok=True)
            raise RuntimeError(f"R2 download checksum mismatch: {key}")
        temp.replace(target)
    return cache


def resolve_base_matrix_dir(cfg: dict) -> Path:
    source = cfg.get("base_rating_source", "auto")
    configured_dir = Path(cfg["base_rating_matrix_dir"]).expanduser()
    if source == "local":
        return configured_dir
    if source == "r2":
        return download_base_matrix(cfg)
    try:
        resolve_source_files(configured_dir)
        return configured_dir
    except FileNotFoundError:
        print("[base-r2] Base matrix local không đủ -> fallback R2")
        return download_base_matrix(cfg)
