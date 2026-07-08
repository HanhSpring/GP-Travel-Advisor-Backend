"""Điều phối retrain tự động — chạy định kỳ (Task Scheduler / cron).

Luồng:
    1. Phát hiện thay đổi   — so số places + reviews trên Supabase với lần chạy trước
                              (không có gì mới → thoát sau vài giây, không train vô ích)
    2. Export               — export_training_data.py (Places.csv + rating matrix mới)
    3. Train                — train_recommender.py (artifact mới trong retrain/output/)
    4. Quality gate         — test RMSE mới không được xấu hơn bản cũ quá RETRAIN_RMSE_TOLERANCE
    5. Deploy               — backup bản cũ → copy artifact vào thư mục local của ai-service
                              → upload R2 (nếu cấu hình) → xóa cache để service tải bản mới
    6. Restart (tùy chọn)   — chạy RETRAIN_RESTART_CMD nếu được cấu hình

Cách chạy:
    python retrain_pipeline.py              # chạy bình thường (có phát hiện thay đổi)
    python retrain_pipeline.py --force      # bỏ qua phát hiện thay đổi, train luôn
    python retrain_pipeline.py --grid-search  # kèm tìm siêu tham số (chạy thưa, vd mỗi tháng)
    python retrain_pipeline.py --dry-run    # làm hết nhưng KHÔNG deploy (để kiểm tra)
"""

from __future__ import annotations

import argparse
import json
import shutil
import subprocess
import sys
from datetime import datetime
from pathlib import Path

from pipeline_config import (
    BACKUP_DIR,
    LOG_DIR,
    OUTPUT_ARTIFACT_DIR,
    OUTPUT_DATA_DIR,
    STATE_FILE,
    ensure_dirs,
    load_env,
)

# File data mà ai-service cần lúc serve (đồng bộ lên R2 prefix data/)
DATA_FILES = [
    "Places.csv",
    "rating_matrix_foody.npz",
    "rating_matrix_foody_users.csv",
    "rating_matrix_foody_items.csv",
]


def log(msg: str) -> None:
    stamp = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    line = f"[{stamp}] {msg}"
    print(line, flush=True)
    log_file = LOG_DIR / f"retrain_{datetime.now():%Y%m}.log"
    with log_file.open("a", encoding="utf-8") as f:
        f.write(line + "\n")


# ────────────────────── 1. Phát hiện thay đổi ──────────────────────

def fetch_db_counts(cfg) -> dict:
    from supabase import create_client

    sb = create_client(cfg["supabase_url"], cfg["supabase_key"])

    places = (
        sb.schema("travel").table("places")
        .select("id", count="exact")
        .eq("is_approved", True).eq("is_active", True)
        .limit(1).execute()
    )
    reviews = (
        sb.schema("review_ai").table("reviews")
        .select("id", count="exact")
        .limit(1).execute()
    )
    latest = (
        sb.schema("review_ai").table("reviews")
        .select("created_at")
        .order("created_at", desc=True)
        .limit(1).execute()
    )
    max_created = (latest.data or [{}])[0].get("created_at", "")
    return {
        "places_count": places.count or 0,
        "db_reviews_count": reviews.count or 0,
        "db_reviews_max_created_at": max_created or "",
    }


def has_changes(current: dict, state: dict) -> bool:
    prev = state.get("db_counts", {})
    for key in ("places_count", "db_reviews_count", "db_reviews_max_created_at"):
        if current.get(key) != prev.get(key):
            log(f"Thay đổi ở {key}: {prev.get(key)!r} → {current.get(key)!r}")
            return True
    return False


def load_state() -> dict:
    if STATE_FILE.exists():
        return json.loads(STATE_FILE.read_text(encoding="utf-8"))
    return {}


def save_state(state: dict) -> None:
    STATE_FILE.write_text(
        json.dumps(state, ensure_ascii=False, indent=2), encoding="utf-8"
    )


# ────────────────────── 4. Quality gate ──────────────────────

def find_current_manifest(cfg) -> Path | None:
    """Manifest của bản đang chạy: ưu tiên cache R2, fallback thư mục local."""
    for base in (
        Path(cfg["artifact_cache_dir"]) / "recommender_artifacts",
        Path(cfg["service_artifact_dir"]),
    ):
        p = base / "serve_manifest.json"
        if p.exists():
            return p
    return None


def quality_gate(cfg, current_manifest: Path | None) -> None:
    new = json.loads(
        (OUTPUT_ARTIFACT_DIR / "serve_manifest.json").read_text(encoding="utf-8")
    )
    new_rmse = new.get("metrics", {}).get("test_rmse")
    if new_rmse is None:
        raise SystemExit("Quality gate: manifest mới thiếu metrics.test_rmse")

    if not current_manifest:
        log(f"Quality gate: chưa có bản cũ để so — chấp nhận (test_rmse={new_rmse:.4f})")
        return
    old = json.loads(current_manifest.read_text(encoding="utf-8"))
    old_rmse = old.get("metrics", {}).get("test_rmse")
    if old_rmse is None:
        log(f"Quality gate: bản cũ không có metrics (artifact tay) — chấp nhận (test_rmse={new_rmse:.4f})")
        return

    tolerance = cfg["rmse_tolerance"]
    if new_rmse > old_rmse * (1 + tolerance):
        raise SystemExit(
            f"Quality gate FAILED: test_rmse mới {new_rmse:.4f} xấu hơn bản cũ "
            f"{old_rmse:.4f} quá {tolerance:.0%} — KHÔNG deploy. "
            f"Artifact vẫn nằm ở {OUTPUT_ARTIFACT_DIR} để kiểm tra."
        )
    log(f"Quality gate OK: test_rmse {old_rmse:.4f} → {new_rmse:.4f}")


# ────────────────────── 5. Deploy ──────────────────────

def _copy_tree_files(src: Path, dst: Path, names: list[str] | None = None) -> None:
    dst.mkdir(parents=True, exist_ok=True)
    files = [src / n for n in names] if names else sorted(src.iterdir())
    for f in files:
        if f.is_file():
            shutil.copy2(f, dst / f.name)


def backup_current(cfg) -> None:
    stamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    dest = BACKUP_DIR / stamp
    for label, src in (
        ("recommender_artifacts", Path(cfg["service_artifact_dir"])),
        ("data", Path(cfg["service_data_dir"])),
    ):
        if src.exists() and any(src.iterdir()):
            _copy_tree_files(src, dest / label)
    if dest.exists():
        log(f"Đã backup bản cũ → {dest}")
    # Giữ tối đa 5 bản backup gần nhất
    backups = sorted([d for d in BACKUP_DIR.iterdir() if d.is_dir()])
    for old in backups[:-5]:
        shutil.rmtree(old, ignore_errors=True)


def deploy_local(cfg) -> None:
    _copy_tree_files(OUTPUT_ARTIFACT_DIR, Path(cfg["service_artifact_dir"]))
    _copy_tree_files(OUTPUT_DATA_DIR, Path(cfg["service_data_dir"]), DATA_FILES)
    log(
        f"Đã copy artifact mới vào {cfg['service_artifact_dir']} "
        f"và data vào {cfg['service_data_dir']}"
    )


def _r2_configured(cfg) -> bool:
    return bool(
        cfg["r2_endpoint_url"]
        and cfg["r2_access_key_id"]
        and cfg["r2_secret_access_key"]
        and cfg["r2_bucket_name"]
    )


def deploy_r2(cfg) -> None:
    if not _r2_configured(cfg):
        log("R2 chưa cấu hình → bỏ qua upload (service sẽ dùng thư mục local)")
        return
    import boto3
    from botocore.config import Config

    client = boto3.client(
        "s3",
        endpoint_url=cfg["r2_endpoint_url"],
        aws_access_key_id=cfg["r2_access_key_id"],
        aws_secret_access_key=cfg["r2_secret_access_key"],
        config=Config(signature_version="s3v4"),
        region_name="auto",
    )
    bucket = cfg["r2_bucket_name"]
    uploads = [
        (OUTPUT_ARTIFACT_DIR, "recommender_artifacts/", None),
        (OUTPUT_DATA_DIR, "data/", DATA_FILES),
    ]
    for src, prefix, names in uploads:
        files = [src / n for n in names] if names else sorted(src.iterdir())
        for f in files:
            if not f.is_file():
                continue
            key = prefix + f.name
            log(f"⬆ Upload r2://{bucket}/{key} ({f.stat().st_size / 1024 / 1024:.1f} MB)")
            client.upload_file(str(f), bucket, key)
    log("Upload R2 hoàn tất")

    # Xóa cache local của service: r2_downloader chỉ so SIZE, file .npy cùng
    # shape sẽ cùng size → nếu không xóa, service restart vẫn dùng bản cũ.
    cache = Path(cfg["artifact_cache_dir"])
    for sub in ("recommender_artifacts", "data"):
        target = cache / sub
        if target.exists():
            shutil.rmtree(target, ignore_errors=True)
            log(f"Đã xóa cache {target} — service sẽ tải bản mới từ R2 khi khởi động")


def restart_service(cfg) -> None:
    cmd = cfg["restart_cmd"]
    if not cmd:
        log(
            "⚠ RETRAIN_RESTART_CMD chưa cấu hình — hãy restart ai-service thủ công "
            "để nạp artifact mới."
        )
        return
    log(f"Restart ai-service: {cmd}")
    result = subprocess.run(cmd, shell=True, capture_output=True, text=True)
    if result.returncode != 0:
        log(f"⚠ Restart thất bại (exit={result.returncode}): {result.stderr.strip()}")
    else:
        log("Restart OK")


# ────────────────────── Main ──────────────────────

def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--force", action="store_true", help="Bỏ qua phát hiện thay đổi")
    ap.add_argument("--grid-search", action="store_true", help="Tìm lại siêu tham số SVD")
    ap.add_argument("--dry-run", action="store_true", help="Train nhưng không deploy")
    args = ap.parse_args()

    ensure_dirs()
    cfg = load_env()
    log("═══ Retrain pipeline bắt đầu ═══")

    # 1. Phát hiện thay đổi
    state = load_state()
    counts = fetch_db_counts(cfg)
    if not args.force and not has_changes(counts, state):
        log("Không có địa điểm/review mới — kết thúc, không train.")
        return

    # 2. Export
    log("── Bước export ──")
    import export_training_data

    export_training_data.main()

    # 3. Train
    log("── Bước train ──")
    import train_recommender

    current_manifest = find_current_manifest(cfg)
    train_recommender.main(
        grid_search=args.grid_search, prev_manifest=current_manifest
    )

    # 4. Quality gate
    quality_gate(cfg, current_manifest)

    if args.dry_run:
        log(f"--dry-run: artifact mới nằm ở {OUTPUT_ARTIFACT_DIR}, KHÔNG deploy.")
        return

    # 5. Deploy
    log("── Bước deploy ──")
    backup_current(cfg)
    deploy_local(cfg)
    deploy_r2(cfg)

    # 6. Restart
    restart_service(cfg)

    state["db_counts"] = counts
    state["last_deployed_at"] = datetime.now().isoformat()
    save_state(state)
    log("═══ Retrain pipeline hoàn tất ═══")


if __name__ == "__main__":
    try:
        sys.stdout.reconfigure(encoding="utf-8")
    except Exception:
        pass
    main()
