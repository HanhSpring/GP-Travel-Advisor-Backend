"""Kien truc Two-Tower -- port co hoc (khong doi 1 dong logic nao) tu Cell "3" cua
train/two_tower_recommender_15_finetune.ipynb.

QUAN TRONG: shared_biz_lookup/shared_biz_emb/shared_city_lookup/... duoc giu la BIEN MODULE-LEVEL
(khong bọc trong ham) giong het notebook, vi warm_start.py can swap-restore chung TAM THOI khi
build lai "model cu" tu vocab cu (dung dung pattern cua Cell 3c) -- xem warm_start.py.
"""
from __future__ import annotations

import numpy as np
import tensorflow as tf
import tensorflow_recommenders as tfrs

from .config import Config, EMB_REG

EMB = Config.OUTPUT_DIM

# Duoc gan gia tri thuc trong build_towers(vocab). Khai bao truoc o day de warm_start.py co the
# import va swap-restore (globals() trong module nay, khong phai cua warm_start.py).
shared_biz_lookup = None
shared_biz_emb = None
shared_city_lookup = None
shared_city_emb = None
shared_types_lookup = None
shared_types_emb = None
shared_vibes_lookup = None
shared_vibes_emb = None


# ---------------------------------------------------------------------------
# 0. Safe pooling chong NaN tu sequence rong + history attention
# ---------------------------------------------------------------------------

class RecencyWeightedAveragePooling1D(tf.keras.layers.Layer):
    def __init__(self, recency_weighted: bool = True, **kwargs):
        super().__init__(**kwargs)
        self.recency_weighted = recency_weighted
        self.supports_masking = True

    def call(self, inputs, mask=None):
        seq_len = tf.shape(inputs)[1]
        if self.recency_weighted:
            positions = tf.cast(tf.range(seq_len), inputs.dtype)
            weights = tf.exp(positions / tf.maximum(tf.cast(seq_len - 1, inputs.dtype), 1.0))
            weights = tf.reshape(weights, (1, seq_len, 1))
        else:
            weights = tf.ones((1, seq_len, 1), dtype=inputs.dtype)

        if mask is not None:
            weights = weights * tf.cast(tf.expand_dims(mask, -1), inputs.dtype)

        return tf.math.divide_no_nan(
            tf.reduce_sum(inputs * weights, axis=1),
            tf.reduce_sum(weights, axis=1),
        )


class QueryAwareAttentionPooling1D(tf.keras.layers.Layer):
    """Attention pooling for history, conditioned on current trip context."""

    def __init__(self, **kwargs):
        super().__init__(**kwargs)
        self.supports_masking = True
        self.context_proj = None
        self.score_dense = tf.keras.layers.Dense(1)

    def build(self, input_shape):
        seq_dim = int(input_shape[0][-1])
        self.context_proj = tf.keras.layers.Dense(seq_dim, use_bias=False)
        super().build(input_shape)

    def call(self, inputs, mask=None):
        seq_emb, context_emb = inputs
        context_v = tf.expand_dims(self.context_proj(context_emb), axis=1)
        logits = tf.squeeze(self.score_dense(tf.nn.tanh(seq_emb + context_v)), axis=-1)

        seq_mask = None
        if isinstance(mask, (list, tuple)):
            seq_mask = mask[0]
        elif mask is not None:
            seq_mask = mask

        if seq_mask is not None:
            valid = tf.cast(seq_mask, logits.dtype)
            logits = tf.where(tf.cast(seq_mask, tf.bool), logits, tf.constant(-1e9, dtype=logits.dtype))
            weights = tf.nn.softmax(logits, axis=1) * valid
            weights = tf.math.divide_no_nan(weights, tf.reduce_sum(weights, axis=1, keepdims=True))
        else:
            weights = tf.nn.softmax(logits, axis=1)

        return tf.reduce_sum(seq_emb * tf.expand_dims(weights, -1), axis=1)


# ---------------------------------------------------------------------------
# 1. QUERY TOWER
# ---------------------------------------------------------------------------

class QueryTower(tf.keras.Model):
    def __init__(self, vocab: dict):
        super().__init__()
        self.user_lookup = tf.keras.layers.StringLookup(vocabulary=vocab['user_id'], mask_token='')
        self.user_emb = tf.keras.layers.Embedding(
            len(vocab['user_id']) + 2, Config.USER_EMB_DIM, embeddings_regularizer=EMB_REG)

        self.city_lookup  = shared_city_lookup
        self.city_emb     = shared_city_emb
        self.biz_lookup   = shared_biz_lookup
        self.biz_emb      = shared_biz_emb
        self.types_lookup = shared_types_lookup
        self.types_emb    = shared_types_emb
        self.vibes_lookup = shared_vibes_lookup
        self.vibes_emb    = shared_vibes_emb
        self.recency_pool = RecencyWeightedAveragePooling1D(Config.USE_RECENCY_WEIGHTED_HISTORY)
        self.hbiz_pool  = QueryAwareAttentionPooling1D(name='history_business_attention')
        self.htype_pool = QueryAwareAttentionPooling1D(name='history_type_attention')
        self.hvibe_pool = QueryAwareAttentionPooling1D(name='history_vibe_attention')

        self.intent_lookup = tf.keras.layers.StringLookup(vocabulary=vocab['trip_intent'], mask_token='')
        self.intent_emb = tf.keras.layers.Embedding(len(vocab['trip_intent']) + 2, Config.TRAVEL_TYPE_EMB_DIM)
        self.vibe_lookup = tf.keras.layers.StringLookup(vocabulary=vocab['intent_vibe'], mask_token='')
        self.vibe_emb = tf.keras.layers.Embedding(len(vocab['intent_vibe']) + 2, 8)

        self.dense1 = tf.keras.layers.Dense(256, activation='relu')
        self.drop1  = tf.keras.layers.Dropout(Config.DROPOUT_RATE)
        self.dense2 = tf.keras.layers.Dense(128, activation='relu')
        self.drop2  = tf.keras.layers.Dropout(0.1)
        self.out    = tf.keras.layers.Dense(EMB)

    def call(self, inputs, training=False):
        user_v   = self.user_emb(self.user_lookup(inputs['user_id']))
        city_v   = self.city_emb(self.city_lookup(inputs['current_city']))
        intent_v = self.intent_emb(self.intent_lookup(inputs['trip_intent']))
        vibe_v   = self.vibe_emb(self.vibe_lookup(inputs['intent_vibe']))

        history_context = tf.concat([city_v, intent_v, vibe_v], axis=-1)

        hbiz_tok  = self.biz_lookup(inputs['history_business_id'])
        htype_tok = self.types_lookup(inputs['history_types'])
        hvibe_tok = self.vibes_lookup(inputs['history_vibes'])
        hbiz_seq  = self.biz_emb(hbiz_tok)
        htype_seq = self.types_emb(htype_tok)
        hvibe_seq = self.vibes_emb(hvibe_tok)

        if Config.USE_QUERY_ATTENTION_HISTORY:
            hbiz_v  = self.hbiz_pool([hbiz_seq, history_context], mask=[tf.not_equal(hbiz_tok, 0), None])
            htype_v = self.htype_pool([htype_seq, history_context], mask=[tf.not_equal(htype_tok, 0), None])
            hvibe_v = self.hvibe_pool([hvibe_seq, history_context], mask=[tf.not_equal(hvibe_tok, 0), None])
        else:
            hbiz_v  = self.recency_pool(hbiz_seq, mask=tf.not_equal(hbiz_tok, 0))
            htype_v = self.recency_pool(htype_seq, mask=tf.not_equal(htype_tok, 0))
            hvibe_v = self.recency_pool(hvibe_seq, mask=tf.not_equal(hvibe_tok, 0))

        x = tf.concat([user_v, city_v, intent_v, vibe_v, hbiz_v, htype_v, hvibe_v], axis=-1)
        x = self.drop1(self.dense1(x), training=training)
        x = self.drop2(self.dense2(x), training=training)
        return tf.math.l2_normalize(self.out(x), axis=-1)


# ---------------------------------------------------------------------------
# 2. CANDIDATE TOWER (3 cong song song)
# ---------------------------------------------------------------------------

class CandidateTower(tf.keras.Model):
    def __init__(self, vocab: dict):
        super().__init__()

        self.sem_dense1 = tf.keras.layers.Dense(256, activation='relu')
        self.sem_dense2 = tf.keras.layers.Dense(128)
        self.bn_gate1   = tf.keras.layers.BatchNormalization()

        self.biz_lookup   = shared_biz_lookup
        self.biz_emb      = shared_biz_emb
        self.city_lookup  = shared_city_lookup
        self.city_emb     = shared_city_emb
        self.cat_lookup   = tf.keras.layers.StringLookup(vocabulary=vocab['category'], mask_token='')
        self.cat_emb      = tf.keras.layers.Embedding(len(vocab['category']) + 2, 8)
        self.types_lookup = shared_types_lookup
        self.types_emb    = shared_types_emb
        self.types_pool   = RecencyWeightedAveragePooling1D(recency_weighted=False)
        self.vibes_lookup = shared_vibes_lookup
        self.vibes_emb    = shared_vibes_emb
        self.vibes_pool   = RecencyWeightedAveragePooling1D(recency_weighted=False)
        self.tt_lookup = tf.keras.layers.StringLookup(vocabulary=vocab['travel_type'], mask_token='')
        self.tt_emb    = tf.keras.layers.Embedding(len(vocab['travel_type']) + 2, Config.TRAVEL_TYPE_EMB_DIM)
        self.cat_dense = tf.keras.layers.Dense(128, activation='relu')
        self.bn_gate2  = tf.keras.layers.BatchNormalization()

        self.normalizer = tf.keras.layers.Normalization(axis=-1)
        self.num_dense  = tf.keras.layers.Dense(32, activation='relu')
        self.bn_gate3   = tf.keras.layers.BatchNormalization()

        self.fusion_dense = tf.keras.layers.Dense(256, activation='relu')
        self.dropout      = tf.keras.layers.Dropout(Config.DROPOUT_RATE)
        self.out          = tf.keras.layers.Dense(EMB)

    def adapt_numerical(self, df_candidates):
        stars = df_candidates['stars_biz'].fillna(0).values.astype(np.float32)
        rc    = np.log1p(df_candidates['review_count'].fillna(0).values).astype(np.float32)
        self.normalizer.adapt(np.stack([stars, rc], axis=-1))
        print(f'Normalization adapted on {len(stars):,} candidates.')

    def call(self, inputs, training=False):
        g1 = self.bn_gate1(self.sem_dense2(self.sem_dense1(inputs['semantic_emb'])), training=training)

        biz_v  = self.biz_emb(self.biz_lookup(inputs['business_id']))
        city_v = self.city_emb(self.city_lookup(inputs['city']))
        cat_v  = self.cat_emb(self.cat_lookup(inputs['category']))
        type_v = self.types_pool(self.types_emb(self.types_lookup(inputs['types'])))
        vibe_v = self.vibes_pool(self.vibes_emb(self.vibes_lookup(inputs['vibes'])))
        tt_v   = self.tt_emb(self.tt_lookup(inputs['travel_type']))
        g2 = self.bn_gate2(
            self.cat_dense(tf.concat([biz_v, city_v, cat_v, type_v, vibe_v, tt_v], axis=-1)),
            training=training)

        log_rc    = tf.math.log1p(inputs['review_count'])
        num_input = tf.stack([inputs['stars_biz'], log_rc], axis=-1)
        g3 = self.bn_gate3(self.num_dense(self.normalizer(num_input)), training=training)

        x = tf.concat([g1, g2, g3], axis=-1)
        x = self.dropout(self.fusion_dense(x), training=training)
        return tf.math.l2_normalize(self.out(x), axis=-1)


# ---------------------------------------------------------------------------
# 3. TWO-TOWER RETRIEVAL MODEL (voi SBC -- Sampling-Bias Correction)
# ---------------------------------------------------------------------------

class TwoTowerRetrievalModel(tfrs.Model):
    """SBC: subtract log(p_j) khoi logit khi training (Yi et al. 2019, 'Sampling-Bias-Corrected
    Neural Modeling ...')."""

    def __init__(self, query_tower, candidate_tower, ds_candidates, biz_log_freq, vocab, temperature):
        super().__init__()
        self.query_tower     = query_tower
        self.candidate_tower = candidate_tower

        self._sbc_lookup = tf.keras.layers.StringLookup(
            vocabulary=vocab['business_id'], mask_token='', output_mode='int')
        _neutral = float(np.log(1.0 / max(len(biz_log_freq), 1)))
        _lf_pad  = np.concatenate([[_neutral], [_neutral], biz_log_freq]).astype(np.float32)
        self._log_freq_table = tf.Variable(
            tf.constant(_lf_pad, dtype=tf.float32), trainable=False, name='sbc_log_freq')

        self.task = tfrs.tasks.Retrieval(
            metrics=tfrs.metrics.FactorizedTopK(candidates=ds_candidates.map(candidate_tower)),
            temperature=temperature,
        )

    def compute_loss(self, features, training=False):
        query_emb     = self.query_tower(features, training=training)
        candidate_emb = self.candidate_tower(features, training=training)

        sampling_prob = None
        if training:
            indices       = self._sbc_lookup(features['business_id'])
            log_freq      = tf.gather(self._log_freq_table, indices)
            sampling_prob = tf.exp(log_freq)

        return self.task(
            query_emb,
            candidate_emb,
            sample_weight=features.get('example_weight'),
            compute_metrics=not training,
            candidate_sampling_probability=sampling_prob,
        )


def build_towers(vocab: dict) -> tuple[QueryTower, CandidateTower]:
    """Cell 3 -- (re)tao cac shared_* layer MODULE-LEVEL roi khoi tao QueryTower/CandidateTower.
    Goi 1 lan/run truoc khi train; warm_start.py se tam thoi swap cac bien nay khi can build
    "model cu" de cay ghep embedding."""
    global shared_biz_lookup, shared_biz_emb, shared_city_lookup, shared_city_emb
    global shared_types_lookup, shared_types_emb, shared_vibes_lookup, shared_vibes_emb

    shared_biz_lookup  = tf.keras.layers.StringLookup(vocabulary=vocab['business_id'], mask_token='')
    shared_biz_emb     = tf.keras.layers.Embedding(
        len(vocab['business_id']) + 2, Config.BIZ_EMB_DIM, mask_zero=True, embeddings_regularizer=EMB_REG)
    shared_city_lookup = tf.keras.layers.StringLookup(vocabulary=vocab['city'], mask_token='')
    shared_city_emb    = tf.keras.layers.Embedding(len(vocab['city']) + 2, Config.CITY_EMB_DIM)
    shared_types_lookup= tf.keras.layers.StringLookup(vocabulary=vocab['types'], mask_token='')
    shared_types_emb   = tf.keras.layers.Embedding(len(vocab['types']) + 2, Config.TYPE_EMB_DIM, mask_zero=True)
    shared_vibes_lookup= tf.keras.layers.StringLookup(vocabulary=vocab['vibes'], mask_token='')
    shared_vibes_emb   = tf.keras.layers.Embedding(len(vocab['vibes']) + 2, Config.TYPE_EMB_DIM, mask_zero=True)

    query_tower     = QueryTower(vocab)
    candidate_tower = CandidateTower(vocab)
    return query_tower, candidate_tower
