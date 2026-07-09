"""Bước 1 — Export dữ liệu training từ Supabase.

Sinh ra trong `retrain/output/data/`:
    Places.csv                      — mọi địa điểm is_approved + is_active (kèm cột embedding)
    rating_matrix_foody.npz         — CSR (users × items), gộp Foody lịch sử + review thật từ DB
    rating_matrix_foody_users.csv   — UserID (int) theo HÀNG
    rating_matrix_foody_items.csv   — place id (UUID) theo CỘT
    snapshot.json                   — số liệu chụp lúc export (phục vụ phát hiện thay đổi)

User thật (tourist_id UUID) được cấp id số ổn định qua `state/tourist_user_map.csv`
(bắt đầu từ 1_000_000_000) — chạy nhiều lần vẫn giữ nguyên id đã cấp.
"""

from __future__ import annotations

import json
import sys
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path

import numpy as np
import pandas as pd
from scipy.sparse import csr_matrix, save_npz

from pipeline_config import (
    OUTPUT_DATA_DIR,
    TOURIST_MAP_FILE,
    TOURIST_NUMERIC_ID_BASE,
    ensure_dirs,
    load_env,
)

# Supabase/PostgREST can timeout on large nested travel.places exports. The
# retrain job runs offline, so prefer smaller pages and a narrow column set.
PAGE_SIZE = 100


def _client(cfg):
    from supabase import create_client

    if not cfg["supabase_url"] or not cfg["supabase_key"]:
        raise SystemExit(
            "Thiếu SUPABASE_URL / SUPABASE_KEY — kiểm tra ai-service/.env "
            "hoặc retrain/.env.retrain"
        )
    return create_client(cfg["supabase_url"], cfg["supabase_key"])


def _fetch_all(query_builder_factory) -> list[dict]:
    """Kéo toàn bộ rows theo trang (PostgREST giới hạn ~1000 row/lần)."""
    rows: list[dict] = []
    page = 0
    while True:
        start = page * PAGE_SIZE
        resp = query_builder_factory().range(start, start + PAGE_SIZE - 1).execute()
        batch = resp.data or []
        rows.extend(batch)
        if len(batch) < PAGE_SIZE:
            return rows
        page += 1


# ────────────────────────────── Places ──────────────────────────────

def export_places(sb) -> pd.DataFrame:
    print("[export] Đang kéo travel.places từ Supabase...")
    rows = _fetch_all(
        lambda: sb.schema("travel")
        .table("places")
        .select(
            "id, name, latitude, longitude, vibes, description, "
            "cities(name), types(name, categories(name))"
        )
        .eq("is_approved", True)
        .eq("is_active", True)
    )
    print(f"[export]   {len(rows)} địa điểm")

    records = []
    for r in rows:
        cities = r.get("cities") or {}
        types_ = r.get("types") or {}
        categories = (types_ or {}).get("categories") or {}
        records.append(
            {
                # Các cột hybrid_recommender._meta + notebook cần
                "id": str(r.get("id", "")).strip(),
                "name": r.get("name") or "",
                "city_name": (cities.get("name") or "").strip(),
                "latitude": r.get("latitude"),
                "longitude": r.get("longitude"),
                "category_name": categories.get("name") or "",
                "type_name": types_.get("name") or "",
                # Các cột phục vụ embedding CB (thiếu trong DB thì để rỗng,
                # train script xử lý an toàn giống notebook _col_or_blank)
                "vibes": r.get("vibes") or "",
                "district_old": r.get("district_old") or "",
                "travel_type": r.get("travel_type") or "",
                "description": r.get("description") or "",
            }
        )

    places = pd.DataFrame.from_records(records)
    places = places[places["id"].astype(bool)].drop_duplicates("id")
    out = OUTPUT_DATA_DIR / "Places.csv"
    places.to_csv(out, index=False, encoding="utf-8-sig")
    print(f"[export]   → {out} ({len(places)} dòng)")
    return places


# ────────────────────────────── Ratings ──────────────────────────────

def _load_foody_jsonl(path: Path) -> list[tuple[int, str, float]]:
    """Ratings Foody lịch sử: (user_id int, place_id uuid, stars)."""
    if not path.exists():
        print(f"[export] ⚠ Không thấy {path} — bỏ qua ratings Foody lịch sử")
        return []
    triples = []
    with path.open(encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            r = json.loads(line)
            try:
                triples.append((int(r["user_id"]), str(r["id"]).strip(), float(r["stars"])))
            except (KeyError, TypeError, ValueError):
                continue
    print(f"[export]   {len(triples)} ratings Foody lịch sử từ {path.name}")
    return triples


def _load_tourist_map() -> dict[str, int]:
    if not TOURIST_MAP_FILE.exists():
        return {}
    df = pd.read_csv(TOURIST_MAP_FILE, dtype={"tourist_id": str, "numeric_id": int})
    return dict(zip(df["tourist_id"], df["numeric_id"]))


def _save_tourist_map(mapping: dict[str, int]) -> None:
    pd.DataFrame(
        {"tourist_id": list(mapping.keys()), "numeric_id": list(mapping.values())}
    ).to_csv(TOURIST_MAP_FILE, index=False, encoding="utf-8-sig")


def export_db_reviews(sb) -> tuple[list[tuple[int, str, float]], int, str]:
    """Review thật từ review_ai.reviews → (triples, tổng số review, max created_at)."""
    print("[export] Đang kéo review_ai.reviews từ Supabase...")
    rows = _fetch_all(
        lambda: sb.schema("review_ai")
        .table("reviews")
        .select("tourist_id, place_id, rating, created_at")
        .order("created_at")
    )
    print(f"[export]   {len(rows)} review thật")

    mapping = _load_tourist_map()
    next_id = (
        max(mapping.values()) + 1 if mapping else TOURIST_NUMERIC_ID_BASE
    )
    triples: list[tuple[int, str, float]] = []
    max_created = ""
    for r in rows:
        tid = str(r.get("tourist_id") or "").strip()
        pid = str(r.get("place_id") or "").strip()
        rating = r.get("rating")
        if not tid or not pid or rating is None:
            continue
        if tid not in mapping:
            mapping[tid] = next_id
            next_id += 1
        triples.append((mapping[tid], pid, float(rating)))
        created = str(r.get("created_at") or "")
        if created > max_created:
            max_created = created

    _save_tourist_map(mapping)
    print(f"[export]   {len(mapping)} user thật đã có id số (map: {TOURIST_MAP_FILE.name})")
    return triples, len(rows), max_created


def build_rating_matrix(
    triples: list[tuple[int, str, float]], valid_place_ids: set[str]
) -> tuple[int, int, int]:
    """Gộp trùng (mean) → CSR matrix + users.csv + items.csv. Trả (users, items, nnz)."""
    sum_stars: dict[tuple[int, str], float] = defaultdict(float)
    cnt: dict[tuple[int, str], int] = defaultdict(int)
    for u, pid, s in triples:
        if pid not in valid_place_ids:
            continue
        sum_stars[(u, pid)] += s
        cnt[(u, pid)] += 1

    if not sum_stars:
        raise SystemExit("[export] Không có rating nào hợp lệ — dừng.")

    users = sorted({u for u, _ in sum_stars})
    items = sorted({p for _, p in sum_stars})
    u_idx = {u: i for i, u in enumerate(users)}
    i_idx = {p: i for i, p in enumerate(items)}

    rows, cols, vals = [], [], []
    for (u, pid), total in sum_stars.items():
        rows.append(u_idx[u])
        cols.append(i_idx[pid])
        vals.append(total / cnt[(u, pid)])

    mat = csr_matrix(
        (np.asarray(vals, dtype=np.float32), (rows, cols)),
        shape=(len(users), len(items)),
    )
    save_npz(OUTPUT_DATA_DIR / "rating_matrix_foody.npz", mat)
    pd.DataFrame({"UserID": users}).to_csv(
        OUTPUT_DATA_DIR / "rating_matrix_foody_users.csv", index=False, encoding="utf-8-sig"
    )
    pd.DataFrame({"id": items}).to_csv(
        OUTPUT_DATA_DIR / "rating_matrix_foody_items.csv", index=False, encoding="utf-8-sig"
    )
    print(
        f"[export]   → rating_matrix_foody.npz: {len(users)} users × {len(items)} items, "
        f"nnz={mat.nnz}"
    )
    return len(users), len(items), int(mat.nnz)


# ────────────────────────────── Main ──────────────────────────────

def main() -> dict:
    ensure_dirs()
    cfg = load_env()
    sb = _client(cfg)

    places = export_places(sb)
    foody = _load_foody_jsonl(Path(cfg["foody_ratings_jsonl"]))
    db_triples, db_review_count, max_created = export_db_reviews(sb)
    n_users, n_items, nnz = build_rating_matrix(
        foody + db_triples, set(places["id"].values)
    )

    snapshot = {
        "exported_at": datetime.now(timezone.utc).isoformat(),
        "places_count": int(len(places)),
        "db_reviews_count": int(db_review_count),
        "db_reviews_max_created_at": max_created,
        "matrix_users": n_users,
        "matrix_items": n_items,
        "matrix_nnz": nnz,
    }
    (OUTPUT_DATA_DIR / "snapshot.json").write_text(
        json.dumps(snapshot, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    print(f"[export] ✅ Hoàn tất. snapshot={snapshot}")
    return snapshot


if __name__ == "__main__":
    try:
        sys.stdout.reconfigure(encoding="utf-8")
    except Exception:
        pass
    main()
