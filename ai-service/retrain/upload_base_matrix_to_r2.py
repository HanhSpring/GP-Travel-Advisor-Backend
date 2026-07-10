"""One-time uploader: Google Drive (Colab mounted path) -> Cloudflare R2.

Example on Colab after drive.mount('/content/drive'):
  python retrain/upload_base_matrix_to_r2.py \
    --source-dir "/content/drive/MyDrive/Recommender System"
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

from pipeline_config import load_env
from r2_base_matrix import upload_base_matrix


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--source-dir",
        required=True,
        help="Google Drive directory containing the three rating matrix files",
    )
    args = parser.parse_args()
    upload_base_matrix(load_env(), Path(args.source_dir).expanduser().resolve())
    print("[base-r2] ✅ Upload base training data hoàn tất")


if __name__ == "__main__":
    try:
        sys.stdout.reconfigure(encoding="utf-8")
    except Exception:
        pass
    main()
