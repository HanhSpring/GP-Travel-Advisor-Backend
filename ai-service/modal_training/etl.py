"""ETL -- port co hoc (khong doi logic) tu Cell "1a" -> "1f" cua
train/two_tower_recommender_15_finetune.ipynb (Section 1 - ETL & Chia tap du lieu).

Diem khac duy nhat so voi notebook: khong co ETL cache o day (Modal la container moi/stateless
moi lan chay -- xem docs/trigger/06-modal-primary-plan.md), nen luon chay full ETL tren du lieu
duoc tai ve boi data_io.download_dataset(). Vi INCLUDE_YELP=False khi finetune (mac dinh), tong so
dong ETL nho hon nhieu so voi pretrain full (Foody+Supabase ~218k dong so voi Yelp+Foody ~1.17M).
"""
from __future__ import annotations

import gc
from pathlib import Path
from typing import Any

import numpy as np
import pandas as pd

from .config import Config


# ---------------------------------------------------------------------------
# Cell "1a" -- Load du lieu tu local (Yelp + Foody + Supabase, normalize schema)
# ---------------------------------------------------------------------------

def load_and_normalize_business(filepath: Path, emb_filepath: Path | None = None) -> pd.DataFrame:
    df = pd.read_json(filepath, lines=True)
    if 'business_id' in df.columns and 'id' not in df.columns:
        df = df.rename(columns={'business_id': 'id'})
    if 'embedding' in df.columns and 'bge_embedding' not in df.columns:
        df = df.rename(columns={'embedding': 'bge_embedding'})
    if 'travel_type' not in df.columns:
        df['travel_type'] = None

    if emb_filepath is not None and emb_filepath.exists():
        _npz = np.load(emb_filepath)
        _emb_lookup = dict(zip(_npz['ids'], _npz['embeddings']))
        df['bge_embedding'] = df['id'].astype(str).map(_emb_lookup)

    return df


def load_and_normalize_reviews(filepath: Path) -> pd.DataFrame:
    df = pd.read_json(filepath, lines=True)
    if 'business_id' in df.columns and 'id' not in df.columns:
        df = df.rename(columns={'business_id': 'id'})
    if 'date' in df.columns:
        if df['date'].dtype in ['int64', 'float64']:
            df['date'] = pd.to_datetime(df['date'], unit='ms')
        else:
            df['date'] = pd.to_datetime(df['date'])
    return df


def load_raw(dataset_dir: Path, include_yelp: bool) -> tuple[pd.DataFrame, pd.DataFrame]:
    """Cell 1a -- tra ve (df_biz, df_rev) da gop Yelp (tuy chon) + Foody (tuy chon) + Supabase
    (tuy chon). Ten file giu nguyen dung notebook de tai su dung dung 1 bo file tren R2."""
    yelp_business_file     = dataset_dir / 'embedded_yelp_business_tourism_current.jsonl'
    yelp_business_emb_file = dataset_dir / 'embedded_yelp_business_tourism_current.npz'
    yelp_review_file       = dataset_dir / 'two_tower_training_data_v3_current_renamed.jsonl'
    foody_business_file     = dataset_dir / 'embedded_foody_training_places_current.jsonl'
    foody_business_emb_file = dataset_dir / 'embedded_foody_training_places_current.npz'
    foody_review_file       = dataset_dir / 'foody_two_tower_training_data_with_place_id_current.jsonl'
    supabase_business_file  = dataset_dir / 'supabase_business_current.jsonl'
    supabase_business_emb_file = dataset_dir / 'supabase_business_current.npz'
    supabase_review_file    = dataset_dir / 'supabase_interactions_current.jsonl'

    biz_list: list[pd.DataFrame] = []
    rev_list: list[pd.DataFrame] = []

    # Load Yelp (bo qua neu include_yelp=False -- dang finetune, da warm-start tu checkpoint da
    # hoc Yelp roi, khong can "replay" lai moi lan finetune, xem two_tower_train.py::run_training()).
    if include_yelp:
        print('Loading Yelp business ...')
        df_yelp_biz = load_and_normalize_business(yelp_business_file, yelp_business_emb_file)
        print(f'  yelp business: {df_yelp_biz.shape}')
        print('Loading Yelp reviews ...')
        df_yelp_rev = load_and_normalize_reviews(yelp_review_file)
        print(f'  yelp reviews : {df_yelp_rev.shape}')
        biz_list.append(df_yelp_biz)
        rev_list.append(df_yelp_rev)
    else:
        print('include_yelp=False -- bo qua Yelp (dang finetune, da warm-start tu checkpoint da hoc Yelp).')

    if foody_business_file.exists() and foody_review_file.exists():
        print('Loading Foody business ...')
        df_foody_biz = load_and_normalize_business(foody_business_file, foody_business_emb_file)
        print(f'  foody business: {df_foody_biz.shape}')
        print('Loading Foody reviews ...')
        df_foody_rev = load_and_normalize_reviews(foody_review_file)
        print(f'  foody reviews : {df_foody_rev.shape}')
        biz_list.append(df_foody_biz)
        rev_list.append(df_foody_rev)
    else:
        print('Foody files not found -- bo qua.')

    if supabase_review_file.exists():
        print('Loading Supabase (that) reviews ...')
        df_supabase_rev = load_and_normalize_reviews(supabase_review_file)
        print(f'  supabase reviews : {df_supabase_rev.shape}')
        rev_list.append(df_supabase_rev)

        if supabase_business_file.exists():
            print('Loading Supabase (that) business (bo sung dia diem chua co trong Foody) ...')
            df_supabase_biz = load_and_normalize_business(supabase_business_file, supabase_business_emb_file)
            print(f'  supabase business: {df_supabase_biz.shape}')
            biz_list.append(df_supabase_biz)
    else:
        print('Supabase files not found -- chua co du lieu that.')

    if not biz_list or not rev_list:
        raise RuntimeError(
            'Khong co nguon du lieu nao de train (include_yelp=False va khong co Foody/Supabase). '
            'Kiem tra lai dataset_dir hoac bat include_yelp=True.'
        )

    df_biz = pd.concat(biz_list, ignore_index=True).drop_duplicates(subset=['id'])
    df_rev = pd.concat(rev_list, ignore_index=True)
    print(f'Total businesses : {len(df_biz):,}  (unique id: {df_biz["id"].nunique():,})')
    print(f'Total reviews    : {len(df_rev):,}')
    return df_biz, df_rev


# ---------------------------------------------------------------------------
# Cell "1b" -- Thong nhat Schema (Yelp -> Foody-canonical)
# ---------------------------------------------------------------------------

def unify_business_schema(df: pd.DataFrame) -> pd.DataFrame:
    df = df.copy()

    if 'city_name' in df.columns:
        df['city'] = df['city_name'].fillna(df['city']) if 'city' in df.columns else df['city_name']
        df = df.drop(columns=['city_name'])

    if 'category_name' in df.columns:
        df['category'] = df['category_name'].fillna(df['category']) if 'category' in df.columns else df['category_name']
        df = df.drop(columns=['category_name'])

    def merge_types(row):
        foody_type = row.get('type_name', None)
        yelp_types = row.get('types', None)
        if isinstance(foody_type, str) and foody_type.strip():
            return [foody_type.strip()]
        if isinstance(yelp_types, (list, np.ndarray)) and len(yelp_types) > 0:
            return [str(t) for t in yelp_types if str(t).strip()]
        return []

    df['types'] = df.apply(merge_types, axis=1)
    if 'type_name' in df.columns:
        df = df.drop(columns=['type_name'])

    if 'average_rating' in df.columns:
        df['stars'] = df['average_rating'].fillna(df['stars']) if 'stars' in df.columns else df['average_rating']
        df = df.drop(columns=['average_rating'])

    if 'embedding' in df.columns and 'bge_embedding' not in df.columns:
        df = df.rename(columns={'embedding': 'bge_embedding'})

    if 'vibes' in df.columns:
        df['vibes'] = df['vibes'].apply(
            lambda x: [str(v) for v in x if str(v).strip()] if isinstance(x, (list, np.ndarray)) else []
        )

    for col in ['city', 'category', 'travel_type', 'combined_text', 'name', 'address']:
        if col in df.columns:
            df[col] = df[col].fillna('')

    drop_cols = [
        'attributes', 'hours', 'is_open', 'is_tourism',
        'categories', 'categories_vi', 'vibes_source', 'postal_code', 'state',
        'is_approved', 'is_active', 'registered_date', 'vendor_id',
        'image_url', 'updated_at', 'city_id', 'source_id', 'source',
        'type_id', 'place_url', 'district_old', 'visit_duration',
        'open_time', 'close_time', 'description', 'open_hour_compressed',
    ]
    drop_cols = [c for c in drop_cols if c in df.columns]
    df = df.drop(columns=drop_cols)
    return df


REQUIRED_BUSINESS_COLS = ['id', 'city', 'category', 'types', 'vibes', 'stars', 'bge_embedding', 'travel_type']


# ---------------------------------------------------------------------------
# Cell "1b" -- Loc & Merge
# ---------------------------------------------------------------------------

def filter_and_merge(df_biz: pd.DataFrame, df_rev: pd.DataFrame) -> pd.DataFrame:
    if 'sentiment_label' in df_rev.columns:
        df_rev_pos = df_rev[df_rev['sentiment_label'] == 'POS'].copy()
        print(f'Reviews after sentiment_label==POS: {len(df_rev_pos):,}')
    else:
        df_rev_pos = df_rev[df_rev['stars'] >= 3].copy()
        print(f'Reviews after stars >= 3: {len(df_rev_pos):,}')

    valid_ids = set(df_biz['id'])
    df_rev_pos = df_rev_pos[df_rev_pos['id'].isin(valid_ids)]
    print(f'Reviews after id validation: {len(df_rev_pos):,}')

    df_rev_pos = df_rev_pos.rename(columns={'stars': 'stars_review'})

    biz_cols = ['id', 'city', 'category', 'types', 'vibes', 'travel_type', 'stars', 'review_count', 'bge_embedding']
    available = [c for c in biz_cols if c in df_biz.columns]
    df_biz_sub = df_biz[available].rename(columns={'stars': 'stars_biz'})

    df = df_rev_pos.merge(df_biz_sub, on='id', how='inner')
    print(f'After merge shape: {df.shape}')
    return df


# ---------------------------------------------------------------------------
# Cell "1c" -- Power-user cap & Sap xep (vectorized -- xem lich su sua trong finetune notebook)
# ---------------------------------------------------------------------------

def apply_power_user_cap(df: pd.DataFrame) -> pd.DataFrame:
    df = df.sort_values(['user_id', 'date']).reset_index(drop=True)
    df = df.groupby('user_id', group_keys=False).tail(Config.MAX_TRAIN_SAMPLES).reset_index(drop=True)
    print(f'After power-user cap ({Config.MAX_TRAIN_SAMPLES}/user): {len(df):,} rows')
    return df


# ---------------------------------------------------------------------------
# Cell "1d" -- Xay dung History Features (No-Leakage, single-pass tren toan bo df)
# ---------------------------------------------------------------------------
#
# Ban cu dung df.groupby('user_id') roi tao 1 sub-DataFrame + list rieng cho MOI user (hang chuc
# nghin group, rat nhieu user chi co 1-2 dong) -- overhead tao/concat DataFrame per-group la nguon
# cham chinh (~14 phut/197k dong do), khong phai do khoi luong du lieu. History van phai tich luy
# tuan tu (list do dai bien doi) nen khong the vector-hoa hoan toan bang numpy, nhung CO the di 1
# vong duy nhat qua toan bo df (thay vi hang chuc nghin lan groupby-DataFrame), reset accumulator
# moi khi user_id doi -- yeu cau df da duoc sort theo ['user_id', 'date'] (apply_power_user_cap da
# lam dieu nay), nen moi block cua 1 user luon lien tuc (contiguous).

def build_history_features(df: pd.DataFrame) -> pd.DataFrame:
    df = df.reset_index(drop=True)

    user_id_col = df['user_id'].tolist()
    types_col   = df['types'].tolist() if 'types' in df.columns else [[]] * len(df)
    vibes_col   = df['vibes'].tolist() if 'vibes' in df.columns else [[]] * len(df)
    id_col      = df['id'].astype(str).tolist()

    history_types_list, history_vibes_list, history_biz_list = [], [], []
    accumulated_types: list[str] = []
    accumulated_vibes: list[str] = []
    accumulated_biz: list[str] = []
    prev_uid: Any = object()  # sentinel khong khop bat ky user_id nao o dong dau tien

    for uid, types_val, vibes_val, id_val in zip(user_id_col, types_col, vibes_col, id_col):
        if uid != prev_uid:
            accumulated_types = []
            accumulated_vibes = []
            accumulated_biz = []
            prev_uid = uid

        history_types_list.append(list(accumulated_types))
        history_vibes_list.append(list(accumulated_vibes))
        history_biz_list.append(list(accumulated_biz))

        if not isinstance(types_val, (list, tuple)):
            types_val = []
        if not isinstance(vibes_val, (list, tuple)):
            vibes_val = []

        accumulated_types.extend(types_val)
        accumulated_vibes.extend(vibes_val)
        accumulated_biz.append(id_val)

    df['history_types']       = history_types_list
    df['history_vibes']       = history_vibes_list
    df['history_business_id'] = history_biz_list
    df['current_city']        = df['city']
    if 'review_id' in df.columns:
        df['review_id'] = df['review_id'].astype(str)
    if 'user_id' in df.columns:
        df['user_id'] = df['user_id'].astype(str)
    return df


# ---------------------------------------------------------------------------
# Cell "1e" -- Temporal Split (80% Train - 10% Val - 10% Test)
# ---------------------------------------------------------------------------
#
# Ban cu lap qua tung group user_id, slice group.iloc[...] roi pd.concat -- cung overhead
# per-group nhu build_history_features. Vector-hoa bang groupby(...).transform('size')/cumcount()
# (Cython, khong phai vong lap Python cap-group) de tinh (n, rank) cho tung dong 1 luc, roi gan
# nhan train/val/test bang boolean mask -- KHONG doi cong thuc chia (van dung int()-truncation
# nhu ban cu, thay bang np.trunc de dam bao ra dung so nguyen giong het truoc).

def temporal_split(df: pd.DataFrame) -> tuple[pd.DataFrame, pd.DataFrame, pd.DataFrame]:
    df = df.reset_index(drop=True)
    sizes = df.groupby('user_id')['user_id'].transform('size').to_numpy()
    rank  = df.groupby('user_id').cumcount().to_numpy()

    n_train_5 = np.trunc(sizes * 0.8).astype(np.int64)
    n_val_5   = np.maximum(1, np.trunc((sizes - n_train_5) / 2).astype(np.int64))

    split = np.empty(len(df), dtype=object)

    mask_ge5 = sizes >= 5
    split[mask_ge5 & (rank < n_train_5)] = 'train'
    split[mask_ge5 & (rank >= n_train_5) & (rank < n_train_5 + n_val_5)] = 'val'
    split[mask_ge5 & (rank >= n_train_5 + n_val_5)] = 'test'

    mask_34 = (sizes >= 3) & (sizes < 5)
    split[mask_34 & (rank < sizes - 2)] = 'train'
    split[mask_34 & (rank == sizes - 2)] = 'val'
    split[mask_34 & (rank == sizes - 1)] = 'test'

    mask_2 = sizes == 2
    split[mask_2 & (rank == 0)] = 'train'
    split[mask_2 & (rank == 1)] = 'val'

    split[sizes == 1] = 'train'

    assert not (split == None).any(), 'BUG: co dong chua duoc gan nhan train/val/test'  # noqa: E711

    df_train = df[split == 'train'].reset_index(drop=True)
    df_val   = df[split == 'val'].reset_index(drop=True)
    df_test  = df[split == 'test'].reset_index(drop=True)

    print(f'Train : {len(df_train):,} rows, {df_train["user_id"].nunique():,} users')
    print(f'Val   : {len(df_val):,} rows,   {df_val["user_id"].nunique():,} users')
    print(f'Test  : {len(df_test):,} rows,   {df_test["user_id"].nunique():,} users')

    # Temporal leakage check -- giong het notebook, KHONG bo qua trong pipeline tu dong.
    train_last_date = df_train.groupby('user_id')['date'].max().rename('train_max_date')
    test_check = df_test[['user_id', 'date']].join(train_last_date, on='user_id')
    test_check = test_check.dropna(subset=['train_max_date'])
    violations = test_check[test_check['date'] < test_check['train_max_date']]
    assert len(violations) == 0, f'LOI NGHIEM TRONG: {len(violations)} dong du lieu tuong lai bi ro ri vao Train!'
    print('Temporal integrity check PASSED.')

    return df_train, df_val, df_test


# ---------------------------------------------------------------------------
# Cell "1f" -- Tinh example_weight, chuan bi df_candidates
# ---------------------------------------------------------------------------

def _compute_sqrt_smoothed_weights(series: pd.Series) -> dict:
    counts = series.value_counts()
    total, n_classes = len(series), len(counts)
    raw_w = {v: np.sqrt(total / (n_classes * cnt)) for v, cnt in counts.items()}
    mean_w = np.mean(list(raw_w.values()))
    return {v: w / mean_w for v, w in raw_w.items()}


def compute_example_weights(df_train: pd.DataFrame, df_val: pd.DataFrame, df_test: pd.DataFrame) -> None:
    """Sua doi in-place df_train/df_val/df_test (them cot example_weight) -- giong het notebook."""
    category_weights    = _compute_sqrt_smoothed_weights(df_train['category'])
    travel_type_weights = _compute_sqrt_smoothed_weights(df_train['travel_type'])
    trip_intent_weights = _compute_sqrt_smoothed_weights(df_train['trip_intent'])
    clip_min, clip_max = Config.CATEGORY_WEIGHT_CLIP

    # v15-finetune fix: clip TUNG truc TRUOC khi nhan (khong clip SAU khi nhan 3 truc). Nhan 3
    # truc doc lap khien phuong sai tich no ra manh hon nhieu so voi 1 truc don -- neu van clip
    # ca tich ve (clip_min, clip_max) nhu truoc, gan nhu toan bo dong luc reweighting bi ep phang.
    _cat_w = df_train['category'].map(category_weights).fillna(1.0).clip(clip_min, clip_max)
    _tt_w  = df_train['travel_type'].map(travel_type_weights).fillna(1.0).clip(clip_min, clip_max)
    _ti_w  = df_train['trip_intent'].map(trip_intent_weights).fillna(1.0).clip(clip_min, clip_max)

    _weight_before_clip = _cat_w * _tt_w * _ti_w
    _weight_before_clip = _weight_before_clip / _weight_before_clip.mean()
    _combo_clip_min, _combo_clip_max = clip_min ** 3, clip_max ** 3
    df_train['example_weight'] = _weight_before_clip.clip(_combo_clip_min, _combo_clip_max).astype('float32')
    df_val['example_weight']  = 1.0
    df_test['example_weight'] = 1.0


def build_candidates(df_biz: pd.DataFrame) -> pd.DataFrame:
    df_candidates = df_biz.copy()
    if 'stars' in df_candidates.columns and 'stars_biz' not in df_candidates.columns:
        df_candidates = df_candidates.rename(columns={'stars': 'stars_biz'})

    def _impute_missing_numeric(df, col, group_cols_list):
        filled = df[col].astype('float32')
        for group_cols in group_cols_list:
            group_mean = df.groupby(group_cols)[col].transform('mean')
            filled = filled.fillna(group_mean)
        return filled.fillna(df[col].mean())

    n_missing_stars = int(df_candidates['stars_biz'].isna().sum())
    n_missing_rc    = int(df_candidates['review_count'].isna().sum())
    if n_missing_stars or n_missing_rc:
        df_candidates['stars_biz'] = _impute_missing_numeric(df_candidates, 'stars_biz', [['city', 'category'], ['category']])
        df_candidates['review_count'] = _impute_missing_numeric(df_candidates, 'review_count', [['city', 'category'], ['category']])
        print(f'Da impute {n_missing_stars:,} stars_biz / {n_missing_rc:,} review_count con thieu.')

    return df_candidates


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------

def run_etl(dataset_dir: Path, include_yelp: bool) -> tuple[pd.DataFrame, pd.DataFrame, pd.DataFrame, pd.DataFrame]:
    """Chay toan bo pipeline ETL (Cell 1a -> 1f), tra ve (df_train, df_val, df_test, df_candidates)."""
    df_biz, df_rev = load_raw(dataset_dir, include_yelp)

    df_biz = unify_business_schema(df_biz)
    for req in REQUIRED_BUSINESS_COLS:
        assert req in df_biz.columns, f"Missing required column: '{req}'"

    df = filter_and_merge(df_biz, df_rev)
    df = apply_power_user_cap(df)
    df = build_history_features(df)
    gc.collect()

    df_train, df_val, df_test = temporal_split(df)
    compute_example_weights(df_train, df_val, df_test)
    df_candidates = build_candidates(df_biz)

    return df_train, df_val, df_test, df_candidates
