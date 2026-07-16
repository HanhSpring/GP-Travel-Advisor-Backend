"""Danh gia offline -- port co hoc (khong doi logic) tu Cell "5c" (compute_user_level_metrics) cua
train/two_tower_recommender_15_finetune.ipynb. KHONG port Cell 5a/5b (encode candidate corpus rieng
+ BruteForce index) vi eval o day tu tinh dot-product truc tiep, khong can index -- BruteForce chi
dung cho demo inference (Cell 6), ngoai pham vi training pipeline tu dong.
"""
from __future__ import annotations

import unicodedata

import numpy as np
import pandas as pd
import tensorflow as tf

from .config import Config


def pad_sequence(lst, max_len, pad_value=''):
    if not isinstance(lst, (list, np.ndarray)):
        lst = []
    lst = list(lst)[-max_len:]
    if len(lst) < max_len:
        lst = [pad_value] * (max_len - len(lst)) + lst
    return lst


def normalize_text(value):
    text = str(value or '').lower().strip()
    text = unicodedata.normalize('NFKD', text)
    text = ''.join(ch for ch in text if not unicodedata.combining(ch))
    return ' '.join(text.replace('&', ' ').replace('-', ' ').replace('_', ' ').split())


def category_to_slot(category):
    c = normalize_text(category)
    if not c:
        return ''
    if any(tok in c for tok in ['am thuc', 'an uong', 'restaurant', 'food', 'quan an', 'nha hang', 'cafe', 'coffee']):
        return 'restaurant'
    if any(tok in c for tok in ['van hoa', 'di san', 'lich su', 'tham quan', 'kham pha', 'attraction', 'tourism', 'museum', 'chua', 'den']):
        return 'attraction'
    if any(tok in c for tok in ['giai tri', 'vui choi', 'bar', 'pub', 'club', 'cinema']):
        return 'entertainment'
    if any(tok in c for tok in ['mua sam', 'dich vu', 'shopping', 'mall', 'market']):
        return 'shopping'
    if any(tok in c for tok in ['thu gian', 'the thao', 'spa', 'relax', 'sport']):
        return 'relaxation'
    if any(tok in c for tok in ['luu tru', 'hotel', 'resort', 'homestay']):
        return 'accommodation'
    return ''


REQUIRED_SLOTS = {'attraction', 'restaurant'}


def _empty_metric_acc(top_k_list):
    return {
        'hit_rate':  {k: 0.0 for k in top_k_list},
        'recall':    {k: 0.0 for k in top_k_list},
        'precision': {k: 0.0 for k in top_k_list},
        'map_k':     {k: 0.0 for k in top_k_list},
        'ndcg':      {k: 0.0 for k in top_k_list},
        'mrr':       {k: 0.0 for k in top_k_list},
        'type_p':    {k: 0.0 for k in top_k_list},
        'vibe_p':    {k: 0.0 for k in top_k_list},
        'tt_align':  {k: 0.0 for k in top_k_list},
        'slot_cov':  {k: 0.0 for k in top_k_list},
        'n_users':   0,
    }


def _topk_desc(scores, k):
    if len(scores) <= k:
        idx = np.arange(len(scores))
    else:
        idx = np.argpartition(-scores, k - 1)[:k]
    return idx[np.argsort(scores[idx])[::-1]]


def _ranking_metrics(topk_ids, gt_ids, k):
    hits = 0
    ap = 0.0
    dcg = 0.0
    rr = 0.0
    for rank, pid in enumerate(topk_ids[:k], start=1):
        if pid in gt_ids:
            hits += 1
            ap += hits / rank
            dcg += 1.0 / np.log2(rank + 1)
            if rr == 0.0:
                rr = 1.0 / rank
    denom = min(len(gt_ids), k)
    idcg = sum(1.0 / np.log2(rank + 1) for rank in range(1, denom + 1))
    return {
        'hits': hits,
        'ap': ap / denom if denom else 0.0,
        'ndcg': dcg / idcg if idcg > 0 else 0.0,
        'mrr': rr,
    }


def _update_metric_acc(acc, top_k_list, ret_ids, ret_tt, ret_cats, gt_ids, gt_types, gt_vibes, uintent, biz_meta):
    acc['n_users'] += 1
    for k in top_k_list:
        topk_ids  = ret_ids[:k]
        topk_tt   = ret_tt[:k]
        topk_cats = ret_cats[:k]

        rank_m = _ranking_metrics(topk_ids, gt_ids, k)
        hits = rank_m['hits']
        acc['hit_rate'][k]  += float(hits > 0)
        acc['precision'][k] += hits / k
        acc['recall'][k]    += hits / len(gt_ids)
        acc['map_k'][k]     += rank_m['ap']
        acc['ndcg'][k]      += rank_m['ndcg']
        acc['mrr'][k]       += rank_m['mrr']

        tm = sum(1 for bid in topk_ids if gt_types & biz_meta.get(bid, {}).get('types', set()))
        vm = sum(1 for bid in topk_ids if gt_vibes & biz_meta.get(bid, {}).get('vibes', set()))
        acc['type_p'][k] += tm / k
        acc['vibe_p'][k] += vm / k

        if uintent:
            acc['tt_align'][k] += float(np.sum(topk_tt == uintent)) / k

        slot_types_found = {category_to_slot(cat) for cat in topk_cats} - {''}
        acc['slot_cov'][k] += len(REQUIRED_SLOTS & slot_types_found) / len(REQUIRED_SLOTS)


def _acc_to_rows(acc, top_k_list, retrieval_scope, user_segment):
    rows = []
    d = max(acc['n_users'], 1)
    for k in top_k_list:
        rows.append({
            'RetrievalScope': retrieval_scope,
            'UserSegment': user_segment,
            'K': k,
            'Users': acc['n_users'],
            'Precision@K': acc['precision'][k] / d,
            'Recall@K': acc['recall'][k] / d,
            'MAP@K': acc['map_k'][k] / d,
            'NDCG@K': acc['ndcg'][k] / d,
            'MRR@K': acc['mrr'][k] / d,
            'HitRate@K': acc['hit_rate'][k] / d,
            'Type_Precision@K': acc['type_p'][k] / d,
            'Vibe_Precision@K': acc['vibe_p'][k] / d,
            'TravelType_Align@K': acc['tt_align'][k] / d,
            'SlotCoverage@K': acc['slot_cov'][k] / d,
        })
    return rows


def compute_user_level_metrics(df_test, query_tower, candidate_tower, top_k_list, df_candidates):
    id_col  = 'id' if 'id' in df_candidates.columns else 'business_id'
    emb_col = 'bge_embedding' if 'bge_embedding' in df_candidates.columns else 'embedding'

    print('1. Extracting candidate embeddings ...')
    cand_dict = {
        'business_id':  tf.constant(df_candidates[id_col].astype(str).values, dtype=tf.string),
        'city':         tf.constant(df_candidates['city'].astype(str).values, dtype=tf.string),
        'category':     tf.constant(df_candidates['category'].astype(str).values, dtype=tf.string),
        'travel_type':  tf.constant(df_candidates['travel_type'].fillna('').astype(str).values, dtype=tf.string),
        'types':        tf.constant([pad_sequence(lst, Config.MAX_HISTORY_LEN) for lst in df_candidates['types']], dtype=tf.string),
        'vibes':        tf.constant([pad_sequence(lst, Config.MAX_HISTORY_LEN) for lst in df_candidates['vibes']], dtype=tf.string),
        'stars_biz':    tf.constant(df_candidates['stars_biz'].fillna(0).astype(np.float32).values, dtype=tf.float32),
        'review_count': tf.constant(df_candidates['review_count'].fillna(0).astype(np.float32).values, dtype=tf.float32),
        'semantic_emb': tf.constant(np.vstack(df_candidates[emb_col].values), dtype=tf.float32),
    }
    all_cand_embs   = candidate_tower(cand_dict, training=False).numpy()
    all_cand_ids    = df_candidates[id_col].astype(str).values
    all_cand_cities = df_candidates['city'].astype(str).values
    all_cand_tt     = df_candidates['travel_type'].fillna('').astype(str).values
    all_cand_cats   = df_candidates['category'].fillna('').astype(str).values

    print('2. Building metadata lookup ...')
    biz_meta = {}
    for _, row in df_candidates.iterrows():
        bid = str(row.get('id', row.get('business_id', '')))
        biz_meta[bid] = {
            'types': set(row['types']) if isinstance(row['types'], (list, np.ndarray)) else set(),
            'vibes': set(row['vibes']) if isinstance(row['vibes'], (list, np.ndarray)) else set(),
            'travel_type': str(row.get('travel_type', '') or ''),
            'category':    str(row.get('category', '')),
        }

    print('3. Preparing user-level queries ...')
    id_col_test = 'id' if 'id' in df_test.columns else 'business_id'
    gt_dict = df_test.groupby('user_id')[id_col_test].apply(lambda s: set(s.astype(str))).to_dict()
    df_q    = df_test.groupby('user_id').first().reset_index()

    test_q_dict = {
        'user_id':             tf.constant(df_q['user_id'].astype(str).values, dtype=tf.string),
        'current_city':        tf.constant(df_q['current_city'].astype(str).values, dtype=tf.string),
        'trip_intent':         tf.constant(df_q['trip_intent'].fillna('').astype(str).values, dtype=tf.string),
        'intent_vibe':         tf.constant(df_q['intent_vibe'].fillna('').astype(str).values, dtype=tf.string),
        'history_types':       tf.constant([pad_sequence(lst, Config.MAX_HISTORY_LEN) for lst in df_q['history_types']], dtype=tf.string),
        'history_vibes':       tf.constant([pad_sequence(lst, Config.MAX_HISTORY_LEN) for lst in df_q['history_vibes']], dtype=tf.string),
        'history_business_id': tf.constant([pad_sequence(lst, Config.MAX_HISTORY_LEN) for lst in df_q['history_business_id']], dtype=tf.string),
    }
    ds_test_q = tf.data.Dataset.from_tensor_slices(test_q_dict).batch(Config.BATCH_SIZE)

    max_k = max(top_k_list)
    # Chi tinh scope='city_aware'/segment='all' -- day la TO HOP DUY NHAT duoc dung thuc te:
    # metrics_summary_for_callback() loc dung ('city_aware','all') truoc khi gui qua webhook ->
    # model_versions.metrics (nguon so lieu Recall/HitRate hien tren ModelVersionsPanel), va
    # eval_results.csv (chua ca 6 to hop scope x segment) chi ghi ra thu muc local trong container
    # Modal -- data_io.upload_results() KHONG upload file nay len R2 nen no bi xoa cung container
    # sau khi job xong. Ban cu tinh ca 'global' scope + segment 'loyal'/'near_cold' nhung ket qua
    # khong bao gio roi khoi container -- thuan tuy ton CPU. Bo 5/6 to hop nay giam ~4x so lan goi
    # _update_metric_acc (2 scope x 2 acc/user -> 1 scope x 1 acc/user) trong vong lap per-user
    # ben duoi, dong gop phan lon vao ~5m47s "Evaluating users" quan sat duoc trong log Modal that.
    acc = _empty_metric_acc(top_k_list)

    print('4. Evaluating users (city-aware retrieval) ...')
    for batch in ds_test_q:
        q_embs       = query_tower(batch, training=False).numpy()
        user_ids     = batch['user_id'].numpy()
        user_cities  = batch['current_city'].numpy()
        user_intents = batch['trip_intent'].numpy()

        for i in range(len(user_ids)):
            uid     = user_ids[i].decode('utf-8')
            ucity   = user_cities[i].decode('utf-8')
            uintent = user_intents[i].decode('utf-8')
            u_emb   = q_embs[i]

            gt_ids = gt_dict.get(uid, set())
            if not gt_ids:
                continue

            gt_types, gt_vibes = set(), set()
            for gid in gt_ids:
                gt_types.update(biz_meta.get(gid, {}).get('types', set()))
                gt_vibes.update(biz_meta.get(gid, {}).get('vibes', set()))

            cand_idx = np.where(all_cand_cities == ucity)[0]
            if len(cand_idx) == 0:
                continue

            scores  = np.dot(all_cand_embs[cand_idx], u_emb)
            top_idx = _topk_desc(scores, max_k)
            chosen  = cand_idx[top_idx]

            ret_ids  = all_cand_ids[chosen]
            ret_tt   = all_cand_tt[chosen]
            ret_cats = all_cand_cats[chosen]

            _update_metric_acc(acc, top_k_list, ret_ids, ret_tt, ret_cats,
                               gt_ids, gt_types, gt_vibes, uintent, biz_meta)

    rows = _acc_to_rows(acc, top_k_list, 'city_aware', 'all')
    return pd.DataFrame(rows), acc


def metrics_summary_for_callback(df_metrics: pd.DataFrame) -> dict:
    """Rut gon df_metrics thanh dict phang de gui qua webhook training-callback -> luu vao
    ai_config.model_versions.metrics (jsonb). Dung scope='city_aware', segment='all' lam so lieu
    chinh (dai dien production: recommend theo thanh pho hien tai cua user)."""
    primary = df_metrics[
        (df_metrics['RetrievalScope'] == 'city_aware') & (df_metrics['UserSegment'] == 'all')
    ]
    out: dict = {}
    for _, row in primary.iterrows():
        k = int(row['K'])
        out[f'recall_at_{k}'] = float(row['Recall@K'])
        out[f'precision_at_{k}'] = float(row['Precision@K'])
        out[f'hit_rate_at_{k}'] = float(row['HitRate@K'])
        out[f'map_at_{k}'] = float(row['MAP@K'])
        out[f'ndcg_at_{k}'] = float(row['NDCG@K'])
        out[f'mrr_at_{k}'] = float(row['MRR@K'])
    out['n_users_evaluated'] = int(primary['Users'].iloc[0]) if len(primary) else 0
    return out
