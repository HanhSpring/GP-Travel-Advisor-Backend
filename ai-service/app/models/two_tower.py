"""
Two-Tower Retrieval Model — TensorFlow/TFRS implementation.

Extracted from two_tower_recommender_10.ipynb.
Architecture:
  QueryTower     — user side: user_id + city + trip_intent + intent_vibe + history sequences
  CandidateTower — item side: business_id + city + category + vibes + travel_type +
                              stars + review_count + BGE-m3 semantic embedding (1024d)
  Output dim     — 256 (L2-normalized dot-product space)
"""

from __future__ import annotations

import pickle
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import numpy as np
import tensorflow as tf


# ---------------------------------------------------------------------------
# Config (mirrors notebook Cell 4)
# ---------------------------------------------------------------------------

class ModelConfig:
    USER_EMB_DIM        = 64
    CITY_EMB_DIM        = 16
    BIZ_EMB_DIM         = 64
    TYPE_EMB_DIM        = 16
    TRAVEL_TYPE_EMB_DIM = 16
    OUTPUT_DIM          = 256
    BGE_DIM             = 1024
    MAX_HISTORY_LEN     = 30
    DROPOUT_RATE        = 0.2

    EMB     = OUTPUT_DIM
    EMB_REG = tf.keras.regularizers.l2(1e-5)


# ---------------------------------------------------------------------------
# Shared embedding layers (parameter-tied between QueryTower & CandidateTower)
# ---------------------------------------------------------------------------

@dataclass
class SharedLayers:
    city_lookup:   tf.keras.layers.StringLookup
    city_emb:      tf.keras.layers.Embedding
    biz_lookup:    tf.keras.layers.StringLookup
    biz_emb:       tf.keras.layers.Embedding
    types_lookup:  tf.keras.layers.StringLookup
    types_emb:     tf.keras.layers.Embedding
    vibes_lookup:  tf.keras.layers.StringLookup
    vibes_emb:     tf.keras.layers.Embedding


def build_shared_layers(vocab: dict) -> SharedLayers:
    """Create shared embedding layers from vocabulary dict (vocab.pkl)."""
    city_lookup  = tf.keras.layers.StringLookup(vocabulary=vocab['city'],   mask_token='')
    city_emb     = tf.keras.layers.Embedding(len(vocab['city'])  + 2, ModelConfig.CITY_EMB_DIM)
    biz_lookup   = tf.keras.layers.StringLookup(vocabulary=vocab['business_id'], mask_token='')
    biz_emb      = tf.keras.layers.Embedding(
        len(vocab['business_id']) + 2, ModelConfig.BIZ_EMB_DIM,
        embeddings_regularizer=ModelConfig.EMB_REG)
    types_lookup = tf.keras.layers.StringLookup(vocabulary=vocab['types'],  mask_token='')
    types_emb    = tf.keras.layers.Embedding(len(vocab['types'])  + 2, ModelConfig.TYPE_EMB_DIM)
    vibes_lookup = tf.keras.layers.StringLookup(vocabulary=vocab['vibes'],  mask_token='')
    vibes_emb    = tf.keras.layers.Embedding(len(vocab['vibes'])  + 2, ModelConfig.TYPE_EMB_DIM)
    return SharedLayers(
        city_lookup, city_emb,
        biz_lookup,  biz_emb,
        types_lookup, types_emb,
        vibes_lookup, vibes_emb,
    )


# ---------------------------------------------------------------------------
# Layers
# ---------------------------------------------------------------------------

class SafeGlobalAveragePooling1D(tf.keras.layers.Layer):
    """Average pooling that respects padding masks."""

    def call(self, inputs, mask=None):
        if mask is not None:
            m = tf.cast(tf.expand_dims(mask, -1), inputs.dtype)
            return tf.math.divide_no_nan(
                tf.reduce_sum(inputs * m, axis=1),
                tf.reduce_sum(m, axis=1),
            )
        return tf.reduce_mean(inputs, axis=1)


# ---------------------------------------------------------------------------
# QueryTower
# ---------------------------------------------------------------------------

class QueryTower(tf.keras.Model):
    """
    User-side tower.

    Input keys (all tf.string unless noted):
      user_id              scalar
      current_city         scalar
      trip_intent          scalar
      intent_vibe          scalar
      history_business_id  (MAX_HISTORY_LEN,)
      history_types        (MAX_HISTORY_LEN,)
      history_vibes        (MAX_HISTORY_LEN,)

    Output: float32 (batch, OUTPUT_DIM) — L2-normalized
    """

    def __init__(self, vocab: dict, shared: SharedLayers):
        super().__init__()

        # User identity
        self.user_lookup = tf.keras.layers.StringLookup(
            vocabulary=vocab['user_id'], mask_token='')
        self.user_emb = tf.keras.layers.Embedding(
            len(vocab['user_id']) + 2, ModelConfig.USER_EMB_DIM,
            embeddings_regularizer=ModelConfig.EMB_REG)

        # Shared layers
        self.city_lookup  = shared.city_lookup
        self.city_emb     = shared.city_emb
        self.biz_lookup   = shared.biz_lookup
        self.biz_emb      = shared.biz_emb
        self.types_lookup = shared.types_lookup
        self.types_emb    = shared.types_emb
        self.vibes_lookup = shared.vibes_lookup
        self.vibes_emb    = shared.vibes_emb
        self.seq_pool     = SafeGlobalAveragePooling1D()

        # Trip intent (mirrors candidate travel_type — Dual Encoder Alignment)
        self.intent_lookup = tf.keras.layers.StringLookup(
            vocabulary=vocab['trip_intent'], mask_token='')
        self.intent_emb = tf.keras.layers.Embedding(
            len(vocab['trip_intent']) + 2, ModelConfig.TRAVEL_TYPE_EMB_DIM)
        self.vibe_lookup = tf.keras.layers.StringLookup(
            vocabulary=vocab['intent_vibe'], mask_token='')
        self.vibe_emb = tf.keras.layers.Embedding(
            len(vocab['intent_vibe']) + 2, 8)

        # MLP
        self.dense1 = tf.keras.layers.Dense(256, activation='relu')
        self.drop1  = tf.keras.layers.Dropout(ModelConfig.DROPOUT_RATE)
        self.dense2 = tf.keras.layers.Dense(128, activation='relu')
        self.drop2  = tf.keras.layers.Dropout(0.1)
        self.out    = tf.keras.layers.Dense(ModelConfig.EMB)

    def call(self, inputs, training=False):
        user_v   = self.user_emb(self.user_lookup(inputs['user_id']))
        city_v   = self.city_emb(self.city_lookup(inputs['current_city']))
        intent_v = self.intent_emb(self.intent_lookup(inputs['trip_intent']))
        vibe_v   = self.vibe_emb(self.vibe_lookup(inputs['intent_vibe']))

        hbiz_v  = self.seq_pool(self.biz_emb(self.biz_lookup(inputs['history_business_id'])))
        htype_v = self.seq_pool(self.types_emb(self.types_lookup(inputs['history_types'])))
        hvibe_v = self.seq_pool(self.vibes_emb(self.vibes_lookup(inputs['history_vibes'])))

        x = tf.concat([user_v, city_v, intent_v, vibe_v, hbiz_v, htype_v, hvibe_v], axis=-1)
        x = self.drop1(self.dense1(x), training=training)
        x = self.drop2(self.dense2(x), training=training)
        return tf.math.l2_normalize(self.out(x), axis=-1)


# ---------------------------------------------------------------------------
# CandidateTower  (3-Gate Fusion)
# ---------------------------------------------------------------------------

class CandidateTower(tf.keras.Model):
    """
    Item-side tower — 3-Gate Fusion:
      Gate 1 (Semantic):    BGE-m3 1024d frozen → Dense(256,relu) → Dense(128) → BN
      Gate 2 (Categorical): id + city + category + types + vibes + travel_type → Dense(128) → BN
      Gate 3 (Numerical):   [stars_biz, log1p(review_count)] → Normalization → Dense(32) → BN
      Fusion: concat → Dense(256,relu) → Dropout → Dense(256) → L2Norm

    Input keys:
      semantic_emb  float32 (BGE_DIM,)
      business_id   string
      city          string
      category      string
      travel_type   string
      types         (MAX_HISTORY_LEN,) string
      vibes         (MAX_HISTORY_LEN,) string
      stars_biz     float32
      review_count  float32

    Output: float32 (batch, OUTPUT_DIM) — L2-normalized
    """

    def __init__(self, vocab: dict, shared: SharedLayers):
        super().__init__()

        # Gate 1 — Semantic
        self.sem_dense1 = tf.keras.layers.Dense(256, activation='relu')
        self.sem_dense2 = tf.keras.layers.Dense(128)
        self.bn_gate1   = tf.keras.layers.BatchNormalization()

        # Gate 2 — Categorical (shared layers)
        self.biz_lookup   = shared.biz_lookup
        self.biz_emb      = shared.biz_emb
        self.city_lookup  = shared.city_lookup
        self.city_emb     = shared.city_emb
        self.cat_lookup   = tf.keras.layers.StringLookup(vocabulary=vocab['category'], mask_token='')
        self.cat_emb      = tf.keras.layers.Embedding(len(vocab['category']) + 2, 8)
        self.types_lookup = shared.types_lookup
        self.types_emb    = shared.types_emb
        self.types_pool   = SafeGlobalAveragePooling1D()
        self.vibes_lookup = shared.vibes_lookup
        self.vibes_emb    = shared.vibes_emb
        self.vibes_pool   = SafeGlobalAveragePooling1D()
        self.tt_lookup    = tf.keras.layers.StringLookup(vocabulary=vocab['travel_type'], mask_token='')
        self.tt_emb       = tf.keras.layers.Embedding(
            len(vocab['travel_type']) + 2, ModelConfig.TRAVEL_TYPE_EMB_DIM)
        self.cat_dense    = tf.keras.layers.Dense(128, activation='relu')
        self.bn_gate2     = tf.keras.layers.BatchNormalization()

        # Gate 3 — Numerical
        self.normalizer = tf.keras.layers.Normalization(axis=-1)
        self.num_dense  = tf.keras.layers.Dense(32, activation='relu')
        self.bn_gate3   = tf.keras.layers.BatchNormalization()

        # Fusion
        self.fusion_dense = tf.keras.layers.Dense(256, activation='relu')
        self.dropout      = tf.keras.layers.Dropout(ModelConfig.DROPOUT_RATE)
        self.out          = tf.keras.layers.Dense(ModelConfig.EMB)

    def adapt_numerical(self, stars: np.ndarray, review_counts: np.ndarray) -> None:
        """Fit Normalization layer — call once before loading weights."""
        rc = np.log1p(review_counts).astype(np.float32)
        self.normalizer.adapt(np.stack([stars.astype(np.float32), rc], axis=-1))

    def call(self, inputs, training=False):
        # Gate 1
        g1 = self.bn_gate1(
            self.sem_dense2(self.sem_dense1(inputs['semantic_emb'])),
            training=training)

        # Gate 2
        biz_v  = self.biz_emb(self.biz_lookup(inputs['business_id']))
        city_v = self.city_emb(self.city_lookup(inputs['city']))
        cat_v  = self.cat_emb(self.cat_lookup(inputs['category']))
        type_v = self.types_pool(self.types_emb(self.types_lookup(inputs['types'])))
        vibe_v = self.vibes_pool(self.vibes_emb(self.vibes_lookup(inputs['vibes'])))
        tt_v   = self.tt_emb(self.tt_lookup(inputs['travel_type']))
        g2 = self.bn_gate2(
            self.cat_dense(tf.concat([biz_v, city_v, cat_v, type_v, vibe_v, tt_v], axis=-1)),
            training=training)

        # Gate 3
        log_rc    = tf.math.log1p(inputs['review_count'])
        num_input = tf.stack([inputs['stars_biz'], log_rc], axis=-1)
        g3 = self.bn_gate3(self.num_dense(self.normalizer(num_input)), training=training)

        # Fusion
        x = tf.concat([g1, g2, g3], axis=-1)
        x = self.dropout(self.fusion_dense(x), training=training)
        return tf.math.l2_normalize(self.out(x), axis=-1)


# ---------------------------------------------------------------------------
# Inference loader (mirrors TwoTowerRetrievalModel structure for weight loading)
# ---------------------------------------------------------------------------

# ---------------------------------------------------------------------------
# Padding helper (mirrors notebook pad_sequence)
# ---------------------------------------------------------------------------

def pad_sequence(lst: list, max_len: int, pad_value: str = '') -> list:
    lst = list(lst)[-max_len:]
    return [pad_value] * (max_len - len(lst)) + lst


# ---------------------------------------------------------------------------
# Factory — build QueryTower + load weights via h5py
# ---------------------------------------------------------------------------

def build_inference_model(vocab_path: str | Path, weights_path: str | Path) -> QueryTower:
    """
    Load QueryTower ready for inference.

    Uses h5py directly instead of Keras load_weights() to avoid path-matching
    failures caused by shared/auto-named layers in the Keras 3 checkpoint format.

    Parameters
    ----------
    vocab_path    : path to vocab.pkl saved by the training notebook
    weights_path  : path to best_model.weights.h5

    Returns
    -------
    QueryTower with weights loaded — call it with query dict to get 256-dim embedding.
    """
    vocab_path   = Path(vocab_path)
    weights_path = Path(weights_path)

    with open(vocab_path, 'rb') as f:
        vocab: dict[str, Any] = pickle.load(f)

    shared      = build_shared_layers(vocab)
    query_tower = QueryTower(vocab, shared)

    # Warmup: single forward pass so all layer variables are materialised
    _warmup_query_tower(query_tower)

    # Load weights directly from h5 — bypasses Keras weight-path matching
    _load_query_tower_weights(query_tower, weights_path)

    return query_tower


def _warmup_query_tower(query_tower: QueryTower) -> None:
    """Single forward pass to build all variables before weight loading."""
    ml = ModelConfig.MAX_HISTORY_LEN
    dummy = {
        'user_id':             tf.constant([''],        dtype=tf.string),
        'current_city':        tf.constant([''],        dtype=tf.string),
        'trip_intent':         tf.constant([''],        dtype=tf.string),
        'intent_vibe':         tf.constant([''],        dtype=tf.string),
        'history_business_id': tf.constant([[''] * ml], dtype=tf.string),
        'history_types':       tf.constant([[''] * ml], dtype=tf.string),
        'history_vibes':       tf.constant([[''] * ml], dtype=tf.string),
    }
    _ = query_tower(dummy, training=False)


def _load_query_tower_weights(query_tower: QueryTower, weights_path: Path) -> None:
    """
    Load query_tower weights from h5 file using h5py directly.

    Checkpoint layout under query_tower/ (inspected from best_model.weights.h5):
      Named layers (had explicit name= at training time):
        user_emb/vars/0     (n_users+2, 64)
        types_emb/vars/0    (n_types+2, 16)
        vibes_emb/vars/0    (n_vibes+2, 16)
        vibe_emb/vars/0     (n_intent_vibe+2, 8)
        out/vars/0,1        (128, 256) / (256,)

      Auto-named layers under query_tower/layers/ (matched by weight shape):
        embedding/vars/0    (n_city+2, 16)   → city_emb
        embedding_1/vars/0  (n_biz+2,  64)   → biz_emb
        embedding_2/vars/0  (n_intent+2,16)  → intent_emb
        dense/vars/0,1      (200, 256)        → dense1
        dense_1/vars/0,1    (256, 128)        → dense2
    """
    import h5py

    with h5py.File(str(weights_path), 'r') as f:
        qt  = f['query_tower']
        lyr = qt['layers']

        # ── Named layers ────────────────────────────────────────────────────
        query_tower.user_emb.set_weights([qt['user_emb/vars/0'][()]])
        query_tower.types_emb.set_weights([qt['types_emb/vars/0'][()]])
        query_tower.vibes_emb.set_weights([qt['vibes_emb/vars/0'][()]])
        query_tower.vibe_emb.set_weights([qt['vibe_emb/vars/0'][()]])
        query_tower.out.set_weights([qt['out/vars/0'][()], qt['out/vars/1'][()]])

        # ── Auto-named embeddings: match by shape (all unique) ───────────────
        emb_data: dict[tuple, np.ndarray] = {}
        for key in lyr.keys():
            if key.startswith('embedding') and 'vars' in lyr[key]:
                arr = lyr[key]['vars/0'][()]
                emb_data[arr.shape] = arr

        def _load_emb(layer: tf.keras.layers.Embedding) -> None:
            shape = tuple(layer.embeddings.numpy().shape)
            if shape in emb_data:
                layer.set_weights([emb_data[shape]])

        _load_emb(query_tower.city_emb)
        _load_emb(query_tower.biz_emb)
        _load_emb(query_tower.intent_emb)

        # ── Auto-named dense layers: match by kernel shape ───────────────────
        dense_data: dict[tuple, tuple[np.ndarray, np.ndarray]] = {}
        for key in lyr.keys():
            if key.startswith('dense') and 'vars' in lyr[key]:
                k = lyr[key]['vars/0'][()]
                b = lyr[key]['vars/1'][()]
                dense_data[k.shape] = (k, b)

        def _load_dense(layer: tf.keras.layers.Dense) -> None:
            shape = tuple(layer.kernel.numpy().shape)
            if shape in dense_data:
                k, b = dense_data[shape]
                layer.set_weights([k, b])

        _load_dense(query_tower.dense1)
        _load_dense(query_tower.dense2)
