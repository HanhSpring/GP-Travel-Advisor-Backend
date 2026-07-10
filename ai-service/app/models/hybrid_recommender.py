"""Hybrid recommender (CB + Funk-SVD CF + khoảng cách) cho mục "Có thể bạn sẽ thích".

Port trung thực thuật toán `recommend_hybrid` trong Offline_recommender.ipynb / RECOMMENDER_API_SERVING.md.
Artifact được sinh offline bởi notebook, service chỉ load 1 lần lúc khởi động rồi
mỗi request chỉ tính nhẹ (CF chấm điểm trong 1 city, CB tra dict O(1)).
"""

from __future__ import annotations

import json
import math
import pickle
from pathlib import Path

import numpy as np
import pandas as pd
from scipy.sparse import load_npz

from app.core.logger import get_logger

logger = get_logger(__name__)


class HybridRecommender:
    """Load artifact offline và phục vụ gợi ý on-the-fly."""

    # ----- danh sách file artifact bắt buộc -----
    REQUIRED_ARTIFACTS = [
        "serve_manifest.json",
        "cf_user_factors.npy",
        "cf_item_factors.npy",
        "cf_user_bias.npy",
        "cf_item_bias.npy",
        "cf_user_ids.csv",
        "cf_item_ids.csv",
        "cf_city_to_item_idx.pkl",
        "cb_lookup_foody_rich.pkl",
    ]
    REQUIRED_DATA = ["Places.csv", "rating_matrix_foody.npz"]

    # Map tourist UUID -> id số (sinh bởi retrain/export_training_data.py).
    # Optional: thiếu file thì user thật chỉ nhận CB + khoảng cách như trước.
    TOURIST_MAP_FILE = "tourist_user_map.csv"

    def __init__(self, artifact_dir: str, data_dir: str):
        self.artifact_dir = Path(artifact_dir)
        self.data_dir = Path(data_dir)
        self.tourist_uuid_to_numeric: dict[str, int] = {}
        self.ready = False

    # ------------------------------------------------------------------ load
    def missing_files(self) -> list[str]:
        missing = [
            f"artifacts/{f}"
            for f in self.REQUIRED_ARTIFACTS
            if not (self.artifact_dir / f).exists()
        ]
        missing += [
            f"data/{f}"
            for f in self.REQUIRED_DATA
            if not (self.data_dir / f).exists()
        ]
        return missing

    def load(self) -> bool:
        missing = self.missing_files()
        if missing:
            logger.warning(
                "Recommender artifacts chưa đủ — bỏ qua. Thiếu: %s", ", ".join(missing)
            )
            return False

        art, data = self.artifact_dir, self.data_dir
        man = json.load(open(art / "serve_manifest.json", encoding="utf-8"))

        self.P = np.load(art / "cf_user_factors.npy").astype(np.float32)
        self.Q = np.load(art / "cf_item_factors.npy").astype(np.float32)
        self.b_u = np.load(art / "cf_user_bias.npy").astype(np.float32)
        self.b_i = np.load(art / "cf_item_bias.npy").astype(np.float32)
        self.global_mean = float(man["global_mean"])

        defaults = man.get("hybrid_defaults", {})
        self.model_weight = float(defaults.get("model_weight", 0.75))
        self.distance_weight = float(defaults.get("distance_weight", 0.25))
        self.decay_km = float(defaults.get("distance_decay_km", 5.0))
        self.cb_k = int(defaults.get("cb_k", 50))
        self.cf_k = int(defaults.get("cf_k", 50))

        cf_user_ids = pd.read_csv(art / "cf_user_ids.csv").iloc[:, 0].astype(int).values
        cf_item_ids = (
            pd.read_csv(art / "cf_item_ids.csv").iloc[:, 0].astype(str).str.strip().values
        )
        self.cf_item_ids = cf_item_ids
        self.user_id_to_idx = {int(u): i for i, u in enumerate(cf_user_ids)}
        self.item_id_to_idx = {str(p): i for i, p in enumerate(cf_item_ids)}

        with open(art / "cf_city_to_item_idx.pkl", "rb") as f:
            self.city_to_item_idx = pickle.load(f)  # city -> np.array[int]
        with open(art / "cb_lookup_foody_rich.pkl", "rb") as f:
            self.cb_lookup = pickle.load(f)  # id -> [id, ...]

        self.R_csr = load_npz(data / "rating_matrix_foody.npz").tocsr()  # mask lịch sử

        self.tourist_uuid_to_numeric = self._load_tourist_map()

        # Metadata hiển thị + city/coords theo place_id
        places = pd.read_csv(data / "Places.csv", encoding="utf-8-sig", low_memory=False)
        places.columns = [c.strip() for c in places.columns]
        places["id"] = places["id"].astype(str).str.strip()
        self.places = places.drop_duplicates("id").set_index("id")
        self.id2city = (
            self.places["city_name"].astype(str).str.strip().to_dict()
            if "city_name" in self.places.columns
            else {}
        )

        self.ready = True
        logger.info(
            "✅ HybridRecommender loaded: %d users, %d items, %d cities, %d places meta",
            len(self.user_id_to_idx),
            len(self.item_id_to_idx),
            len(self.city_to_item_idx),
            len(self.places),
        )
        return True

    # ------------------------------------------------------- runtime tuning
    def set_distance_weight(self, distance_weight: float) -> None:
        """Cập nhật hệ số khoảng cách lúc runtime; model_weight = 1 - distance_weight.

        Được gọi khi đồng bộ cấu hình từ DB (schema ai_config) lúc khởi động
        hoặc mỗi khi admin chỉnh qua API. Ép về [0, 1] cho an toàn.
        """
        w = max(0.0, min(1.0, float(distance_weight)))
        self.distance_weight = w
        self.model_weight = 1.0 - w
        logger.info(
            "HybridRecommender weights cập nhật: distance=%.4f, model=%.4f",
            self.distance_weight, self.model_weight,
        )

    # --------------------------------------------------------------- helpers
    def _load_tourist_map(self) -> dict[str, int]:
        """Đọc tourist_user_map.csv (UUID -> id số) nếu có.

        Ưu tiên bản đi kèm artifact (đồng bộ từ R2), fallback retrain/state/
        khi chạy local không R2. Thiếu file không phải lỗi — chỉ mất nhánh CF
        cho user thật.
        """
        candidates = [
            self.artifact_dir / self.TOURIST_MAP_FILE,
            Path("retrain") / "state" / self.TOURIST_MAP_FILE,
        ]
        for path in candidates:
            if not path.exists():
                continue
            try:
                df = pd.read_csv(path, dtype={"tourist_id": str, "numeric_id": int})
                mapping = {
                    str(t).strip().lower(): int(n)
                    for t, n in zip(df["tourist_id"], df["numeric_id"])
                }
                logger.info(
                    "Tourist map loaded: %d user thật (từ %s)", len(mapping), path
                )
                return mapping
            except Exception as e:
                logger.warning("Không đọc được tourist map %s: %s", path, e)
        logger.info(
            "tourist_user_map.csv không có — user thật (UUID) sẽ không có nhánh CF"
        )
        return {}

    def resolve_user_id(self, raw) -> int | None:
        """Chuyển user_id bất kỳ (id số hoặc tourist UUID) về id số của ma trận CF.

        Trả None nếu không map được — nhánh CF sẽ bị bỏ qua (giữ CB + khoảng cách).
        """
        if raw is None:
            return None
        s = str(raw).strip()
        if not s:
            return None
        if s.isdigit():
            return int(s)
        return self.tourist_uuid_to_numeric.get(s.lower())

    def _meta(self, pid: str) -> dict:
        if pid not in self.places.index:
            return {}
        r = self.places.loc[pid]
        return {
            "name": str(r.get("name", "") or ""),
            "city_name": str(r.get("city_name", "") or "").strip(),
            "category_name": str(r.get("category_name", "") or ""),
            "type_name": str(r.get("type_name", "") or ""),
            "latitude": float(r["latitude"]) if pd.notna(r.get("latitude")) else None,
            "longitude": float(r["longitude"]) if pd.notna(r.get("longitude")) else None,
        }

    @staticmethod
    def _haversine_km(lat1, lon1, lat2, lon2):
        if None in (lat1, lon1, lat2, lon2):
            return None
        R = 6371.0
        p1, p2 = math.radians(lat1), math.radians(lat2)
        dphi = math.radians(lat2 - lat1)
        dl = math.radians(lon2 - lon1)
        a = math.sin(dphi / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
        return 2 * R * math.asin(math.sqrt(a))

    @staticmethod
    def _rank_score(rank: int, total: int) -> float:
        return 0.0 if total <= 0 else 1.0 - (rank - 1) / max(total, 1)

    def _cf_topk_in_city(self, user_id, city, k):
        u = self.user_id_to_idx.get(int(user_id)) if user_id is not None else None
        if u is None:
            return []
        items = self.city_to_item_idx.get(city)
        if items is None or len(items) == 0:
            return []
        scores = (
            self.global_mean + self.b_u[u] + self.b_i[items] + self.Q[items] @ self.P[u]
        )
        # mask địa điểm user đã tương tác
        start, end = self.R_csr.indptr[u], self.R_csr.indptr[u + 1]
        history = set(self.R_csr.indices[start:end].tolist())
        if history:
            keep = np.array([it not in history for it in items])
            scores = np.where(keep, scores, -np.inf)
        valid = np.isfinite(scores)
        if not valid.any():
            return []
        ev = min(k, int(valid.sum()))
        part = np.argpartition(-scores, ev - 1)[:ev]
        order = part[np.argsort(-scores[part])]
        return [self.cf_item_ids[items[i]] for i in order]

    def _cb_topk(self, current_item_id, k):
        return [
            x for x in self.cb_lookup.get(str(current_item_id), []) if x != str(current_item_id)
        ][:k]

    # ----------------------------------------------------------- recommend
    def recommend(self, user_id, current_item_id, k=10):
        if not self.ready:
            raise RuntimeError("Recommender chưa load được artifact")

        user_id = self.resolve_user_id(user_id)
        current_item_id = str(current_item_id)
        city = self.id2city.get(current_item_id, "")
        if not city:
            return []

        cb = self._cb_topk(current_item_id, self.cb_k)
        cf = [x for x in self._cf_topk_in_city(user_id, city, self.cf_k) if x != current_item_id]
        cb_set, cf_set = set(cb), set(cf)
        union = list(dict.fromkeys(cb + cf))
        if not union:
            return []

        cb_rank = {p: i for i, p in enumerate(cb, 1)}
        cf_rank = {p: i for i, p in enumerate(cf, 1)}
        cur = self._meta(current_item_id)

        out = []
        for pid in union:
            src = "BOTH" if pid in cb_set and pid in cf_set else ("CB" if pid in cb_set else "CF")
            cb_s = self._rank_score(cb_rank.get(pid, 0), len(cb)) if pid in cb_set else 0.0
            cf_s = self._rank_score(cf_rank.get(pid, 0), len(cf)) if pid in cf_set else 0.0
            model = max(cb_s, cf_s)
            if src == "BOTH":
                model = min(1.0, (cb_s + cf_s) / 2 + 0.10)
            m = self._meta(pid)
            d = self._haversine_km(
                cur.get("latitude"), cur.get("longitude"),
                m.get("latitude"), m.get("longitude"),
            )
            dist_s = 0.0 if d is None else math.exp(-max(d, 0.0) / self.decay_km)
            final = self.model_weight * model + self.distance_weight * dist_s
            out.append({
                **m,
                "id": pid,
                "distance_km": round(d, 3) if d is not None else None,
                "model_score": round(model, 6),
                "distance_score": round(dist_s, 6),
                "final_score": round(final, 6),
                "source": src,
            })

        out.sort(
            key=lambda r: (r["final_score"], r["model_score"], r["distance_score"]),
            reverse=True,
        )
        for i, r in enumerate(out[:k], 1):
            r["rank"] = i
        return out[:k]
