"""Config -- mirror 1:1 cua Cell 5 (class Config) trong
train/two_tower_recommender_15_finetune4.ipynb. KHONG doi gia tri o day ma khong doi tuong ung
trong notebook (va nguoc lai) -- 2 noi phai luon dong bo, notebook la nguon cua "hanh vi dung"."""
from __future__ import annotations

import tensorflow as tf


class Config:
    # Embedding dims
    USER_EMB_DIM        = 64
    CITY_EMB_DIM        = 16
    BIZ_EMB_DIM         = 64
    TYPE_EMB_DIM        = 16
    TRAVEL_TYPE_EMB_DIM = 16
    OUTPUT_DIM          = 256

    # Data
    BGE_DIM             = 1024
    MAX_HISTORY_LEN     = 30
    MAX_TRAIN_SAMPLES   = 100
    USER_MIN_INTERACTIONS = 2

    # Training (dung khi WARM_START_DIR rong -- train tu dau)
    BATCH_SIZE          = 2048
    EPOCHS               = 50
    FINAL_EPOCHS         = EPOCHS
    LEARNING_RATE        = 1e-3
    WEIGHT_DECAY         = 1e-4
    DROPOUT_RATE         = 0.2

    # Fine-tune (dung khi WARM_START_DIR khac rong) -- xem Cell 3c/4a/4b trong notebook
    FINETUNE_EPOCHS         = 30
    FINETUNE_LEARNING_RATE  = 1e-4
    FINETUNE_ES_PATIENCE    = 5
    FINETUNE_RLROP_PATIENCE = 2
    # Linear LR warmup cho N step dau cua epoch 1 (chi ap dung khi fine-tune, xem Cell 4a/
    # LinearWarmupLR trong two_tower_train.py).
    FINETUNE_WARMUP_STEPS   = 30

    TEMPERATURE          = 0.05

    # Weighting
    CATEGORY_WEIGHT_MODE = 'sqrt_clipped'
    CATEGORY_WEIGHT_CLIP = (0.2, 3.0)

    # Query history
    USE_RECENCY_WEIGHTED_HISTORY = True
    USE_QUERY_ATTENTION_HISTORY  = True
    HISTORY_ENCODER              = 'query_attention'

    # Eval
    TOP_K_LIST = [10, 50, 100]


EMB_REG = tf.keras.regularizers.l2(1e-5)
