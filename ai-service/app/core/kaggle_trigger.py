"""Trigger training tren Kaggle -- thay the cho viec goi Modal Web Endpoint. Render script
entrypoint (kaggle_training/kernel_entrypoint_template.py) voi tham so run cu the, ghi ra thu muc
tam kem kernel-metadata.json, roi push len Kaggle qua CLI `kaggle kernels push`.

Da tu tay verify cu phap kernel-metadata.json / lenh CLI 2026-07-12 (xem muc 10 cua
docs/trigger/09-migrate-modal-to-kaggle.md) -- push kernel test that qua GPU, internet, secrets
deu hoat dong dung. Auth CLI dung cap KAGGLE_USERNAME/KAGGLE_KEY (khong dung duoc token don
KAGGLE_API_TOKEN moi cua Kaggle -- package kaggle 1.7.4.5 chua ho tro, xem muc 3 cua doc tren).
"""
from __future__ import annotations

import json
import subprocess
import sys
import tempfile
from pathlib import Path

from app.core.config import settings

_TEMPLATE_PATH = Path(__file__).resolve().parents[2] / "kaggle_training" / "kernel_entrypoint_template.py"


def _render_value(value) -> str:
    """Chuyen 1 gia tri Python thanh literal de chen thang vao source code script."""
    if value is None:
        return "None"
    if isinstance(value, bool):
        return "True" if value else "False"
    return repr(value)  # str -> "'...'" co quote san


def push_training_kernel(
    run_id: str,
    dataset_r2_prefix: str,
    warm_start_weights_r2_key: str | None,
    warm_start_vocab_r2_key: str | None,
    include_yelp: bool | None,
    is_demo_mode: bool,
) -> dict:
    template = _TEMPLATE_PATH.read_text(encoding="utf-8")
    rendered = (
        template
        .replace("{{KAGGLE_DATASET_SLUG}}", settings.kaggle_dataset_slug)
        .replace('"{{RUN_ID}}"', repr(run_id))
        .replace('"{{DATASET_R2_PREFIX}}"', repr(dataset_r2_prefix))
        .replace("{{WARM_START_WEIGHTS_R2_KEY}}", _render_value(warm_start_weights_r2_key))
        .replace("{{WARM_START_VOCAB_R2_KEY}}", _render_value(warm_start_vocab_r2_key))
        .replace("{{INCLUDE_YELP}}", _render_value(include_yelp))
        .replace("{{IS_DEMO_MODE}}", _render_value(is_demo_mode))
    )

    with tempfile.TemporaryDirectory() as tmp:
        tmp_path = Path(tmp)
        script_path = tmp_path / "kernel.py"
        script_path.write_text(rendered, encoding="utf-8")

        metadata = {
            "id": f"{settings.kaggle_username}/{settings.kaggle_kernel_slug}",
            "title": settings.kaggle_kernel_slug,
            "code_file": "kernel.py",
            "language": "python",
            "kernel_type": "script",
            "is_private": True,
            "enable_gpu": True,
            "enable_internet": True,
            "dataset_sources": [f"{settings.kaggle_username}/{settings.kaggle_dataset_slug}"],
        }
        (tmp_path / "kernel-metadata.json").write_text(json.dumps(metadata, indent=2), encoding="utf-8")

        # Dung CLI (khong dung KaggleApi Python truc tiep) -- da tu tay verify cu phap nay hoat
        # dong dung (mo ta o docstring dau file). Auth CLI doc KAGGLE_USERNAME/KAGGLE_KEY tu
        # os.environ, da co san nho app/core/config.py::load_dotenv() nap tu .env luc khoi dong.
        # Goi qua `python -m kaggle.cli` (KHONG goi thang lenh "kaggle") -- da tu tay verify
        # 2026-07-12: lenh "kaggle" phu thuoc PATH co trong dung Scripts/ cua venv hay khong (co
        # the khong dung neu venv chua duoc activate luc ai-service khoi dong), trong khi
        # sys.executable + "-m kaggle.cli" luon dung dung interpreter/package dang chay ai-service.
        result = subprocess.run(
            [sys.executable, "-m", "kaggle.cli", "kernels", "push", "-p", str(tmp_path)],
            capture_output=True, text=True, timeout=120,
        )
        if result.returncode != 0:
            raise RuntimeError(f"kaggle kernels push failed: {result.stderr}")

    kernel_ref = f"{settings.kaggle_username}/{settings.kaggle_kernel_slug}"
    return {"status": "queued", "kaggle_kernel_ref": kernel_ref}
