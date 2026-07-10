"""Colab retrain pipeline.

This wrapper runs the existing retrain pipeline with all state/output folders
stored on Google Drive instead of the local repository. It is intended for
Colab Pro runs:

    python colab_retrain_pipeline.py --force --dry-run
    python colab_retrain_pipeline.py --force

Required env:
    COLAB_RETRAIN_DRIVE_ROOT=/content/drive/MyDrive/GP-Retrain
    SUPABASE_URL, SUPABASE_KEY
    R2_ENDPOINT_URL, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET_NAME
"""

from __future__ import annotations

import argparse
import json
import os
import shutil
import sys
from datetime import datetime
from pathlib import Path

import pipeline_config as cfgmod


def _patch_paths(drive_root: Path) -> None:
    """Point pipeline_config paths at Google Drive."""
    cfgmod.OUTPUT_DIR = drive_root / "output"
    cfgmod.OUTPUT_DATA_DIR = drive_root / "output" / "data"
    cfgmod.OUTPUT_ARTIFACT_DIR = drive_root / "output" / "recommender_artifacts"
    cfgmod.STATE_DIR = drive_root / "state"
    cfgmod.BACKUP_DIR = drive_root / "backups"
    cfgmod.LOG_DIR = drive_root / "logs"
    cfgmod.STATE_FILE = cfgmod.STATE_DIR / "retrain_state.json"
    cfgmod.TOURIST_MAP_FILE = cfgmod.STATE_DIR / "tourist_user_map.csv"

    # Modules imported after this point receive the patched objects because
    # they import names from pipeline_config at import time.


def _ensure_drive_layout(drive_root: Path) -> None:
    for rel in (
        "state",
        "input",
        "output/data",
        "output/recommender_artifacts",
        "logs",
        "backups",
    ):
        (drive_root / rel).mkdir(parents=True, exist_ok=True)


def _copy_outputs_to_input(drive_root: Path) -> None:
    """Keep a human-friendly input snapshot beside output/data."""
    src = drive_root / "output" / "data"
    dst = drive_root / "input"
    dst.mkdir(parents=True, exist_ok=True)
    for name in (
        "Places.csv",
        "rating_matrix_foody.npz",
        "rating_matrix_foody_users.csv",
        "rating_matrix_foody_items.csv",
        "activity_log_matrix.npz",
        "activity_log_users.csv",
        "activity_log_items.csv",
        "activity_log_user_confidence.csv",
        "snapshot.json",
    ):
        p = src / name
        if p.exists():
            shutil.copy2(p, dst / name)


def _log_drive_summary(drive_root: Path) -> None:
    manifest = drive_root / "output" / "recommender_artifacts" / "serve_manifest.json"
    snapshot = drive_root / "output" / "data" / "snapshot.json"
    tourist_map = drive_root / "state" / "tourist_user_map.csv"

    print("\n[colab] Drive root:", drive_root)
    print("[colab] tourist_user_map:", tourist_map, "exists=", tourist_map.exists())
    if snapshot.exists():
        print("[colab] snapshot:")
        print(snapshot.read_text(encoding="utf-8")[:1000])
    if manifest.exists():
        data = json.loads(manifest.read_text(encoding="utf-8"))
        print("[colab] metrics:", data.get("metrics"))
        print("[colab] trained_at:", data.get("trained_at"))


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--force", action="store_true")
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--grid-search", action="store_true")
    parser.add_argument(
        "--drive-root",
        default=os.environ.get("COLAB_RETRAIN_DRIVE_ROOT", "/content/drive/MyDrive/GP-Retrain"),
        help="Google Drive folder mounted in Colab.",
    )
    args = parser.parse_args()

    drive_root = Path(args.drive_root).expanduser().resolve()
    if not drive_root.exists():
        raise SystemExit(
            f"Drive root does not exist: {drive_root}\n"
            "Mount Google Drive and add the target folder as MyDrive/GP-Retrain first."
        )

    _ensure_drive_layout(drive_root)
    _patch_paths(drive_root)

    # Import after patching pipeline_config paths.
    import retrain_pipeline

    argv = ["retrain_pipeline.py"]
    if args.force:
        argv.append("--force")
    if args.dry_run:
        argv.append("--dry-run")
    if args.grid_search:
        argv.append("--grid-search")

    old_argv = sys.argv
    try:
        sys.argv = argv
        print(f"[colab] Start at {datetime.now().isoformat(timespec='seconds')}")
        print(f"[colab] Using Drive root: {drive_root}")
        retrain_pipeline.main()
    finally:
        sys.argv = old_argv

    _copy_outputs_to_input(drive_root)
    _log_drive_summary(drive_root)


if __name__ == "__main__":
    try:
        sys.stdout.reconfigure(encoding="utf-8")
    except Exception:
        pass
    main()
