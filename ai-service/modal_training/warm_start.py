"""Warm-start tu checkpoint truoc -- port co hoc tu Cell "3c" cua
train/two_tower_recommender_15_finetune.ipynb (khong doi logic).

Van de ky thuat (giai thich day du trong notebook): vocab duoc rebuild TU DAU moi lan train (la 1
SORTED list) nen KHONG THE gia dinh "cung index = cung entity" giua 2 lan train. Vi vay khong dung
model.load_weights(old_path) truc tiep len model moi -- ma phai cay ghep tung dong embedding theo
STRING KEY (ten thuc su cua entity), khong theo index.

Luu y khi fine-tune tu Yelp/Foody sang du lieu Supabase that: business_id (place) da la UUID that
cua Supabase o ca 2 phia nen se khop va cay ghep duoc; nhung user_id thi Yelp/Foody UserID va
Supabase UUID la 2 khong gian hoan toan khac nhau -- overlap = 0 la BINH THUONG (khong phai loi).
"""
from __future__ import annotations

import gc
import pickle
from pathlib import Path

import numpy as np
import tensorflow as tf

from . import model as model_module
from .config import Config
from .model import CandidateTower, QueryTower, TwoTowerRetrievalModel

_EMBEDDING_KEYS_TO_TRANSPLANT = [
    ('candidate_tower.biz_emb',   'business_id'),
    ('query_tower.user_emb',      'user_id'),
    ('candidate_tower.city_emb',  'city'),
    ('candidate_tower.cat_emb',   'category'),
    ('candidate_tower.types_emb', 'types'),
    ('candidate_tower.vibes_emb', 'vibes'),
    ('query_tower.intent_emb',    'trip_intent'),
    ('query_tower.vibe_emb',      'intent_vibe'),
    ('candidate_tower.tt_emb',    'travel_type'),
]

_NON_VOCAB_SUBLAYERS = {
    'query_tower': ['dense1', 'dense2', 'out', 'hbiz_pool', 'htype_pool', 'hvibe_pool'],
    'candidate_tower': ['sem_dense1', 'sem_dense2', 'bn_gate1', 'cat_dense', 'bn_gate2',
                         'num_dense', 'bn_gate3', 'fusion_dense', 'out'],
}


def _tower_of(name, qt, ct):
    return {'query_tower': qt, 'candidate_tower': ct}[name]


def _build_old_towers(old_vocab: dict) -> tuple[QueryTower, CandidateTower]:
    """Dung lai class QueryTower/CandidateTower nhung voi shared_* layer (module model.py) TAM
    THOI tro ve old_vocab, khong dung cham toi shared_* dang dung cho model MOI (swap-restore
    quanh __init__, vi __init__ tra cuu ten global shared_* tai thoi diem goi)."""
    _backup = (
        model_module.shared_biz_lookup, model_module.shared_biz_emb,
        model_module.shared_city_lookup, model_module.shared_city_emb,
        model_module.shared_types_lookup, model_module.shared_types_emb,
        model_module.shared_vibes_lookup, model_module.shared_vibes_emb,
    )
    try:
        model_module.shared_biz_lookup  = tf.keras.layers.StringLookup(vocabulary=old_vocab['business_id'], mask_token='')
        model_module.shared_biz_emb     = tf.keras.layers.Embedding(
            len(old_vocab['business_id']) + 2, Config.BIZ_EMB_DIM, mask_zero=True,
            embeddings_regularizer=model_module.EMB_REG)
        model_module.shared_city_lookup = tf.keras.layers.StringLookup(vocabulary=old_vocab['city'], mask_token='')
        model_module.shared_city_emb    = tf.keras.layers.Embedding(len(old_vocab['city']) + 2, Config.CITY_EMB_DIM)
        model_module.shared_types_lookup= tf.keras.layers.StringLookup(vocabulary=old_vocab['types'], mask_token='')
        model_module.shared_types_emb   = tf.keras.layers.Embedding(len(old_vocab['types']) + 2, Config.TYPE_EMB_DIM, mask_zero=True)
        model_module.shared_vibes_lookup= tf.keras.layers.StringLookup(vocabulary=old_vocab['vibes'], mask_token='')
        model_module.shared_vibes_emb   = tf.keras.layers.Embedding(len(old_vocab['vibes']) + 2, Config.TYPE_EMB_DIM, mask_zero=True)
        old_qt = QueryTower(old_vocab)
        old_ct = CandidateTower(old_vocab)
    finally:
        (model_module.shared_biz_lookup, model_module.shared_biz_emb,
         model_module.shared_city_lookup, model_module.shared_city_emb,
         model_module.shared_types_lookup, model_module.shared_types_emb,
         model_module.shared_vibes_lookup, model_module.shared_vibes_emb) = _backup
    return old_qt, old_ct


def _dummy_batch() -> dict:
    ml = Config.MAX_HISTORY_LEN
    return {
        'user_id': tf.constant([''], dtype=tf.string),
        'current_city': tf.constant([''], dtype=tf.string),
        'trip_intent': tf.constant([''], dtype=tf.string),
        'intent_vibe': tf.constant([''], dtype=tf.string),
        'history_types': tf.constant([[''] * ml], dtype=tf.string),
        'history_vibes': tf.constant([[''] * ml], dtype=tf.string),
        'history_business_id': tf.constant([[''] * ml], dtype=tf.string),
        'business_id': tf.constant([''], dtype=tf.string),
        'city': tf.constant([''], dtype=tf.string),
        'category': tf.constant([''], dtype=tf.string),
        'travel_type': tf.constant([''], dtype=tf.string),
        'types': tf.constant([[''] * ml], dtype=tf.string),
        'vibes': tf.constant([[''] * ml], dtype=tf.string),
        'stars_biz': tf.constant([0.0], dtype=tf.float32),
        'review_count': tf.constant([0.0], dtype=tf.float32),
        'semantic_emb': tf.constant(np.zeros((1, Config.BGE_DIM)), dtype=tf.float32),
    }


def warm_start_from_checkpoint(
    warm_start_dir: str,
    query_tower: QueryTower,
    candidate_tower: CandidateTower,
    vocab: dict,
    ds_candidates,
) -> None:
    """Cay ghep embedding + layer khong-phu-thuoc-vocab tu checkpoint cu vao (query_tower,
    candidate_tower) MOI, theo string key. Bo qua an toan (giu random-init, in canh bao) neu
    kien truc/vocab/Config khac nhau giua 2 lan train -- khong lam crash."""
    wdir = Path(warm_start_dir)
    old_vocab_path = wdir / 'vocab.pkl'
    if not old_vocab_path.exists():
        old_vocab_path = wdir.parent / 'vocab.pkl'
    old_weights_path = wdir / 'best_model.weights.h5'
    if not old_weights_path.exists():
        old_weights_path = wdir / 'final_model.weights.h5'
    if not (old_vocab_path.exists() and old_weights_path.exists()):
        print(f'[Warm-start] Khong tim thay vocab.pkl (da thu {wdir} va {wdir.parent}) hoac '
              f'*.weights.h5 trong {wdir} -- bo qua, train tu dau.')
        return

    print(f'[Warm-start] Dang tai checkpoint cu: vocab={old_vocab_path}, weights={old_weights_path}')
    with open(old_vocab_path, 'rb') as f:
        old_vocab = pickle.load(f)

    old_query_tower, old_candidate_tower = _build_old_towers(old_vocab)
    old_biz_log_freq = np.array(old_vocab['biz_log_freq'], dtype=np.float32)
    old_model = TwoTowerRetrievalModel(
        old_query_tower, old_candidate_tower, ds_candidates, old_biz_log_freq,
        old_vocab, Config.TEMPERATURE)
    old_model.compile(optimizer=tf.keras.optimizers.AdamW(
        learning_rate=Config.LEARNING_RATE, weight_decay=Config.WEIGHT_DECAY))
    _ = old_model.compute_loss(_dummy_batch(), training=False)
    old_model.load_weights(str(old_weights_path))
    print('[Warm-start] Da load xong model cu (dung shape voi luc save).')

    for attr_path, vocab_key in _EMBEDDING_KEYS_TO_TRANSPLANT:
        tower_name, attr = attr_path.split('.')
        new_layer = getattr(_tower_of(tower_name, query_tower, candidate_tower), attr, None)
        old_layer = getattr(_tower_of(tower_name, old_query_tower, old_candidate_tower), attr, None)
        if new_layer is None or old_layer is None:
            print(f'  [bo qua] {attr_path}: khong ton tai o model cu hoac model moi (kien truc khac nhau).')
            continue
        if vocab_key not in old_vocab:
            print(f'  [bo qua] {attr_path}: checkpoint cu khong co vocab["{vocab_key}"] (checkpoint qua cu?).')
            continue

        old_matrix = old_layer.get_weights()[0]
        new_matrix = new_layer.get_weights()[0].copy()

        if old_matrix.shape[1] != new_matrix.shape[1]:
            print(f'  [bo qua] {attr_path}: embedding dim khac nhau ({old_matrix.shape[1]} vs '
                  f'{new_matrix.shape[1]}, Config da doi giua 2 lan train?), giu random-init.')
            continue

        new_matrix[0] = old_matrix[0]
        new_matrix[1] = old_matrix[1]

        old_index = {s: i for i, s in enumerate(old_vocab[vocab_key])}
        new_vocab_list = vocab[vocab_key]

        n_matched = 0
        for i, s in enumerate(new_vocab_list):
            j = old_index.get(s)
            if j is not None:
                new_matrix[i + 2] = old_matrix[j + 2]
                n_matched += 1

        new_layer.set_weights([new_matrix])
        pct = n_matched / max(len(new_vocab_list), 1) * 100
        print(f'  {attr_path:28s} ({vocab_key:12s}): {n_matched:,}/{len(new_vocab_list):,} '
              f'entity duoc cay ghep tu checkpoint cu ({pct:.1f}%).')

    for tower_name, attrs in _NON_VOCAB_SUBLAYERS.items():
        new_obj = _tower_of(tower_name, query_tower, candidate_tower)
        old_obj = _tower_of(tower_name, old_query_tower, old_candidate_tower)
        for attr in attrs:
            new_sub, old_sub = getattr(new_obj, attr, None), getattr(old_obj, attr, None)
            if new_sub is None or old_sub is None:
                continue
            old_w, new_w = old_sub.get_weights(), new_sub.get_weights()
            if len(old_w) != len(new_w) or any(a.shape != b.shape for a, b in zip(old_w, new_w)):
                print(f'  [bo qua] {tower_name}.{attr}: shape khac (Config da doi?), giu random-init.')
                continue
            new_sub.set_weights(old_w)
    print('[Warm-start] Da cay ghep xong cac layer khong phu thuoc vocab (MLP/BatchNorm/attention).')

    del old_model, old_query_tower, old_candidate_tower
    gc.collect()
    print('[Warm-start] Hoan tat -- da giai phong model cu khoi bo nho.')
