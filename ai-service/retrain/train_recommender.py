"""Bước 2 — Train recommender, port trung thực từ ETL_CaNhan_2/Offline_recommender.ipynb.

Input : retrain/output/data/ (Places.csv + bộ rating_matrix_foody.*) — do export_training_data.py sinh.
Output: retrain/output/recommender_artifacts/ — đúng bộ file HybridRecommender.REQUIRED_ARTIFACTS:
    serve_manifest.json, cf_user_factors.npy, cf_item_factors.npy,
    cf_user_bias.npy, cf_item_bias.npy, cf_user_ids.csv, cf_item_ids.csv,
    cf_city_to_item_idx.pkl, cb_lookup_foody_rich.pkl
    (+ cf_item_latlon.npy, content_embeddings_foody_rich.npy, embedding_model_foody_rich.txt)

Khác biệt có chủ đích so với notebook:
- GridSearchCV chỉ chạy khi có cờ --grid-search HOẶC không tìm được best_svd_params
  của lần train trước (grid search 24 tổ hợp × 3 fold quá nặng để chạy hàng đêm).
- Luôn encode lại embedding (không cache) vì tập địa điểm thay đổi là lý do chạy pipeline.
- Ghi thêm metrics (val/test RMSE) + data_snapshot vào serve_manifest.json để
  retrain_pipeline.py làm quality gate và phát hiện thay đổi lần sau.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import os
import pickle
import random
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

import numpy as np
import pandas as pd
from scipy.sparse import csr_matrix, load_npz

from pipeline_config import OUTPUT_ARTIFACT_DIR, OUTPUT_DATA_DIR, ensure_dirs

EMBED_MODEL_NAME = "paraphrase-multilingual-MiniLM-L12-v2"
EMBED_FIELDS = [
    "name", "vibes", "district_old", "travel_type",
    "type_name", "category_name", "city_name", "description",
]
TOP_K_CB = 50
CB_EVAL_K = 10
CB_RELEVANCE_THRESHOLD = 4.0
DEFAULT_SVD_PARAMS = {"n_factors": 32, "n_epochs": 20, "lr_all": 0.005, "reg_all": 0.1}
CB_EMB_FILE = "content_embeddings_foody_rich.npy"
CB_EMB_META_FILE = "content_embedding_meta_foody_rich.csv"
CB_LOOKUP_FILE = "cb_lookup_foody_rich.pkl"
CB_LOOKUP_SIGNATURE_FILE = "cb_lookup_signature.txt"
EMB_MODEL_FILE = "embedding_model_foody_rich.txt"

# Retraining uses SentenceTransformer through PyTorch only. Some local environments
# also contain Keras 3; allowing transformers to auto-detect TensorFlow then raises
# an unnecessary tf-keras compatibility error before SentenceTransformer can load.
os.environ.setdefault("USE_TF", "0")
os.environ.setdefault("TRANSFORMERS_NO_TF", "1")


def _normalize_city_name(value) -> str:
    if pd.isna(value):
        return ""
    return str(value).strip()


def _col_or_blank(df: pd.DataFrame, name: str) -> pd.Series:
    if name in df.columns:
        return df[name]
    return pd.Series([""] * len(df), index=df.index)


def validate_training_dependencies() -> None:
    """Fail before expensive embedding work when a train-only package is missing."""
    missing: list[str] = []
    try:
        import sentence_transformers  # noqa: F401
    except ImportError:
        missing.append("sentence-transformers")
    try:
        import surprise  # noqa: F401
    except ImportError:
        missing.append("scikit-surprise")
    if missing:
        packages = " ".join(missing)
        raise SystemExit(
            "[train] Thiếu dependency: " + ", ".join(missing) + ". "
            f"Chạy: python -m pip install {packages}"
        )


# ────────────────────────── Load places (giống cell 5) ──────────────────────────

def load_places() -> pd.DataFrame:
    places = pd.read_csv(
        OUTPUT_DATA_DIR / "Places.csv", encoding="utf-8-sig", low_memory=False
    )
    places.columns = [c.strip() for c in places.columns]
    places["id"] = places["id"].astype(str).str.strip()
    places["city_name"] = _col_or_blank(places, "city_name").apply(_normalize_city_name)
    places["latitude"] = pd.to_numeric(_col_or_blank(places, "latitude"), errors="coerce")
    places["longitude"] = pd.to_numeric(_col_or_blank(places, "longitude"), errors="coerce")
    for c in ("name", "category_name", "type_name"):
        places[c] = _col_or_blank(places, c).fillna("").astype(str).str.strip()
    places = places[places["id"].astype(bool)].drop_duplicates("id").reset_index(drop=True)
    print(f"[train] places: {places.shape}, cities={places['city_name'].nunique()}")
    return places


# ────────────────────────── Content-Based (giống cell 7) ──────────────────────────

def build_content_text(places: pd.DataFrame) -> list[str]:
    series_by_col = {}
    for col in EMBED_FIELDS:
        s = _col_or_blank(places, col).fillna("").astype(str).str.strip()
        if col == "vibes":
            s = (
                s.str.replace(r'[\[\]"]', " ", regex=True)
                .str.replace(r"\s+", " ", regex=True)
                .str.strip()
            )
        series_by_col[col] = s.values
    arrays = [series_by_col[col] for col in EMBED_FIELDS]
    return [" - ".join([p for p in parts if p]) for parts in zip(*arrays)]


def _content_hash(text: str) -> str:
    return hashlib.sha1(text.encode("utf-8")).hexdigest()


def _load_cached_embeddings() -> dict[str, tuple[str, np.ndarray]]:
    emb_path = OUTPUT_ARTIFACT_DIR / CB_EMB_FILE
    meta_path = OUTPUT_ARTIFACT_DIR / CB_EMB_META_FILE
    model_path = OUTPUT_ARTIFACT_DIR / EMB_MODEL_FILE
    if not (emb_path.exists() and meta_path.exists() and model_path.exists()):
        return {}
    if model_path.read_text(encoding="utf-8").strip() != EMBED_MODEL_NAME:
        print("[train] Cache embedding dùng model khác -> bỏ qua cache.")
        return {}

    meta = pd.read_csv(meta_path, encoding="utf-8-sig")
    if not {"id", "content_hash"}.issubset(meta.columns):
        print("[train] Cache embedding meta thiếu cột -> bỏ qua cache.")
        return {}

    cached = np.load(emb_path).astype(np.float32)
    if len(meta) != cached.shape[0]:
        print("[train] Cache embedding không khớp meta -> bỏ qua cache.")
        return {}

    ids = meta["id"].astype(str).str.strip().values
    hashes = meta["content_hash"].astype(str).values
    return {pid: (h, cached[i]) for i, (pid, h) in enumerate(zip(ids, hashes))}


def train_content_based(places: pd.DataFrame) -> np.ndarray:
    from sentence_transformers import SentenceTransformer

    content_text = build_content_text(places)
    all_ids = places["id"].astype(str).str.strip().values
    content_hashes = [_content_hash(text) for text in content_text]

    cached = _load_cached_embeddings()
    reused = 0
    missing_idx: list[int] = []
    missing_text: list[str] = []
    cached_vectors: dict[int, np.ndarray] = {}

    for i, (pid, h) in enumerate(zip(all_ids, content_hashes)):
        hit = cached.get(str(pid))
        if hit and hit[0] == h:
            cached_vectors[i] = hit[1]
            reused += 1
        else:
            missing_idx.append(i)
            missing_text.append(content_text[i])

    print(
        f"[train] Embedding cache: reuse={reused}, encode_new_or_changed={len(missing_idx)}"
    )

    new_embeddings = None
    if missing_idx:
        print(f"[train] Encode embedding CB bằng {EMBED_MODEL_NAME}...")
        model = SentenceTransformer(EMBED_MODEL_NAME)
        new_embeddings = model.encode(
            missing_text, batch_size=64, show_progress_bar=True, normalize_embeddings=True
        ).astype(np.float32)

    if new_embeddings is not None:
        dim = int(new_embeddings.shape[1])
    elif cached_vectors:
        dim = int(next(iter(cached_vectors.values())).shape[0])
    else:
        raise RuntimeError("Không có embedding cache và cũng không có item cần encode.")

    embeddings = np.zeros((len(places), dim), dtype=np.float32)
    for i, vec in cached_vectors.items():
        embeddings[i] = vec
    if new_embeddings is not None:
        for j, i in enumerate(missing_idx):
            embeddings[i] = new_embeddings[j]

    city_arr = places["city_name"].values
    signature_payload = "\n".join(
        f"{pid}|{city}|{content_hash}"
        for pid, city, content_hash in zip(all_ids, city_arr, content_hashes)
    ) + f"\nmodel={EMBED_MODEL_NAME}|top_k={TOP_K_CB}"
    lookup_signature = hashlib.sha256(signature_payload.encode("utf-8")).hexdigest()
    signature_path = OUTPUT_ARTIFACT_DIR / CB_LOOKUP_SIGNATURE_FILE
    lookup_path = OUTPUT_ARTIFACT_DIR / CB_LOOKUP_FILE
    can_reuse_lookup = (
        lookup_path.exists()
        and signature_path.exists()
        and signature_path.read_text(encoding="utf-8").strip() == lookup_signature
    )

    cb_lookup: dict[str, list[str]] | None = None
    if can_reuse_lookup:
        print(f"[train] CB lookup cache hit: {len(all_ids)} items -> bỏ qua pre-compute.")
    else:
        print(f"[train] Pre-compute CB lookup (top-{TOP_K_CB}, cùng city)...")
    # Gom index theo city một lần để không quét toàn bộ mỗi item
    city_indices: dict[str, np.ndarray] = {}
    for city in pd.unique(city_arr):
        city_indices[city] = np.where(city_arr == city)[0]
    fallback_all = np.arange(len(places))

    if not can_reuse_lookup:
        cb_lookup = {}
        t0 = time.time()
        for i, rid in enumerate(all_ids):
            cand_idx = city_indices.get(city_arr[i], fallback_all)
            if city_arr[i] == "":
                cand_idx = fallback_all
            sim = embeddings[i] @ embeddings[cand_idx].T
            take = min(TOP_K_CB + 1, len(cand_idx))
            if take >= len(cand_idx):
                top_local = np.argsort(-sim)
            else:
                top_local = np.argpartition(-sim, take - 1)[:take]
                top_local = top_local[np.argsort(-sim[top_local])]
            cand_ids = all_ids[cand_idx[top_local]]
            cb_lookup[str(rid)] = cand_ids[cand_ids != rid][:TOP_K_CB].tolist()
            if (i + 1) % 5000 == 0 or i + 1 == len(all_ids):
                print(f"[train]   [{i + 1}/{len(all_ids)}] elapsed={time.time() - t0:.1f}s")

    np.save(OUTPUT_ARTIFACT_DIR / CB_EMB_FILE, embeddings)
    pd.DataFrame({"id": all_ids, "content_hash": content_hashes}).to_csv(
        OUTPUT_ARTIFACT_DIR / CB_EMB_META_FILE, index=False, encoding="utf-8-sig"
    )
    if cb_lookup is not None:
        with open(lookup_path, "wb") as f:
            pickle.dump(cb_lookup, f)
        signature_path.write_text(lookup_signature, encoding="utf-8")
    (OUTPUT_ARTIFACT_DIR / EMB_MODEL_FILE).write_text(
        EMBED_MODEL_NAME, encoding="utf-8"
    )
    print(f"[train] CB lookup: {len(all_ids)} items")
    return embeddings


# ────────────────────────── Funk-SVD (giống cell 9 + 10) ──────────────────────────

def train_cf(places: pd.DataFrame, grid_search: bool, prev_params: dict | None) -> dict:
    from surprise import SVD, Dataset, Reader, accuracy
    from surprise.model_selection import GridSearchCV

    R = load_npz(OUTPUT_DATA_DIR / "rating_matrix_foody.npz").astype(np.float32)
    # Chuẩn hóa về thang 5 sao rồi clip [0.5, 5.0] (như notebook)
    if R.nnz and float(R.data.max()) > 5.0:
        R.data = R.data / 2.0
    R.data = np.clip(R.data, 0.5, 5.0).astype(np.float32)
    R_csr = R.tocsr()

    cf_users = pd.read_csv(OUTPUT_DATA_DIR / "rating_matrix_foody_users.csv", encoding="utf-8-sig")
    cf_items = pd.read_csv(OUTPUT_DATA_DIR / "rating_matrix_foody_items.csv", encoding="utf-8-sig")
    cf_user_ids = cf_users.iloc[:, 0].astype(int).values
    cf_item_ids = cf_items.iloc[:, 0].astype(str).str.strip().values
    num_users, num_items = R_csr.shape
    print(f"[train] R: {R_csr.shape}, nnz={R_csr.nnz}")

    R_coo = R_csr.tocoo()
    df_ratings = pd.DataFrame(
        {"u_idx": R_coo.row, "i_idx": R_coo.col, "rating": R_coo.data}
    )
    reader = Reader(rating_scale=(0.5, 5.0))
    data = Dataset.load_from_df(df_ratings[["u_idx", "i_idx", "rating"]], reader)

    raw_ratings = list(data.raw_ratings)
    random.seed(42)
    random.shuffle(raw_ratings)
    total = len(raw_ratings)
    test_size = int(0.1 * total)
    val_size = int(0.1 * total)
    train_raw = raw_ratings[: total - test_size - val_size]
    val_raw = raw_ratings[total - test_size - val_size : total - test_size]
    test_raw = raw_ratings[total - test_size :]

    data.raw_ratings = train_raw
    train_set = data.build_full_trainset()
    val_set = data.construct_testset(val_raw)
    test_set = data.construct_testset(test_raw)
    print(f"[train] ratings: total={total}, train={len(train_raw)}, val={len(val_raw)}, test={len(test_raw)}")

    if grid_search or not prev_params:
        print("[train] GridSearchCV Funk-SVD (24 tổ hợp × 3 fold — sẽ lâu)...")
        param_grid = {
            "n_factors": [16, 32],
            "n_epochs": [10, 20],
            "lr_all": [0.002, 0.005],
            "reg_all": [0.05, 0.1, 0.2],
        }
        gs = GridSearchCV(SVD, param_grid, measures=["rmse"], cv=3, n_jobs=-1)
        gs.fit(data)
        best_params = gs.best_params["rmse"]
        print(f"[train] best_svd_params={best_params}")
    else:
        best_params = {k: prev_params[k] for k in ("n_factors", "n_epochs", "lr_all", "reg_all")}
        print(f"[train] Dùng lại best_svd_params lần trước: {best_params}")

    algo = SVD(**best_params)
    algo.fit(train_set)

    val_rmse = accuracy.rmse(algo.test(val_set), verbose=False)
    test_rmse = accuracy.rmse(algo.test(test_set), verbose=False)
    print(f"[train] RMSE: val={val_rmse:.4f}, test={test_rmse:.4f}")

    # Đồng bộ factors sang ma trận NumPy theo đúng thứ tự cf_user_ids/cf_item_ids
    P = np.zeros((num_users, algo.pu.shape[1]), dtype=np.float32)
    b_u = np.zeros(num_users, dtype=np.float32)
    for raw_u in range(num_users):
        try:
            inner_u = train_set.to_inner_uid(raw_u)
            P[raw_u] = algo.pu[inner_u]
            b_u[raw_u] = algo.bu[inner_u]
        except ValueError:
            pass
    Q = np.zeros((num_items, algo.qi.shape[1]), dtype=np.float32)
    b_i = np.zeros(num_items, dtype=np.float32)
    for raw_i in range(num_items):
        try:
            inner_i = train_set.to_inner_iid(raw_i)
            Q[raw_i] = algo.qi[inner_i]
            b_i[raw_i] = algo.bi[inner_i]
        except ValueError:
            pass

    np.save(OUTPUT_ARTIFACT_DIR / "cf_user_factors.npy", P)
    np.save(OUTPUT_ARTIFACT_DIR / "cf_item_factors.npy", Q)
    np.save(OUTPUT_ARTIFACT_DIR / "cf_user_bias.npy", b_u)
    np.save(OUTPUT_ARTIFACT_DIR / "cf_item_bias.npy", b_i)
    pd.DataFrame({"UserID": cf_user_ids}).to_csv(
        OUTPUT_ARTIFACT_DIR / "cf_user_ids.csv", index=False, encoding="utf-8-sig"
    )
    pd.DataFrame({"id": cf_item_ids}).to_csv(
        OUTPUT_ARTIFACT_DIR / "cf_item_ids.csv", index=False, encoding="utf-8-sig"
    )

    # city -> chỉ số item trong city (tối ưu CF khi serve) + lat/lon theo thứ tự item
    res2city = dict(zip(places["id"].values, places["city_name"].values))
    res2lat = dict(zip(places["id"].values, places["latitude"].values))
    res2lon = dict(zip(places["id"].values, places["longitude"].values))

    cf_item_city_names = np.array(
        [_normalize_city_name(res2city.get(str(rid), "")) for rid in cf_item_ids],
        dtype=object,
    )
    city_to_item_idx: dict[str, list[int]] = {}
    for i, cname in enumerate(cf_item_city_names):
        if not cname:
            continue
        city_to_item_idx.setdefault(cname, []).append(i)
    city_to_item_idx_np = {
        c: np.asarray(v, dtype=np.int32) for c, v in city_to_item_idx.items()
    }
    with open(OUTPUT_ARTIFACT_DIR / "cf_city_to_item_idx.pkl", "wb") as f:
        pickle.dump(city_to_item_idx_np, f)

    cf_item_latlon = np.stack(
        [
            np.array([res2lat.get(pid, np.nan) for pid in cf_item_ids], dtype=np.float32),
            np.array([res2lon.get(pid, np.nan) for pid in cf_item_ids], dtype=np.float32),
        ],
        axis=1,
    )
    np.save(OUTPUT_ARTIFACT_DIR / "cf_item_latlon.npy", cf_item_latlon)
    print(f"[train] city_to_item_idx: {len(city_to_item_idx_np)} city")

    return {
        "global_mean": float(train_set.global_mean),
        "num_users": int(num_users),
        "num_items": int(num_items),
        "n_factors": int(P.shape[1]),
        "best_svd_params": best_params,
        "val_rmse": float(val_rmse),
        "test_rmse": float(test_rmse),
        # Runtime-only objects used to evaluate rating + log on the exact same split.
        "_algo": algo,
        "_val_raw": val_raw,
        "_test_raw": test_raw,
        "_train_raw": train_raw,
        "_user_ids": cf_user_ids,
        "_item_ids": cf_item_ids,
    }


def evaluate_content_based_f1(
    cf: dict,
    k: int = CB_EVAL_K,
    relevance_threshold: float = CB_RELEVANCE_THRESHOLD,
) -> dict:
    """Evaluate item-to-item CB as a Top-K recommender on held-out positives.

    A user's positively-rated training items are used as content seeds. Candidate
    items receive reciprocal-rank votes from each seed's precomputed CB neighbour
    list; all training interactions are excluded. Relevance is defined only from
    held-out explicit ratings, so no test interaction leaks into recommendation.

    The reported F1 is micro-averaged across evaluable users, which weights every
    recommended/relevant item equally and remains well-defined for sparse users.
    """
    with open(OUTPUT_ARTIFACT_DIR / CB_LOOKUP_FILE, "rb") as f:
        cb_lookup: dict[str, list[str]] = pickle.load(f)

    user_ids, item_ids = cf["_user_ids"], cf["_item_ids"]

    def physical_ids(rows, positive_only: bool = False) -> dict[int, set[str]]:
        grouped: dict[int, set[str]] = {}
        for raw_u, raw_i, rating, _timestamp in rows:
            if positive_only and float(rating) < relevance_threshold:
                continue
            uid = int(user_ids[int(raw_u)])
            pid = str(item_ids[int(raw_i)])
            grouped.setdefault(uid, set()).add(pid)
        return grouped

    train_seen = physical_ids(cf["_train_raw"])
    train_positive = physical_ids(cf["_train_raw"], positive_only=True)
    test_positive = physical_ids(cf["_test_raw"], positive_only=True)

    true_positive = 0
    recommended_total = 0
    relevant_total = 0
    evaluated_users = 0
    per_user_f1: list[float] = []
    for uid, relevant in test_positive.items():
        seeds = train_positive.get(uid, set())
        if not seeds:
            continue

        seen = train_seen.get(uid, set())
        scores: dict[str, float] = {}
        for seed in seeds:
            for rank, candidate in enumerate(cb_lookup.get(seed, []), start=1):
                candidate = str(candidate)
                if candidate not in seen:
                    scores[candidate] = scores.get(candidate, 0.0) + 1.0 / rank
        if not scores:
            continue

        recommended = {
            pid for pid, _score in sorted(
                scores.items(), key=lambda pair: (-pair[1], pair[0])
            )[:k]
        }
        user_true_positive = len(recommended & relevant)
        user_precision = user_true_positive / len(recommended)
        user_recall = user_true_positive / len(relevant)
        user_f1 = (
            2.0 * user_precision * user_recall / (user_precision + user_recall)
            if user_precision + user_recall else 0.0
        )
        per_user_f1.append(user_f1)
        true_positive += user_true_positive
        recommended_total += len(recommended)
        relevant_total += len(relevant)
        evaluated_users += 1

    precision = true_positive / recommended_total if recommended_total else 0.0
    recall = true_positive / relevant_total if relevant_total else 0.0
    f1 = 2.0 * precision * recall / (precision + recall) if precision + recall else 0.0
    macro_f1 = float(np.mean(per_user_f1)) if per_user_f1 else 0.0
    metrics = {
        # Keep `f1` for backward compatibility; explicitly name its averaging too.
        "f1": float(f1),
        "micro_f1": float(f1),
        "macro_f1": macro_f1,
        "precision": float(precision),
        "recall": float(recall),
        "k": int(k),
        "relevance_threshold": float(relevance_threshold),
        "evaluated_users": int(evaluated_users),
        "test_positive_users": int(len(test_positive)),
        "user_coverage": (
            float(evaluated_users / len(test_positive)) if test_positive else 0.0
        ),
        "true_positives": int(true_positive),
        "recommended_items": int(recommended_total),
        "relevant_items": int(relevant_total),
    }
    print(
        f"[train] Content-Based F1@{k}: {f1:.6f} "
        f"(precision={precision:.6f}, recall={recall:.6f}, "
        f"users={evaluated_users}, relevant>={relevance_threshold:g})"
    )
    return metrics


def train_activity_cf(places: pd.DataFrame, params: dict) -> dict | None:
    """Train an independent CF model from the implicit activity matrix.

    The exporter has already aggregated, decayed and mapped log strength into
    [0.5, 5]. Keeping a separate model prevents views/clicks from changing the
    meaning of explicit ratings.
    """
    from surprise import SVD, Dataset, Reader

    required = (
        "activity_log_matrix.npz", "activity_log_users.csv",
        "activity_log_items.csv", "activity_log_user_confidence.csv",
    )
    output_names = (
        "log_user_factors.npy", "log_item_factors.npy", "log_user_bias.npy",
        "log_item_bias.npy", "log_user_ids.csv", "log_item_ids.csv",
        "log_user_confidence.csv", "log_city_to_item_idx.pkl",
    )
    if not all((OUTPUT_DATA_DIR / name).exists() for name in required):
        for name in output_names:
            (OUTPUT_ARTIFACT_DIR / name).unlink(missing_ok=True)
        print("[train] Không có activity matrix -> bỏ qua log CF.")
        return None

    matrix = load_npz(OUTPUT_DATA_DIR / "activity_log_matrix.npz").astype(np.float32).tocsr()
    if matrix.nnz == 0:
        for name in output_names:
            (OUTPUT_ARTIFACT_DIR / name).unlink(missing_ok=True)
        print("[train] Activity matrix rỗng -> bỏ qua log CF.")
        return None
    users = pd.read_csv(OUTPUT_DATA_DIR / "activity_log_users.csv").iloc[:, 0].astype(int).values
    items = pd.read_csv(OUTPUT_DATA_DIR / "activity_log_items.csv").iloc[:, 0].astype(str).str.strip().values
    coo = matrix.tocoo()
    frame = pd.DataFrame({"u_idx": coo.row, "i_idx": coo.col, "score": coo.data})
    data = Dataset.load_from_df(frame[["u_idx", "i_idx", "score"]], Reader(rating_scale=(0.5, 5.0)))
    trainset = data.build_full_trainset()
    algo = SVD(**params)
    algo.fit(trainset)

    factors = int(algo.pu.shape[1])
    P = np.zeros((len(users), factors), dtype=np.float32)
    Q = np.zeros((len(items), factors), dtype=np.float32)
    b_u = np.zeros(len(users), dtype=np.float32)
    b_i = np.zeros(len(items), dtype=np.float32)
    for raw_u in range(len(users)):
        try:
            inner = trainset.to_inner_uid(raw_u)
            P[raw_u], b_u[raw_u] = algo.pu[inner], algo.bu[inner]
        except ValueError:
            pass
    for raw_i in range(len(items)):
        try:
            inner = trainset.to_inner_iid(raw_i)
            Q[raw_i], b_i[raw_i] = algo.qi[inner], algo.bi[inner]
        except ValueError:
            pass

    np.save(OUTPUT_ARTIFACT_DIR / "log_user_factors.npy", P)
    np.save(OUTPUT_ARTIFACT_DIR / "log_item_factors.npy", Q)
    np.save(OUTPUT_ARTIFACT_DIR / "log_user_bias.npy", b_u)
    np.save(OUTPUT_ARTIFACT_DIR / "log_item_bias.npy", b_i)
    pd.DataFrame({"UserID": users}).to_csv(
        OUTPUT_ARTIFACT_DIR / "log_user_ids.csv", index=False, encoding="utf-8-sig"
    )
    pd.DataFrame({"id": items}).to_csv(
        OUTPUT_ARTIFACT_DIR / "log_item_ids.csv", index=False, encoding="utf-8-sig"
    )
    confidence = pd.read_csv(OUTPUT_DATA_DIR / "activity_log_user_confidence.csv")
    confidence.to_csv(OUTPUT_ARTIFACT_DIR / "log_user_confidence.csv", index=False, encoding="utf-8-sig")

    res2city = dict(zip(places["id"].astype(str), places["city_name"].astype(str)))
    city_idx: dict[str, list[int]] = {}
    for idx, pid in enumerate(items):
        city = _normalize_city_name(res2city.get(pid, ""))
        if city:
            city_idx.setdefault(city, []).append(idx)
    with open(OUTPUT_ARTIFACT_DIR / "log_city_to_item_idx.pkl", "wb") as f:
        pickle.dump({k: np.asarray(v, dtype=np.int32) for k, v in city_idx.items()}, f)

    print(f"[train] Log CF: {len(users)} users × {len(items)} items, nnz={matrix.nnz}")
    return {
        "global_mean": float(trainset.global_mean),
        "num_users": int(len(users)),
        "num_items": int(len(items)),
        "n_factors": factors,
        "_algo": algo,
        "_user_pos": {int(uid): idx for idx, uid in enumerate(users)},
        "_item_pos": {str(pid): idx for idx, pid in enumerate(items)},
        "_confidence": {
            int(row.UserID): max(0.0, min(1.0, float(row.confidence)))
            for row in confidence.itertuples()
        },
    }


def evaluate_hybrid_rmse(cf: dict, log_cf: dict | None, max_log_weight: float = 0.35) -> dict:
    """Evaluate the blend against held-out explicit ratings (never against logs)."""
    if not log_cf:
        return {
            "val_rmse": cf["val_rmse"], "test_rmse": cf["test_rmse"],
            "val_log_coverage": 0, "test_log_coverage": 0,
        }

    rating_algo = cf["_algo"]
    log_algo = log_cf["_algo"]
    user_ids, item_ids = cf["_user_ids"], cf["_item_ids"]
    log_users, log_items = log_cf["_user_pos"], log_cf["_item_pos"]
    confidence = log_cf["_confidence"]

    def score(rows):
        squared_errors = []
        covered = 0
        for raw_u, raw_i, actual, _timestamp in rows:
            rating_pred = float(rating_algo.predict(raw_u, raw_i).est)
            numeric_uid = int(user_ids[int(raw_u)])
            place_id = str(item_ids[int(raw_i)])
            if numeric_uid in log_users and place_id in log_items:
                log_pred = float(log_algo.predict(log_users[numeric_uid], log_items[place_id]).est)
                weight = max_log_weight * confidence.get(numeric_uid, 0.0)
                prediction = (1.0 - weight) * rating_pred + weight * log_pred
                covered += 1
            else:
                prediction = rating_pred
            prediction = float(np.clip(prediction, 0.5, 5.0))
            squared_errors.append((float(actual) - prediction) ** 2)
        rmse = math.sqrt(float(np.mean(squared_errors))) if squared_errors else float("nan")
        return rmse, covered

    val_rmse, val_coverage = score(cf["_val_raw"])
    test_rmse, test_coverage = score(cf["_test_raw"])
    print(
        f"[train] Hybrid RMSE (rating + log): val={val_rmse:.4f}, test={test_rmse:.4f}; "
        f"log coverage={val_coverage}/{len(cf['_val_raw'])}, {test_coverage}/{len(cf['_test_raw'])}"
    )
    return {
        "val_rmse": float(val_rmse), "test_rmse": float(test_rmse),
        "val_log_coverage": int(val_coverage), "test_log_coverage": int(test_coverage),
    }


# ────────────────────────── Manifest (giống cell 10) ──────────────────────────

def write_manifest(
    cf: dict,
    log_cf: dict | None = None,
    hybrid_metrics: dict | None = None,
    cb_metrics: dict | None = None,
) -> None:
    snapshot = {}
    snap_file = OUTPUT_DATA_DIR / "snapshot.json"
    if snap_file.exists():
        snapshot = json.loads(snap_file.read_text(encoding="utf-8"))

    manifest = {
        "global_mean": cf["global_mean"],
        "num_users": cf["num_users"],
        "num_items": cf["num_items"],
        "n_factors": cf["n_factors"],
        "rating_scale": [0.5, 5.0],
        "best_svd_params": cf["best_svd_params"],
        "embedding_model": EMBED_MODEL_NAME,
        "embed_fields": EMBED_FIELDS,
        "hybrid_defaults": {
            "model_weight": 0.75,
            "distance_weight": 0.25,
            "distance_decay_km": 5.0,
            "cb_k": 50,
            "cf_k": 50,
            "rating_cf_weight": 0.65,
            "log_cf_weight": 0.35,
        },
        "artifacts": {
            "user_factors": "cf_user_factors.npy",
            "item_factors": "cf_item_factors.npy",
            "user_bias": "cf_user_bias.npy",
            "item_bias": "cf_item_bias.npy",
            "user_ids": "cf_user_ids.csv",
            "item_ids": "cf_item_ids.csv",
            "city_to_item_idx": "cf_city_to_item_idx.pkl",
            "item_latlon": "cf_item_latlon.npy",
            "cb_lookup": "cb_lookup_foody_rich.pkl",
            "content_embeddings": "content_embeddings_foody_rich.npy",
        },
        "raw_inputs": {
            "places_csv": "Places.csv",
            "rating_matrix": "rating_matrix_foody.npz",
        },
        # ── Phần thêm bởi retrain pipeline (không ảnh hưởng serving) ──
        "trained_at": datetime.now(timezone.utc).isoformat(),
        "metrics": {
            "val_rmse": (hybrid_metrics or {}).get("val_rmse", cf["val_rmse"]),
            "test_rmse": (hybrid_metrics or {}).get("test_rmse", cf["test_rmse"]),
            "rating_only_val_rmse": cf["val_rmse"],
            "rating_only_test_rmse": cf["test_rmse"],
            "hybrid_log_coverage_val": (hybrid_metrics or {}).get("val_log_coverage", 0),
            "hybrid_log_coverage_test": (hybrid_metrics or {}).get("test_log_coverage", 0),
            "content_based": cb_metrics or {},
        },
        "data_snapshot": snapshot,
    }
    if log_cf:
        manifest["log_cf"] = {
            "global_mean": log_cf["global_mean"],
            "num_users": log_cf["num_users"],
            "num_items": log_cf["num_items"],
            "n_factors": log_cf["n_factors"],
            "max_weight": 0.35,
            "artifacts": {
                "user_factors": "log_user_factors.npy",
                "item_factors": "log_item_factors.npy",
                "user_bias": "log_user_bias.npy",
                "item_bias": "log_item_bias.npy",
                "user_ids": "log_user_ids.csv",
                "item_ids": "log_item_ids.csv",
                "user_confidence": "log_user_confidence.csv",
                "city_to_item_idx": "log_city_to_item_idx.pkl",
            },
        }
    with open(OUTPUT_ARTIFACT_DIR / "serve_manifest.json", "w", encoding="utf-8") as f:
        json.dump(manifest, f, ensure_ascii=False, indent=2)
    print("[train] ✅ serve_manifest.json đã ghi")


def main(grid_search: bool = False, prev_manifest: Path | None = None) -> dict:
    ensure_dirs()
    validate_training_dependencies()
    for f in ("Places.csv", "rating_matrix_foody.npz",
              "rating_matrix_foody_users.csv", "rating_matrix_foody_items.csv"):
        if not (OUTPUT_DATA_DIR / f).exists():
            raise SystemExit(f"[train] Thiếu {f} — chạy export_training_data.py trước.")

    prev_params = None
    if prev_manifest and prev_manifest.exists():
        try:
            prev = json.loads(prev_manifest.read_text(encoding="utf-8"))
            prev_params = prev.get("best_svd_params") or DEFAULT_SVD_PARAMS
        except Exception:
            prev_params = DEFAULT_SVD_PARAMS

    places = load_places()
    train_content_based(places)
    cf = train_cf(places, grid_search=grid_search, prev_params=prev_params)
    cb_metrics = evaluate_content_based_f1(cf)
    log_cf = train_activity_cf(places, cf["best_svd_params"])
    hybrid_metrics = evaluate_hybrid_rmse(cf, log_cf, max_log_weight=0.35)
    write_manifest(cf, log_cf, hybrid_metrics, cb_metrics)
    cf["log_cf"] = log_cf
    return cf


if __name__ == "__main__":
    try:
        sys.stdout.reconfigure(encoding="utf-8")
    except Exception:
        pass
    ap = argparse.ArgumentParser()
    ap.add_argument("--grid-search", action="store_true",
                    help="Chạy lại GridSearchCV thay vì dùng best_svd_params cũ")
    ap.add_argument("--prev-manifest", type=Path, default=None,
                    help="Đường dẫn serve_manifest.json của bản đang chạy")
    args = ap.parse_args()
    main(grid_search=args.grid_search, prev_manifest=args.prev_manifest)
