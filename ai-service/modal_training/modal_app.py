"""Modal App -- 2 function (web endpoint nhe + GPU training job that), theo dung mau da xac minh
cu phap/gia hien hanh cua Modal (thang 7/2026) trong docs/trigger/06-modal-primary-plan.md muc
3.2. CANH BAO trong docs: Modal doi API kha nhanh -- doi chieu lai modal.com/docs truoc khi deploy
neu file nay da cu vai thang.

Deploy: modal deploy modal_training/modal_app.py
Can tao truoc 2 Modal Secret (mot lan, xem docs/trigger/06-modal-primary-plan.md muc 2):
    modal secret create r2-credentials R2_ENDPOINT_URL=... R2_ACCESS_KEY_ID=... \
        R2_SECRET_ACCESS_KEY=... R2_BUCKET_NAME=ai-artifacts
    modal secret create training-callback-secret \
        TRAINING_CALLBACK_SECRET=<phai giong het gia tri o api-service .env> \
        MODAL_TRIGGER_SECRET=<chuoi rieng, chi ai-service cua ban biet> \
        API_SERVICE_URL=<URL cong khai cua NestJS api-service>
"""
from pathlib import Path

import modal

app = modal.App("gp-travel-two-tower-training")

# Thu muc THAT chua modal_app.py (khong dung "." -- "." phu thuoc cwd luc chay `modal deploy`,
# tung gay loi: deploy tu thu muc ai-service/ khien "." = ca ai-service/ thay vi chi rieng
# modal_training/, lam /root/modal_training tren Modal khong phai package Python hop le nua
# -> ImportError: cannot import name 'data_io' from 'modal_training' (unknown location)).
_THIS_DIR = Path(__file__).resolve().parent

train_image = (
    modal.Image.debian_slim(python_version="3.11")
    .pip_install(
        "tensorflow[and-cuda]==2.16.1",
        "tf-keras",  # shim Keras 2 -- TF 2.16 mac dinh Keras 3, nhung tensorflow-recommenders can Keras 2
        "tensorflow-recommenders",
        "boto3",
        "pandas",
        "numpy<2.0",  # TF 2.16 build cho NumPy 1.x -- NumPy 2.x moi hon se gay loi ABI/crash
        "httpx",
        "fastapi[standard]",
    )
    # Bat buoc dat TRUOC khi tensorflow/tensorflow_recommenders duoc import trong container --
    # thieu bien nay se crash ImportError "requires tf.keras to be Keras version 2 but got 3".
    .env({"TF_USE_LEGACY_KERAS": "1"})
    # Dam bao ca package (etl.py, model.py, warm_start.py, evaluate.py, pipeline.py, data_io.py,
    # two_tower_train.py, config.py) duoc dong goi vao image, khong chi mot minh modal_app.py.
    .add_local_dir(_THIS_DIR, remote_path="/root/modal_training")
)

r2_secret = modal.Secret.from_name("r2-credentials")
callback_secret = modal.Secret.from_name("training-callback-secret")


@app.function(
    image=train_image,
    gpu="T4",              # du cho batch=2048, dim=256 -- xem docs muc 6 vi sao chon T4
    timeout=3 * 60 * 60,   # cap cung 3 gio -- cost safety net, tranh job "treo" ton tien
    secrets=[r2_secret, callback_secret],
)
def train_two_tower(
    run_id: str,
    dataset_r2_prefix: str,
    warm_start_weights_r2_key: str | None = None,
    warm_start_vocab_r2_key: str | None = None,
    include_yelp: bool | None = None,
    is_demo_mode: bool = False,
):
    import os
    from pathlib import Path

    import sys
    sys.path.insert(0, "/root")
    from modal_training import data_io
    from modal_training.two_tower_train import run_training

    work_dir = Path("/tmp/two_tower_run") / run_id
    dataset_dir = work_dir / "dataset"
    checkpoint_dir = work_dir / "warm_start"
    output_dir = work_dir / "output"

    data_io.download_dataset(dataset_r2_prefix, dataset_dir)

    warm_start_dir = data_io.download_previous_checkpoint(
        warm_start_weights_r2_key, warm_start_vocab_r2_key, checkpoint_dir
    )

    # Che do demo: ep 1 epoch -- dung de TEST luong end-to-end (Modal -> R2 -> webhook -> DB ->
    # hot-reload) MA KHONG ton GPU-gio cho 1 lan train day du. Xem docs muc 6.3.
    result = run_training(
        dataset_dir=dataset_dir,
        output_dir=output_dir,
        run_id=run_id,
        warm_start_dir=warm_start_dir,
        include_yelp=include_yelp,
        is_demo_mode=is_demo_mode,
    )

    r2_keys = data_io.upload_results(output_dir, run_id)

    api_service_url = os.environ["API_SERVICE_URL"]
    data_io.post_training_callback(
        f"{api_service_url}/admin/algorithm-training/webhook/training-callback",
        os.environ["TRAINING_CALLBACK_SECRET"],
        {
            "run_id": run_id,
            "algorithm": "two-tower",
            "status": "completed",
            "weights_r2_key": r2_keys["weights_r2_key"],
            "vocab_r2_key": r2_keys["vocab_r2_key"],
            "metrics": result["metrics"],
            "epochs_run": result["epochs_run"],
            "is_finetune": result["is_finetune"],
        },
    )
    return {"status": "completed", "run_id": run_id}


# Web endpoint NHE (khong can GPU) -- chi nhan request va spawn job GPU that, tra loi ngay lap tuc
@app.function(image=train_image, secrets=[callback_secret])
@modal.fastapi_endpoint(method="POST")
def trigger_training(payload: dict):
    import os

    # Xac thuc: chi backend cua ban moi goi duoc endpoint nay (tranh nguoi la trigger GPU ton tien)
    if payload.get("secret") != os.environ["MODAL_TRIGGER_SECRET"]:
        return {"error": "unauthorized"}, 401

    if not payload.get("run_id") or not payload.get("dataset_r2_prefix"):
        return {"error": "thieu run_id hoac dataset_r2_prefix"}, 400

    call = train_two_tower.spawn(
        run_id=payload["run_id"],
        dataset_r2_prefix=payload["dataset_r2_prefix"],
        warm_start_weights_r2_key=payload.get("warm_start_weights_r2_key"),
        warm_start_vocab_r2_key=payload.get("warm_start_vocab_r2_key"),
        include_yelp=payload.get("include_yelp"),
        is_demo_mode=payload.get("is_demo_mode", False),
    )
    return {"status": "queued", "modal_call_id": call.object_id}
