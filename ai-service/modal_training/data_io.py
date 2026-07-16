"""R2 download/upload helpers cho Modal training job -- cung pattern boto3 voi
app/core/r2_downloader.py / scripts/upload_to_r2.py (khong viet client moi).

Thiet ke: NestJS (khong phai Modal) la noi biet model_versions dang 'active' -- nen NestJS tu
tra cuu weights_r2_key/vocab_r2_key cua version active TRUOC KHI goi Modal, roi truyen thang qua
payload (xem modal_app.py::TrainRequest.warm_start_weights_r2_key). Modal khong can goi nguoc lai
API NestJS chi de tra cuu -- giam 1 tang phu thuoc mang.
"""
from __future__ import annotations

import os
from pathlib import Path

import boto3
import httpx
from botocore.config import Config as BotoConfig

R2_ENDPOINT_URL       = os.environ.get('R2_ENDPOINT_URL', '')
R2_ACCESS_KEY_ID      = os.environ.get('R2_ACCESS_KEY_ID', '')
R2_SECRET_ACCESS_KEY  = os.environ.get('R2_SECRET_ACCESS_KEY', '')
R2_BUCKET_NAME        = os.environ.get('R2_BUCKET_NAME', 'ai-artifacts')

# Prefix co dinh chua ban tinh (Yelp+Foody) -- upload 1 lan thu cong tu file dang co tren Google
# Drive (/content/drive/MyDrive/train2/*), xem README trien khai o cuoi file nay.
STATIC_CORPUS_R2_PREFIX = 'training-datasets/two_tower/static'


def _client():
    if not all([R2_ENDPOINT_URL, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET_NAME]):
        raise RuntimeError('Thieu bien moi truong R2_* -- xem Modal Secret "r2-credentials"')
    return boto3.client(
        's3',
        endpoint_url=R2_ENDPOINT_URL,
        aws_access_key_id=R2_ACCESS_KEY_ID,
        aws_secret_access_key=R2_SECRET_ACCESS_KEY,
        config=BotoConfig(signature_version='s3v4'),
        region_name='auto',
    )


def _download_prefix(prefix: str, local_dir: Path) -> int:
    client = _client()
    local_dir.mkdir(parents=True, exist_ok=True)
    prefix = prefix.rstrip('/') + '/'
    n = 0
    paginator = client.get_paginator('list_objects_v2')
    for page in paginator.paginate(Bucket=R2_BUCKET_NAME, Prefix=prefix):
        for obj in page.get('Contents', []):
            key = obj['Key']
            rel = key[len(prefix):]
            if not rel:
                continue
            local_path = local_dir / rel
            local_path.parent.mkdir(parents=True, exist_ok=True)
            if local_path.exists() and local_path.stat().st_size == obj['Size']:
                continue
            print(f'  ⬇ {key} -> {local_path}')
            client.download_file(R2_BUCKET_NAME, key, str(local_path))
            n += 1
    return n


def download_dataset(run_r2_prefix: str, local_dir: Path) -> Path:
    """Tai dataset da export (Phase 0) + ban tinh Yelp/Foody vao CHUNG 1 thu muc (dung cach
    notebook doc DATA_DIR -- ca 2 nguon nam chung 1 cho)."""
    print(f'Downloading static corpus tu r2://{R2_BUCKET_NAME}/{STATIC_CORPUS_R2_PREFIX} ...')
    _download_prefix(STATIC_CORPUS_R2_PREFIX, local_dir)
    print(f'Downloading dataset run tu r2://{R2_BUCKET_NAME}/{run_r2_prefix} ...')
    _download_prefix(run_r2_prefix, local_dir)
    return local_dir


def download_previous_checkpoint(weights_r2_key: str | None, vocab_r2_key: str | None, local_dir: Path) -> str | None:
    """Tai checkpoint cua version dang active (do NestJS truyen R2 key vao) ve local_dir de
    warm-start. Tra ve str(local_dir) neu tai thanh cong, None neu khong co checkpoint (train tu dau)."""
    if not weights_r2_key or not vocab_r2_key:
        return None
    client = _client()
    local_dir.mkdir(parents=True, exist_ok=True)
    vocab_path = local_dir / 'vocab.pkl'
    weights_path = local_dir / 'best_model.weights.h5'
    print(f'⬇ [warm-start] {vocab_r2_key} -> {vocab_path}')
    client.download_file(R2_BUCKET_NAME, vocab_r2_key, str(vocab_path))
    print(f'⬇ [warm-start] {weights_r2_key} -> {weights_path}')
    client.download_file(R2_BUCKET_NAME, weights_r2_key, str(weights_path))
    return str(local_dir)


def upload_results(local_dir: Path, run_id: str) -> dict:
    """Upload vocab.pkl + best_model.weights.h5 len two-tower/versions/{run_id}/ -- KHONG ghi de
    two-tower/vocab.pkl hien tai (do la ban dang active, chi ghi de luc promote qua
    ai-service /reload). Tra ve {weights_r2_key, vocab_r2_key}."""
    client = _client()
    prefix = f'two-tower/versions/{run_id}'
    vocab_key = f'{prefix}/vocab.pkl'
    weights_key = f'{prefix}/best_model.weights.h5'

    client.upload_file(str(local_dir / 'vocab.pkl'), R2_BUCKET_NAME, vocab_key)
    client.upload_file(str(local_dir / 'best_model.weights.h5'), R2_BUCKET_NAME, weights_key)
    print(f'✅ Uploaded r2://{R2_BUCKET_NAME}/{vocab_key}')
    print(f'✅ Uploaded r2://{R2_BUCKET_NAME}/{weights_key}')
    return {'weights_r2_key': weights_key, 'vocab_r2_key': vocab_key}


def post_training_callback(callback_url: str, secret: str, payload: dict) -> None:
    """Goi POST /admin/algorithm-training/webhook/training-callback (NestJS) khi train xong.
    Xac thuc bang header rieng (KHONG phai JWT admin -- Modal khong dang nhap duoc)."""
    headers = {'X-Training-Callback-Secret': secret, 'Content-Type': 'application/json'}
    resp = httpx.post(callback_url, json=payload, headers=headers, timeout=30.0)
    resp.raise_for_status()
    print(f'✅ Da goi training-callback: {callback_url} -> {resp.status_code}')
