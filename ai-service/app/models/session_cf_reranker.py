"""Session-aware CF reranker cho Two-Tower Top-100 -> Top-N.

Port cấu trúc từ hybrid_recommender.py (artifact offline + load 1 lần + tính nhẹ mỗi
request), khác biệt chính: user_id là Supabase UUID (không ép int), và có thêm
live session score tính trực tiếp từ travel.activity_logs mỗi request.
"""
from __future__ import annotations

import json
import pickle
from datetime import datetime, timedelta
from pathlib import Path

import numpy as np
import pandas as pd

from app.core.logger import get_logger

logger = get_logger(__name__)

VN_OFFSET_HOURS = 7   # activity_logs.created_at lưu giờ VN naive — xem Phase B/D file trước


def _vn_now_naive() -> datetime:
    return datetime.utcnow() + timedelta(hours=VN_OFFSET_HOURS)


class SessionCfReranker:
    REQUIRED_ARTIFACTS = [
        "serve_manifest.json", "cf_user_factors.npy", "cf_item_factors.npy",
        "cf_user_bias.npy", "cf_item_bias.npy", "cf_user_ids.csv", "cf_item_ids.csv",
        "cf_city_to_item_idx.pkl",
    ]

    def __init__(self, artifact_dir: str, supabase_client):
        self.artifact_dir = Path(artifact_dir)
        self.supabase = supabase_client
        self.ready = False

        # Trọng số mặc định — sẽ được sync_engine_from_db() ghi đè lúc khởi động (Phase D)
        self.weight_two_tower = 0.50
        self.weight_historical_cf = 0.20
        self.weight_session = 0.20
        self.weight_popularity = 0.10
        # Trọng số RIÊNG cho user cold-start thật (user_idx is None) — xem rerank().
        # Cố ý tách khỏi weight_popularity ở trên: nếu chỉ zero-out weight_historical_cf/
        # weight_session mà giữ nguyên weight_popularity=0.10, phần "phổ biến" chỉ còn
        # ảnh hưởng 10% trên tổng — quá nhẹ để tạo hiệu ứng "đẩy địa điểm phổ biến lên
        # cho user mới" đúng như yêu cầu ban đầu.
        self.weight_popularity_cold_start = 0.35
        # Trọng số cho Ngọc item-prior khi cold-start thật — CHỈ có tác dụng nếu
        # load_ngoc_item_prior() đã load thành công (xem rerank()); nếu chưa load,
        # nhánh is_fully_cold tự động rơi về công thức 2 thành phần cũ (graceful degrade),
        # giá trị mặc định ở đây không ảnh hưởng gì trong trường hợp đó.
        self.weight_ngoc_prior_cold_start = 0.20
        self.session_window_minutes = 90
        self.top_n_rerank = 30

        # Item-level prior từ model Ngọc (HybridRecommender) — load tùy chọn qua
        # load_ngoc_item_prior(). Khi có, dùng làm fallback cho _historical_cf_score
        # khi user_idx is None (cold-start hoàn toàn): score = normalize(μ_Ngọc + b_i_Ngọc)
        # phản ánh "địa điểm này được 73k user Foody đánh giá cao hay thấp", tốt hơn zero.
        self._ngoc_item_b: dict[str, float] | None = None   # place_id -> b_i
        self._ngoc_global_mean: float | None = None

    def missing_files(self) -> list[str]:
        return [f for f in self.REQUIRED_ARTIFACTS if not (self.artifact_dir / f).exists()]

    def load(self) -> bool:
        missing = self.missing_files()
        if missing:
            logger.warning("SessionCfReranker artifacts chưa đủ — bỏ qua. Thiếu: %s", missing)
            return False

        art = self.artifact_dir
        manifest = json.loads((art / "serve_manifest.json").read_text())
        self.global_mean = float(manifest["global_mean"])

        self.P = np.load(art / "cf_user_factors.npy").astype(np.float32)
        self.Q = np.load(art / "cf_item_factors.npy").astype(np.float32)
        self.b_u = np.load(art / "cf_user_bias.npy").astype(np.float32)
        self.b_i = np.load(art / "cf_item_bias.npy").astype(np.float32)
        # Bản cache L2-normalize riêng của Q — CHỈ dùng cho session cosine similarity
        # (_live_session_factor/_session_scores_for_candidates). self.Q gốc (chưa
        # normalize) vẫn dùng cho _historical_cf_score để giữ đúng scale rating 1-5.
        q_norms = np.clip(np.linalg.norm(self.Q, axis=1, keepdims=True), 1e-9, None)
        self._unit_Q = (self.Q / q_norms).astype(np.float32)

        user_ids = pd.read_csv(art / "cf_user_ids.csv")["user_id"].astype(str).values
        item_ids = pd.read_csv(art / "cf_item_ids.csv")["place_id"].astype(str).values
        self.user_id_to_idx = {u: i for i, u in enumerate(user_ids)}
        self.item_id_to_idx = {p: i for i, p in enumerate(item_ids)}

        with open(art / "cf_city_to_item_idx.pkl", "rb") as f:
            self.city_to_item_idx = pickle.load(f)

        self.ready = True
        logger.info(
            "✅ SessionCfReranker loaded: %d users, %d items", len(user_ids), len(item_ids)
        )
        return True

    def load_ngoc_item_prior(self, ngoc_artifact_dir: str) -> bool:
        """Load item-level CF prior từ HybridRecommender của Ngọc (tùy chọn).

        Khi được load, _historical_cf_score sẽ dùng μ_Ngọc + b_i_Ngọc thay vì 0 cho
        user cold-start (user_idx is None) — tận dụng tín hiệu explicit rating từ
        73k user Foody mà không cần map user_id giữa hai hệ thống.

        Chỉ cần b_i/global_mean phía item — KHÔNG đọc Q/P/b_u/user_ids của Ngọc (Q
        không cần cho prior này; user Foody int ID không map được sang Supabase UUID).
        """
        ngoc_dir = Path(ngoc_artifact_dir)
        required = ["serve_manifest.json", "cf_item_bias.npy", "cf_item_ids.csv"]
        missing = [f for f in required if not (ngoc_dir / f).exists()]
        if missing:
            logger.warning("load_ngoc_item_prior: thiếu file %s — bỏ qua.", missing)
            return False
        try:
            manifest = json.loads((ngoc_dir / "serve_manifest.json").read_text())
            ngoc_b_i = np.load(ngoc_dir / "cf_item_bias.npy").astype(np.float32)
            item_ids = (
                pd.read_csv(ngoc_dir / "cf_item_ids.csv").iloc[:, 0]
                .astype(str).str.strip().tolist()
            )
            self._ngoc_item_b = {pid: float(ngoc_b_i[i]) for i, pid in enumerate(item_ids)}
            self._ngoc_global_mean = float(manifest["global_mean"])
            logger.info(
                "✅ Ngọc item prior loaded: %d items, global_mean=%.3f",
                len(self._ngoc_item_b), self._ngoc_global_mean,
            )
            return True
        except Exception as exc:
            logger.warning("load_ngoc_item_prior thất bại: %s — dùng zero fallback.", exc)
            self._ngoc_item_b = None
            self._ngoc_global_mean = None
            return False

    # --------------------------------------------------- runtime tuning (đúng khuôn Ngọc)
    def set_weights(self, **kwargs) -> None:
        """Cập nhật trọng số lúc runtime — gọi từ ai_config_service khi khởi động
        hoặc khi admin chỉnh qua API. Không validate tổng = 1 (cho phép thử nghiệm),
        chỉ ép từng giá trị về [0, 1]."""
        for key in [
            "weight_two_tower", "weight_historical_cf",
            "weight_session", "weight_popularity", "weight_popularity_cold_start",
            "weight_ngoc_prior_cold_start",
        ]:
            if key in kwargs and kwargs[key] is not None:
                setattr(self, key, max(0.0, min(1.0, float(kwargs[key]))))
        if "session_window_minutes" in kwargs and kwargs["session_window_minutes"] is not None:
            self.session_window_minutes = max(15, int(kwargs["session_window_minutes"]))
        if "top_n_rerank" in kwargs and kwargs["top_n_rerank"] is not None:
            self.top_n_rerank = max(1, int(kwargs["top_n_rerank"]))
        logger.info(
            "SessionCfReranker weights cập nhật: tt=%.2f cf=%.2f session=%.2f pop=%.2f window=%dm",
            self.weight_two_tower, self.weight_historical_cf,
            self.weight_session, self.weight_popularity, self.session_window_minutes,
        )

    # ------------------------------------------------------------------ historical CF
    #
    # Thang điểm rating của model Ngọc là 0.5–5.0 (KHÔNG phải 1.0–5.0) — xem báo cáo
    # TTDATN mục 3.1.4.3 "Bước 3: Giới hạn dự đoán... 0.5 ≤ r̂ᵤᵢ ≤ 5.0". Model persona
    # (self.global_mean/self.b_u/self.b_i/self.P/self.Q, train qua rating_for_svd =
    # 1 + 4*combined_score ở train_session_cf.py) vẫn đúng thang 1.0–5.0 như cũ — 2
    # hằng số normalize khác nhau bên dưới là CỐ Ý, vì đến từ 2 model khác nhau.
    def _historical_cf_score(
        self, user_idx: int | None, item_indices: np.ndarray,
        place_ids: list[str] | None = None,
    ) -> np.ndarray:
        if user_idx is None:
            if self._ngoc_item_b is not None and place_ids is not None:
                mu = self._ngoc_global_mean
                b_i_ngoc = np.array(
                    [self._ngoc_item_b.get(pid, 0.0) for pid in place_ids], dtype=np.float32
                )
                raw = mu + b_i_ngoc
                return np.clip((raw - 0.5) / 4.5, 0.0, 1.0)   # thang gốc 0.5-5.0 của Ngọc
            return np.zeros(len(item_indices), dtype=np.float32)   # chưa load prior -> graceful degrade
        raw = (
            self.global_mean + self.b_u[user_idx] + self.b_i[item_indices]
            + self.Q[item_indices] @ self.P[user_idx]
        )
        # normalize về [0,1] trong phạm vi rating 1-5 (Surprise scale, model persona)
        return np.clip((raw - 1.0) / 4.0, 0.0, 1.0)

    # --------------------------------------------------------------------- LIVE session
    #
    # ⚠️ Thiết kế v1 (đã bỏ): chỉ cộng điểm cho candidate TRÙNG place_id đã tương tác
    # trong cửa sổ ngắn — không tổng quát hoá được (địa điểm tương tự nhưng chưa xem
    # thì không nhận tín hiệu gì). Đã sửa sang "session factor vector" — tái dùng đúng
    # kỹ thuật session-based centroid trong docs/svd-reranking-plan.md mục 4.2
    # (Linden, Smith & York 2003 — item-to-item CF của Amazon), nhưng đặt trong khuôn
    # artifact/serving của Ngọc. Chi phí thêm không đáng kể — cùng cấp 1 phép nhân ma
    # trận nhỏ như _historical_cf_score, không phải round-trip DB thêm nào ngoài 1 query
    # đọc log (đã có sẵn ở thiết kế cũ).
    def _live_session_factor(self, user_id: str) -> np.ndarray | None:
        """Lấy các place vừa tương tác trong cửa sổ ngắn, tra item_factor (Q) của
        chúng, rồi tính trung bình có trọng số theo action_type -> ra 1 vector
        K-chiều đại diện cho 'ý định ngay lúc này' của user. Vector này sau đó được
        dot product với TẤT CẢ candidate (không chỉ candidate trùng place_id) nên
        các địa điểm TƯƠNG TỰ nhưng chưa từng xem vẫn nhận được tín hiệu — đây là
        điểm khác biệt cốt lõi so với chỉ match nguyên place_id.
        """
        if self.supabase is None:
            return None
        cutoff = _vn_now_naive() - timedelta(minutes=self.session_window_minutes)
        try:
            result = (
                self.supabase.schema("travel").table("activity_logs")
                .select("place_id, action_type, created_at")
                .eq("tourist_id", user_id)
                .gte("created_at", cutoff.isoformat())
                .not_.is_("place_id", "null")
                .order("created_at", desc=True)
                .limit(30)   # đủ cho 1 phiên, tránh kéo cả lịch sử dài nếu window bị nới rộng
                .execute()
            )
        except Exception as exc:
            logger.warning("Live session query thất bại, bỏ qua session factor: %s", exc)
            return None

        rows = result.data or []
        if not rows:
            return None

        weights = {
            "view": 1.0, "click": 2.0, "search": 1.5,
            "save": 4.0, "visited": 5.0, "review": 3.0, "rating": 3.0,
        }
        # Dùng vector ĐÃ NORMALIZE của từng item (_unit_Q, cache sẵn — xem load())
        # để trung bình cộng không bị lệch bởi item nào đó có norm lớn bất thường.
        weighted_sum = np.zeros(self.Q.shape[1], dtype=np.float32)
        total_weight = 0.0
        for row in rows:
            pid = row["place_id"]
            item_idx = self.item_id_to_idx.get(pid)
            if item_idx is None:
                continue   # place chưa có trong vocab CF (chưa được train/encode) — bỏ qua, không lỗi
            w = weights.get(row["action_type"], 0.0)
            if w <= 0:
                continue
            weighted_sum += w * self._unit_Q[item_idx]
            total_weight += w

        if total_weight <= 0:
            return None
        session_vec = weighted_sum / total_weight
        norm = np.linalg.norm(session_vec)
        return session_vec / norm if norm > 0 else None

    def _session_scores_for_candidates(
        self, session_vec: np.ndarray | None, item_indices: np.ndarray, valid_mask: np.ndarray
    ) -> np.ndarray:
        """Cosine similarity giữa session_vec và item_factor của MỌI candidate hợp lệ
        (không chỉ candidate đã từng xem) -> tổng quát hoá sang địa điểm tương tự.
        Dùng self._unit_Q (bản Q đã L2-normalize, cache sẵn từ load() — KHÔNG phải
        self.Q gốc, vì self.Q gốc phải giữ nguyên scale cho _historical_cf_score)."""
        scores = np.zeros(len(item_indices), dtype=np.float32)
        if session_vec is None or not valid_mask.any():
            return scores   # không có session -> 0, giống cold-start, không lỗi
        raw = self._unit_Q[item_indices[valid_mask]] @ session_vec
        # cả 2 vector đã unit-norm -> raw = cosine similarity thật, nằm trong [-1, 1]
        scores[valid_mask] = np.clip((raw + 1.0) / 2.0, 0.0, 1.0)
        return scores

    # ------------------------------------------------------------------------ popularity
    def _popularity_score(self, place_meta: dict[str, dict]) -> dict[str, float]:
        """is_top20_visited = candidate có nằm trong ĐÚNG Top 20 địa điểm được ghé
        thăm nhiều nhất CỦA CATEGORY của nó hay không (NestJS tra qua đúng RPC
        `get_place_popularity_stats` mà dashboard admin dùng, cùng p_limit=20, cùng
        p_category_name — xem fetchPopularityMeta()/getTop20PlaceIdsByCategory() ở
        recommendation.service.ts). Đây là boost RỜI RẠC (0 hoặc 1), không còn tính
        liên tục theo số lượt ghé nữa — vì cô yêu cầu chỉ dựa vào đúng 20 địa điểm
        admin đang thấy trên dashboard cho từng category, không quét toàn bộ
        địa điểm. average_rating vẫn là tín hiệu PHỤ (chất lượng).

        Nếu candidate có cờ `is_admin_featured` (tính năng "Thêm vào danh sách gợi ý"
        trên dashboard — hiện CHƯA xây) cộng thêm bonus cố định 0.15 (ép trần 1.0)."""
        scores: dict[str, float] = {}
        for pid, meta in place_meta.items():
            visit_signal = 1.0 if meta.get("is_top20_visited") else 0.0
            rating_norm = min(1.0, (meta.get("average_rating") or 0.0) / 5.0)
            base = 0.7 * visit_signal + 0.3 * rating_norm
            featured_bonus = 0.15 if meta.get("is_admin_featured") else 0.0
            scores[pid] = min(1.0, base + featured_bonus)
        return scores

    # --------------------------------------------------------------------------- rerank
    def rerank(self, user_id: str | None, candidates: list[dict]) -> list[dict]:
        """candidates: list các dict từ diversifyTopK, mỗi dict có ít nhất
        place_id, cosine_score, category, average_rating?, is_top20_visited?"""
        if not self.ready or not candidates:
            return candidates

        place_ids = [c["place_id"] for c in candidates]
        item_indices = np.array(
            [self.item_id_to_idx.get(pid, -1) for pid in place_ids]
        )
        valid_mask = item_indices >= 0
        user_idx = self.user_id_to_idx.get(user_id) if user_id else None

        historical_scores = np.zeros(len(candidates), dtype=np.float32)
        if valid_mask.any():
            historical_scores[valid_mask] = self._historical_cf_score(
                user_idx, item_indices[valid_mask],
                place_ids=[pid for pid, v in zip(place_ids, valid_mask) if v] if user_idx is None else None,
            )
        if user_idx is None and self._ngoc_item_b is not None and (~valid_mask).any():
            # Item KHÔNG có trong vocab CF persona (~vài trăm item) — đây là ĐA SỐ
            # candidate thực tế, vì catalog Ngọc phủ ~29,844 item. Trước đây các item
            # này bị bỏ mặc ở 0 (bug: nhánh Ngọc-prior chỉ chạy khi valid_mask rỗng
            # HOÀN TOÀN, tức chỉ đúng cho trường hợp hiếm gặp) — sửa bằng cách luôn áp
            # Ngọc-prior cho đúng phần bù ~valid_mask khi user cold-start.
            historical_scores[~valid_mask] = self._historical_cf_score(
                None, item_indices[~valid_mask],
                place_ids=[pid for pid, v in zip(place_ids, valid_mask) if not v],
            )

        # Session factor: 1 vector đại diện "ý định ngay lúc này", dot product với
        # MỌI candidate hợp lệ (không chỉ candidate trùng place_id đã xem) -> tổng
        # quát hoá sang địa điểm tương tự trong cùng vùng latent space.
        session_vec = self._live_session_factor(user_id) if user_id else None
        session_scores = self._session_scores_for_candidates(
            session_vec, item_indices, valid_mask
        )

        place_meta = {c["place_id"]: c for c in candidates}
        popularity_map = self._popularity_score(place_meta)

        two_tower_scores = np.array([c.get("cosine_score", 0.0) for c in candidates])
        tt_min, tt_max = two_tower_scores.min(), two_tower_scores.max()
        tt_norm = (
            (two_tower_scores - tt_min) / (tt_max - tt_min)
            if tt_max > tt_min else np.zeros_like(two_tower_scores)
        )

        # ⚠️ Điểm sửa quan trọng: user_idx is None (chưa từng có trong vocab CF) là tín
        # hiệu "hoàn toàn không biết gì về user" mạnh nhất — TRƯỚC ĐÂY code chỉ zero-out
        # historical_cf_score/session_score mà vẫn giữ nguyên weight_popularity=0.10,
        # khiến phần "phổ biến" chỉ ảnh hưởng 10% tổng điểm — không đủ để tạo hiệu ứng
        # "đẩy địa điểm phổ biến lên cho user mới" như yêu cầu ban đầu. Sửa: dùng hẳn
        # 1 bộ trọng số khác (chỉ 2 thành phần: two_tower + popularity_cold_start) thay
        # vì để 40% trọng số (weight_historical_cf + weight_session) bốc hơi vô ích.
        #
        # Chỉ coi là "cold-start thật" khi KHÔNG có cả lịch sử dài hạn (user_idx) LẪN
        # session gần đây (session_vec) — nếu user có 1 trong 2, vẫn dùng bộ trọng số
        # thường (thành phần thiếu tự nhiên = 0, phần còn lại vẫn có ý nghĩa).
        is_fully_cold = user_idx is None and session_vec is None

        for i, c in enumerate(candidates):
            pid = c["place_id"]
            pop_score = popularity_map.get(pid, 0.0)

            if is_fully_cold:
                w_pop = self.weight_popularity_cold_start
                if self._ngoc_item_b is not None:
                    # historical_scores[i] ở đây là Ngọc item-prior (xem
                    # _historical_cf_score) — TRƯỚC ĐÂY bị bỏ hoàn toàn ở nhánh
                    # is_fully_cold dù đã tính, khiến việc load prior vô nghĩa cho
                    # đúng nhóm user nó nhắm tới. Giờ đưa vào công thức 3 thành phần.
                    w_ngoc = self.weight_ngoc_prior_cold_start
                    w_tt = max(0.0, 1.0 - w_pop - w_ngoc)
                    final = w_tt * tt_norm[i] + w_pop * pop_score + w_ngoc * historical_scores[i]
                else:
                    final = (1.0 - w_pop) * tt_norm[i] + w_pop * pop_score
            else:
                final = (
                    self.weight_two_tower * tt_norm[i]
                    + self.weight_historical_cf * historical_scores[i]
                    + self.weight_session * session_scores[i]
                    + self.weight_popularity * pop_score
                )

            c["historical_cf_score"] = round(float(historical_scores[i]), 6)
            c["session_score"] = round(float(session_scores[i]), 6)
            c["popularity_score"] = round(float(pop_score), 6)
            c["predict_ranking"] = round(float(final), 6)
            c["is_cold_start"] = is_fully_cold

        # ⚠️ KHÔNG cắt còn top_n_rerank ở đây: candidates ở luồng itinerary chính là
        # pool cấp cho GA planner (calcRetrievalTopK trả về 60-200 tuỳ số ngày), không
        # phải danh sách hiển thị cuối kiểu "gợi ý Top-N" như hybrid_recommender của
        # Ngọc. Cắt cứng về top_n_rerank (default 30) sẽ khiến planner luôn nhận tối
        # đa 30 candidate bất kể topK yêu cầu, gây thiếu chỗ nghiêm trọng cho trip
        # nhiều ngày. top_n_rerank vẫn giữ lại như tham số tunable (dự phòng cho một
        # endpoint hiển thị Top-N riêng trong tương lai), chỉ không áp dụng ở rerank()
        # dùng chung này nữa.
        candidates.sort(key=lambda c: c["predict_ranking"], reverse=True)
        return candidates
