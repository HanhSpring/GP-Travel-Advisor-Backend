"""Orchestrator -- port co hoc tu Cell "3b" (khoi tao model), "3c" (warm-start), "4a" (callbacks),
"4b" (chay training) va "5c" (eval) cua train/two_tower_recommender_15_finetune.ipynb.

Day la ham duy nhat modal_app.py can goi -- toan bo logic ETL/model/warm-start/eval nam trong cac
module con cung thu muc (etl.py, pipeline.py, model.py, warm_start.py, evaluate.py), giu dung
kien truc/hyperparameter da sua trong phien lam viec finetune (INCLUDE_YELP toggle,
FINETUNE_EPOCHS/LR/patience rieng voi train-tu-dau).
"""
from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import numpy as np
import tensorflow as tf

from . import evaluate, warm_start
from .config import Config
from .etl import run_etl
from .model import TwoTowerRetrievalModel, build_towers
from .pipeline import build_datasets, build_vocab


# v15-finetune: Linear LR warmup cho N step DAU TIEN cua epoch 1 (chi khi fine-tune) -- mirror
# 1:1 Cell 4a. AdamW moment state (m, v) luon bi reset ve 0 khi warm-start, nen ngay ca voi
# FINETUNE_LEARNING_RATE da giam 10x so voi train-tu-dau, vai step dau van co the tao buoc cap
# nhat du lon de "xo lech" embedding da hoi tu tot tu pretrain truoc khi optimizer kip on dinh
# moment. Warmup ramp LR tu 0 -> target trong Config.FINETUNE_WARMUP_STEPS step dau.
class LinearWarmupLR(tf.keras.callbacks.Callback):
    def __init__(self, target_lr, warmup_steps):
        super().__init__()
        self.target_lr = target_lr
        self.warmup_steps = max(int(warmup_steps), 1)
        self._step = 0

    def on_train_batch_begin(self, batch, logs=None):
        if self._step >= self.warmup_steps:
            return
        self._step += 1
        new_lr = self.target_lr * (self._step / self.warmup_steps)
        tf.keras.backend.set_value(self.model.optimizer.learning_rate, new_lr)
        if self._step == self.warmup_steps:
            print(f'[Warmup] Hoan tat {self.warmup_steps} step dau -- LR = {self.target_lr:.2e}')


def run_training(
    dataset_dir: str | Path,
    output_dir: str | Path,
    run_id: str,
    warm_start_dir: str | None = None,
    include_yelp: bool | None = None,
    is_demo_mode: bool = False,
) -> dict[str, Any]:
    dataset_dir = Path(dataset_dir)
    output_dir = Path(output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)

    is_finetune = bool(warm_start_dir)
    if include_yelp is None:
        # Mac dinh dung notebook: finetune (da warm-start) khong can "replay" lai Yelp.
        include_yelp = not is_finetune
    print(f'[run_training] run_id={run_id} is_finetune={is_finetune} include_yelp={include_yelp} '
          f'is_demo_mode={is_demo_mode}')

    # --- Section 1: ETL ---
    df_train, df_val, df_test, df_candidates = run_etl(dataset_dir, include_yelp)

    # --- Section 2: Vocab + tf.data ---
    vocab = build_vocab(df_train, df_candidates, output_dir / 'vocab.pkl')
    ds_train, ds_val, ds_test, ds_candidates = build_datasets(df_train, df_val, df_test, df_candidates)

    # --- Section 3: Kien truc + khoi tao model (Cell 3b) ---
    query_tower, candidate_tower = build_towers(vocab)
    candidate_tower.adapt_numerical(df_candidates)

    biz_log_freq = np.array(vocab['biz_log_freq'], dtype=np.float32)
    model = TwoTowerRetrievalModel(
        query_tower, candidate_tower, ds_candidates, biz_log_freq, vocab, Config.TEMPERATURE)
    model.compile(optimizer=tf.keras.optimizers.AdamW(
        learning_rate=Config.LEARNING_RATE, weight_decay=Config.WEIGHT_DECAY))

    for batch in ds_train.take(1):
        _ = model.compute_loss(batch, training=False)

    q_params = query_tower.count_params()
    c_params = candidate_tower.count_params()
    print(f'QueryTower params: {q_params:,} | CandidateTower params: {c_params:,}')

    # --- Cell 3c: Warm-start (tuy chon) ---
    if is_finetune:
        warm_start.warm_start_from_checkpoint(warm_start_dir, query_tower, candidate_tower, vocab, ds_candidates)
        # AdamW moment state (m, v) luon khoi tao lai tu 0 du co warm-start hay khong -- neu giu
        # nguyen LEARNING_RATE=1e-3 (train-tu-dau) thi vai step dau se tao buoc cap nhat lon de
        # len embedding da hoi tu tot. Recompile voi LR nho hon rieng cho fine-tune.
        model.compile(optimizer=tf.keras.optimizers.AdamW(
            learning_rate=Config.FINETUNE_LEARNING_RATE, weight_decay=Config.WEIGHT_DECAY))
        print(f'[Fine-tune] Da recompile optimizer voi LR={Config.FINETUNE_LEARNING_RATE} '
              f'(thay vi {Config.LEARNING_RATE} dung khi train tu dau).')

    # --- Cell 4a: Callbacks ---
    checkpoint_path = str(output_dir / 'best_model.weights.h5')
    monitor_top100 = 'val_factorized_top_k/top_100_categorical_accuracy'
    monitor_loss   = 'val_total_loss'

    es_patience     = Config.FINETUNE_ES_PATIENCE    if is_finetune else 7
    rlrop_patience  = Config.FINETUNE_RLROP_PATIENCE if is_finetune else 3

    callbacks = [
        tf.keras.callbacks.ModelCheckpoint(
            filepath=checkpoint_path, monitor=monitor_top100,
            save_best_only=True, save_weights_only=True, mode='max', verbose=1),
        tf.keras.callbacks.ReduceLROnPlateau(
            monitor=monitor_loss, factor=0.5, patience=rlrop_patience, min_lr=1e-6, mode='min', verbose=1),
        tf.keras.callbacks.EarlyStopping(
            monitor=monitor_top100, patience=es_patience, restore_best_weights=True, mode='max', verbose=1),
    ]
    if is_finetune:
        callbacks.append(LinearWarmupLR(Config.FINETUNE_LEARNING_RATE, Config.FINETUNE_WARMUP_STEPS))
        print(f'LR warmup: {Config.FINETUNE_WARMUP_STEPS} step dau -> target LR={Config.FINETUNE_LEARNING_RATE:.2e}')
    print(f'Fine-tune mode: {is_finetune} (ES patience={es_patience}, ReduceLROnPlateau patience={rlrop_patience})')

    # --- Cell 4b: Training ---
    # is_demo_mode: chi de TEST luong end-to-end (Modal -> R2 -> webhook -> DB -> hot-reload)
    # that re/nhanh, KHONG dung cho bao cao -- ep 1 epoch bat ke dang finetune hay train-tu-dau.
    if is_demo_mode:
        train_epochs = 1
    else:
        train_epochs = Config.FINETUNE_EPOCHS if is_finetune else Config.FINAL_EPOCHS
    steps_per_epoch  = max(1, len(df_train) // Config.BATCH_SIZE)
    validation_steps = max(1, len(df_val) // Config.BATCH_SIZE)

    history = model.fit(
        ds_train, validation_data=ds_val, epochs=train_epochs,
        steps_per_epoch=steps_per_epoch, validation_steps=validation_steps,
        callbacks=callbacks,
    )

    model.save_weights(str(output_dir / 'final_model.weights.h5'))

    best_top100 = max(history.history.get(monitor_top100, [0]))
    best_loss   = min(history.history.get(monitor_loss, [999]))
    epochs_run  = len(history.history.get(monitor_loss, []))
    print(f'Best val Top-100 accuracy: {best_top100:.4f} | Best val loss: {best_loss:.4f} | Epochs run: {epochs_run}')

    # --- Cell 5c: Eval (reload best_model.weights.h5 -- dam bao dung ban da checkpoint) ---
    model.load_weights(checkpoint_path)
    df_metrics, _acc = evaluate.compute_user_level_metrics(
        df_test, query_tower, candidate_tower, Config.TOP_K_LIST, df_candidates)
    df_metrics.to_csv(str(output_dir / 'eval_results.csv'), index=False)
    metrics_summary = evaluate.metrics_summary_for_callback(df_metrics)
    metrics_summary['best_top100_val'] = float(best_top100)
    metrics_summary['best_loss_val'] = float(best_loss)

    with open(output_dir / 'training_summary.json', 'w', encoding='utf-8') as f:
        json.dump({
            'run_id': run_id, 'is_finetune': is_finetune, 'include_yelp': include_yelp,
            'epochs_run': epochs_run, 'train_epochs_budget': train_epochs,
            'n_train': len(df_train), 'n_val': len(df_val), 'n_test': len(df_test),
            'metrics': metrics_summary,
        }, f, ensure_ascii=False, indent=2)

    return {
        'run_id': run_id,
        'vocab_path': str(output_dir / 'vocab.pkl'),
        'weights_path': checkpoint_path,
        'metrics': metrics_summary,
        'epochs_run': epochs_run,
        'is_finetune': is_finetune,
        'include_yelp': include_yelp,
        'n_train': len(df_train),
        'n_val': len(df_val),
        'n_test': len(df_test),
    }
