"""tf.data pipeline -- port co hoc tu Cell "2a" (Build Vocabularies) + "2b/2c" (tao tf.data
Dataset, RAM-optimized) cua train/two_tower_recommender_15_finetune.ipynb."""
from __future__ import annotations

import pickle
import time
from collections import Counter
from pathlib import Path

import numpy as np
import pandas as pd
import tensorflow as tf

from .config import Config

AUTOTUNE = tf.data.AUTOTUNE


# ---------------------------------------------------------------------------
# Cell "2a" -- Build Vocabularies (chi tu df_train)
# ---------------------------------------------------------------------------

def flatten_list_col(series: pd.Series) -> list[str]:
    result: set[str] = set()
    for lst in series:
        if lst is None:
            continue
        try:
            for v in lst:
                if v is not None and v == v and str(v).strip():
                    result.add(str(v))
        except TypeError:
            pass
    return sorted(result)


KNOWN_TRAVEL_TYPES = [
    "Đô thị & Vui chơi",
    "Khám phá & Sinh thái",
    "Khám phá tổng hợp",
    "Nghỉ dưỡng & Biển",
    "Văn hóa & Lịch sử",
]


def build_vocab(df_train: pd.DataFrame, df_candidates: pd.DataFrame, save_path: Path) -> dict:
    user_counts = df_train['user_id'].value_counts()
    loyal_users = user_counts[user_counts >= Config.USER_MIN_INTERACTIONS].index.tolist()

    data_tt: list = []
    for src in [df_candidates, df_train]:
        if 'travel_type' in src.columns:
            data_tt += src['travel_type'].dropna().unique().tolist()
    travel_type_vocab = sorted(set(KNOWN_TRAVEL_TYPES + [str(v) for v in data_tt if v]))

    vocab = {
        'user_id':     sorted(loyal_users),
        'business_id': sorted(df_train['id'].unique().tolist()),
        'city':        sorted(df_train['current_city'].dropna().unique().tolist()),
        'category':    sorted(df_train['category'].dropna().unique().tolist()),
        'types':       flatten_list_col(df_train['types']),
        'vibes':       flatten_list_col(df_train['vibes']),
        'trip_intent': sorted(df_train['trip_intent'].dropna().unique().tolist()),
        'intent_vibe': sorted(df_train['intent_vibe'].dropna().unique().tolist()),
        'travel_type': travel_type_vocab,
    }

    for key in ('types', 'vibes', 'travel_type'):
        assert len(vocab[key]) > 0, f"vocab['{key}'] is empty!"

    biz_counts = Counter(df_train['id'].astype(str).tolist())
    total = len(df_train)
    vocab['biz_log_freq'] = [
        float(np.log(max(biz_counts.get(bid, 1), 1) / total)) for bid in vocab['business_id']
    ]

    with open(save_path, 'wb') as f:
        pickle.dump(vocab, f)

    for k, v in vocab.items():
        print(f'  vocab[{k:14s}]: {len(v):,} unique values')
    return vocab


# ---------------------------------------------------------------------------
# Cell "2b/2c" -- Tao tf.data Pipeline (RAM-optimized)
# ---------------------------------------------------------------------------

def _pad_sequence(lst, max_len, pad_value=''):
    if not isinstance(lst, (list, np.ndarray)):
        lst = []
    lst = list(lst)[-max_len:]
    if len(lst) < max_len:
        lst = [pad_value] * (max_len - len(lst)) + lst
    return lst


def build_datasets(df_train, df_val, df_test, df_candidates):
    bs = Config.BATCH_SIZE
    max_seq_len = Config.MAX_HISTORY_LEN

    print('Building embedding lookup dict from df_candidates ...')
    t0 = time.time()
    emb_lookup: dict[str, np.ndarray] = {}
    for _, row in df_candidates.iterrows():
        bid = str(row.get('id', row.get('business_id', '')))
        bge = row.get('bge_embedding', row.get('embedding', None))
        if bge is not None and bid:
            emb_lookup[bid] = np.array(bge, dtype=np.float32)
    print(f'  Lookup: {len(emb_lookup):,} items | {time.time() - t0:.1f}s')

    def create_tf_dataset(df, batch_size, is_training=True, is_candidate=False):
        if is_training:
            df = df.sample(frac=1.0, random_state=42).reset_index(drop=True)

        def generator():
            for _, row in df.iterrows():
                record = {}
                if not is_candidate:
                    record['user_id']             = str(row['user_id'])
                    record['current_city']        = str(row.get('current_city', ''))
                    record['trip_intent']         = str(row.get('trip_intent', ''))
                    record['intent_vibe']         = str(row.get('intent_vibe', ''))
                    record['history_types']       = _pad_sequence(row.get('history_types', []), max_seq_len)
                    record['history_vibes']       = _pad_sequence(row.get('history_vibes', []), max_seq_len)
                    record['history_business_id'] = _pad_sequence(row.get('history_business_id', []), max_seq_len)
                    record['example_weight']      = float(row.get('example_weight', 1.0))

                record['business_id']  = str(row.get('id', row.get('business_id', '')))
                record['city']         = str(row.get('city', ''))
                record['category']     = str(row.get('category', ''))
                record['travel_type']  = str(row.get('travel_type') or '')
                record['types']        = _pad_sequence(row.get('types', []), max_seq_len)
                record['vibes']        = _pad_sequence(row.get('vibes', []), max_seq_len)
                record['stars_biz']    = float(row.get('stars_biz', 0.0))
                record['review_count'] = float(row.get('review_count', 0.0))

                if is_candidate:
                    bge = row.get('bge_embedding', row.get('embedding', None))
                    record['semantic_emb'] = (
                        np.array(bge, dtype=np.float32) if bge is not None
                        else np.zeros(Config.BGE_DIM, np.float32)
                    )
                else:
                    record['semantic_emb'] = emb_lookup.get(
                        record['business_id'], np.zeros(Config.BGE_DIM, np.float32))
                yield record

        sig = {}
        if not is_candidate:
            sig.update({
                'user_id':             tf.TensorSpec(shape=(), dtype=tf.string),
                'current_city':        tf.TensorSpec(shape=(), dtype=tf.string),
                'trip_intent':         tf.TensorSpec(shape=(), dtype=tf.string),
                'intent_vibe':         tf.TensorSpec(shape=(), dtype=tf.string),
                'history_types':       tf.TensorSpec(shape=(max_seq_len,), dtype=tf.string),
                'history_vibes':       tf.TensorSpec(shape=(max_seq_len,), dtype=tf.string),
                'history_business_id': tf.TensorSpec(shape=(max_seq_len,), dtype=tf.string),
                'example_weight':      tf.TensorSpec(shape=(), dtype=tf.float32),
            })
        sig.update({
            'business_id':  tf.TensorSpec(shape=(), dtype=tf.string),
            'city':         tf.TensorSpec(shape=(), dtype=tf.string),
            'category':     tf.TensorSpec(shape=(), dtype=tf.string),
            'travel_type':  tf.TensorSpec(shape=(), dtype=tf.string),
            'types':        tf.TensorSpec(shape=(max_seq_len,), dtype=tf.string),
            'vibes':        tf.TensorSpec(shape=(max_seq_len,), dtype=tf.string),
            'stars_biz':    tf.TensorSpec(shape=(), dtype=tf.float32),
            'review_count': tf.TensorSpec(shape=(), dtype=tf.float32),
            'semantic_emb': tf.TensorSpec(shape=(Config.BGE_DIM,), dtype=tf.float32),
        })

        ds = tf.data.Dataset.from_generator(generator, output_signature=sig)
        if is_training:
            ds = ds.shuffle(buffer_size=1000, seed=42)
        ds = ds.batch(batch_size)
        if not is_training:
            ds = ds.cache()
        if is_training:
            ds = ds.repeat()
        return ds.prefetch(AUTOTUNE)

    print('Building tf.data pipelines ...')
    t0 = time.time()
    ds_train      = create_tf_dataset(df_train,      bs, is_training=True,  is_candidate=False)
    ds_val        = create_tf_dataset(df_val,        bs, is_training=False, is_candidate=False)
    ds_test       = create_tf_dataset(df_test,       bs, is_training=False, is_candidate=False)
    ds_candidates = create_tf_dataset(df_candidates, bs, is_training=False, is_candidate=True)
    print(f'Pipelines built in {time.time() - t0:.1f}s')

    return ds_train, ds_val, ds_test, ds_candidates
