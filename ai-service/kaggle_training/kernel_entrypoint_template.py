"""Template entrypoint chay tren Kaggle kernel. File nay KHONG chay truc tiep -- ai-service
render (string templating) thanh 1 file cu the truoc moi lan `kaggle kernels push`, chen gia tri
that vao cac hang so RUN_ID/DATASET_R2_PREFIX/... o duoi (xem app/core/kaggle_trigger.py).
Placeholder dang {{TEN_BIEN}} de tranh trung voi f-string/format cua Python that trong than script.
"""
import os

# BAT BUOC dat TRUOC khi tensorflow duoc import (truc tiep hoac gian tiep qua
# tensorflow_recommenders/modal_training.model) -- neu khong se crash ImportError "requires
# tf.keras to be Keras version 2 but got 3". Da tu tay verify 2026-07-12: image Kaggle mac dinh co
# san TF 2.20.0 + tf_keras 2.20.0 tuong thich nhau, KHONG can downgrade tensorflow nhu Modal
# (modal_app.py pin tensorflow==2.16.1) -- chi can bien nay la du de tf.keras tro dung ve shim
# Keras 2 (tf_keras.api._v2.keras).
os.environ["TF_USE_LEGACY_KERAS"] = "1"

import subprocess
import sys

# tensorflow_recommenders KHONG co san tren image Kaggle mac dinh (khac Modal, image tuy chinh da
# pip_install san trong modal_app.py) -- da tu tay verify 2026-07-12: phai tu cai luc chay kernel.
# --no-deps de tranh pip co gang doi phien ban tensorflow/keras dang co san cua Kaggle (co the pha
# vo tuong thich GPU/CUDA da duoc Kaggle build san cho dung driver cua ho).
subprocess.run(
    [sys.executable, "-m", "pip", "install", "--no-deps", "-q", "tensorflow-recommenders"],
    check=True,
)

# Kaggle Secrets -> bien moi truong ma data_io.py dang doc (R2_ENDPOINT_URL, R2_ACCESS_KEY_ID,
# R2_SECRET_ACCESS_KEY, R2_BUCKET_NAME, TRAINING_CALLBACK_SECRET, API_SERVICE_URL). Da tu tay
# verify cu phap nay 2026-07-12 (xem docs/trigger/09-migrate-modal-to-kaggle.md muc 10).
from kaggle_secrets import UserSecretsClient

_secrets = UserSecretsClient()
for _key in [
    "R2_ENDPOINT_URL", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY", "R2_BUCKET_NAME",
    "TRAINING_CALLBACK_SECRET", "API_SERVICE_URL",
]:
    os.environ[_key] = _secrets.get_secret(_key)

# Dataset chua modal_training/*.py (etl.py, model.py, ... - xem muc 4.1) duoc Kaggle mount o day.
# Da tu tay verify 2026-07-12: duong dan mount THAY DOI tuy cach dataset duoc gan vao kernel --
# gan thuan qua kernel-metadata.json (dataset_sources) cho ra "/kaggle/input/<slug>" truc tiep,
# nhung neu kernel dung tung duoc mo qua UI editor va dataset duoc them/xac nhan lai qua "+ Add
# Input" thi Kaggle mount vao "/kaggle/input/datasets/<owner>/<slug>" (them 2 lop). KHONG co tai
# lieu chinh thuc mo ta khi nao dung dang nao -- tu do bo ca 2 kha nang thay vi doan cung 1 duong.
_DATASET_SLUG = "{{KAGGLE_DATASET_SLUG}}"
_candidate_paths = [
    f"/kaggle/input/{_DATASET_SLUG}",
]
_input_root = "/kaggle/input/datasets"
if os.path.isdir(_input_root):
    for _owner in os.listdir(_input_root):
        _candidate_paths.append(os.path.join(_input_root, _owner, _DATASET_SLUG))

_dataset_path = next((p for p in _candidate_paths if os.path.isdir(os.path.join(p, "modal_training"))), None)
if _dataset_path is None:
    raise RuntimeError(
        f"Khong tim thay modal_training/ trong bat ky duong dan nao: {_candidate_paths} "
        f"(/kaggle/input chua: {os.listdir('/kaggle/input') if os.path.isdir('/kaggle/input') else 'KHONG TON TAI'})"
    )
print(f"[kaggle_entrypoint] Dataset mount path: {_dataset_path}")
sys.path.insert(0, _dataset_path)

from modal_training import data_io                # noqa: E402
from modal_training.two_tower_train import run_training  # noqa: E402

from pathlib import Path

RUN_ID = "{{RUN_ID}}"
DATASET_R2_PREFIX = "{{DATASET_R2_PREFIX}}"
WARM_START_WEIGHTS_R2_KEY = {{WARM_START_WEIGHTS_R2_KEY}}   # None hoac "'...'" (chuoi da quote san)
WARM_START_VOCAB_R2_KEY = {{WARM_START_VOCAB_R2_KEY}}
INCLUDE_YELP = {{INCLUDE_YELP}}     # True / False / None
IS_DEMO_MODE = {{IS_DEMO_MODE}}     # True / False

work_dir = Path("/kaggle/working/two_tower_run") / RUN_ID
dataset_dir = work_dir / "dataset"
checkpoint_dir = work_dir / "warm_start"
output_dir = work_dir / "output"

_callback_url = f"{os.environ['API_SERVICE_URL']}/admin/algorithm-training/webhook/training-callback"

try:
    data_io.download_dataset(DATASET_R2_PREFIX, dataset_dir)

    warm_start_dir = data_io.download_previous_checkpoint(
        WARM_START_WEIGHTS_R2_KEY, WARM_START_VOCAB_R2_KEY, checkpoint_dir
    )

    result = run_training(
        dataset_dir=dataset_dir,
        output_dir=output_dir,
        run_id=RUN_ID,
        warm_start_dir=warm_start_dir,
        include_yelp=INCLUDE_YELP,
        is_demo_mode=IS_DEMO_MODE,
    )

    r2_keys = data_io.upload_results(output_dir, RUN_ID)

    data_io.post_training_callback(
        _callback_url,
        os.environ["TRAINING_CALLBACK_SECRET"],
        {
            "run_id": RUN_ID,
            "algorithm": "two-tower",
            "status": "completed",
            "weights_r2_key": r2_keys["weights_r2_key"],
            "vocab_r2_key": r2_keys["vocab_r2_key"],
            "metrics": result["metrics"],
            "epochs_run": result["epochs_run"],
            "is_finetune": result["is_finetune"],
        },
    )
    print(f"[kaggle_entrypoint] Hoan tat run_id={RUN_ID}")
except Exception as exc:
    # Modal hien tai CHUA co try/except tuong tu quanh train_two_tower() -- day la cai thien them
    # (khong bat buoc de migrate), nhung can thiet o day vi Kaggle khong co polling/timeout tu
    # dong bao NestJS biet job that bai nhu Modal .spawn() call object. Neu post_training_callback
    # o nhanh "completed" da thanh cong roi moi loi (vd loi network luc goi lai) thi except nay
    # se co goi callback lan 2 voi status=failed -- webhook handler NestJS chi update dua tren
    # trang thai moi nhat nhan duoc, chap nhan duoc vi day la truong hop hiem (loi ngay sau khi
    # da thanh cong).
    try:
        data_io.post_training_callback(
            _callback_url,
            os.environ["TRAINING_CALLBACK_SECRET"],
            {
                "run_id": RUN_ID,
                "algorithm": "two-tower",
                "status": "failed",
                "error_message": str(exc),
            },
        )
    except Exception as callback_exc:
        print(f"[kaggle_entrypoint] Khong the goi callback 'failed': {callback_exc}")
    raise
