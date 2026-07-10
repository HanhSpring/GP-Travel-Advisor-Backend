# Retrain Pipeline — Tự động train lại recommender khi có địa điểm / user mới

> Pipeline nằm **trọn trong `ai-service/retrain/`** — KHÔNG sửa bất kỳ file nào
> của hệ thống đang chạy. Serving vẫn là `hybrid_recommender.py` + artifact như cũ;
> pipeline chỉ **sinh artifact mới** và đặt vào đúng chỗ service đọc.

---

## 1. Vấn đề pipeline giải quyết

Hybrid recommender (CB + Funk-SVD + khoảng cách) học từ **artifact tĩnh** sinh bởi
notebook `ETL_CaNhan_2/Offline_recommender.ipynb`:

- Địa điểm tạo sau lần train cuối → không có trong artifact → không bao giờ được
  model gợi ý (trang chi tiết của nó chỉ được cứu bởi fallback cùng-city ở NestJS).
- Review của user thật (`review_ai.reviews`) → không chảy vào ma trận rating →
  CF không học được gì từ hành vi thật.
- Quy trình cũ: chạy tay notebook → chạy tay `upload_to_r2.py` → restart tay.

Pipeline tự động hóa toàn bộ chuỗi đó, có phát hiện thay đổi và chốt chất lượng.

## 2. Luồng chạy (`retrain_pipeline.py`)

```
1. PHÁT HIỆN THAY ĐỔI  — đếm places (approved+active) + reviews + max(created_at)
        │                 trên Supabase, so với state/retrain_state.json
        │                 → không đổi: thoát sau ~2s (không train vô ích)
        ▼
2. EXPORT (export_training_data.py)
        │   travel.places  ──────────────→  output/data/Places.csv
        │   review_ai.reviews ┐
        │   Foody JSONL lịch sử ┴─(gộp, mean)→ output/data/rating_matrix_foody.npz + users/items.csv
        │   (user UUID được cấp id số ổn định qua state/tourist_user_map.csv, từ 1_000_000_000)
        ▼
3. TRAIN (train_recommender.py — port trung thực notebook)
        │   CB : SentenceTransformer 'paraphrase-multilingual-MiniLM-L12-v2'
        │        → cb_lookup_foody_rich.pkl (top-50 cùng city / item)
        │   CF : Funk-SVD (Surprise), split 80/10/10 seed 42
        │        → P, Q, b_u, b_i, global_mean (+ val/test RMSE)
        │   Serving extras: cf_city_to_item_idx.pkl, cf_item_latlon.npy, serve_manifest.json
        ▼
4. QUALITY GATE — test RMSE mới ≤ RMSE cũ × (1 + RETRAIN_RMSE_TOLERANCE, mặc định 2%)
        │          xấu hơn → DỪNG, không deploy, artifact giữ ở output/ để xem
        ▼
5. DEPLOY — backup bản cũ (giữ 5 bản) → copy vào recommender_artifacts/ + data/ của
        │   ai-service → upload R2 (nếu cấu hình) → XÓA cache R2 local của service
        │   (bắt buộc: r2_downloader chỉ so size file, .npy cùng shape sẽ cùng size)
        ▼
6. RESTART — chạy RETRAIN_RESTART_CMD nếu có; không có thì nhắc restart tay
```

## 3. Các file

| File | Vai trò |
|------|---------|
| `pipeline_config.py` | Đọc `.env` của ai-service (+ `.env.retrain` override), định nghĩa đường dẫn |
| `export_training_data.py` | Kéo places + reviews từ Supabase, dựng rating matrix |
| `train_recommender.py` | Train CB + CF, sinh đúng bộ `REQUIRED_ARTIFACTS` của `HybridRecommender` |
| `retrain_pipeline.py` | Điều phối 6 bước trên |
| `register_task.ps1` | Đăng ký Windows Task Scheduler chạy 02:00 hàng ngày |
| `requirements.txt` | Phụ thuộc riêng (thêm `scikit-surprise`) |
| `state/` | `retrain_state.json` (phát hiện thay đổi) + `tourist_user_map.csv` (UUID→id số) |
| `output/` | Artifact + data của lần train gần nhất (staging, chưa deploy nếu gate fail) |
| `backups/` | 5 bản artifact cũ gần nhất — rollback bằng cách copy ngược lại |
| `logs/` | `retrain_YYYYMM.log` |

## 4. Cài đặt & chạy

```bash
cd GP-Travel-Advisor-Backend/ai-service
pip install -r retrain/requirements.txt        # thêm scikit-surprise

cd retrain
python retrain_pipeline.py --force --dry-run   # lần đầu: train thử, KHÔNG deploy
python retrain_pipeline.py --force             # lần đầu deploy thật
python retrain_pipeline.py                     # chạy thường (tự phát hiện thay đổi)
python retrain_pipeline.py --grid-search       # tìm lại siêu tham số (chạy thưa, vd mỗi tháng)
```

Đăng ký chạy tự động 02:00 hàng ngày (PowerShell **Administrator**):

```powershell
cd GP-Travel-Advisor-Backend\ai-service\retrain
powershell -ExecutionPolicy Bypass -File register_task.ps1
# gỡ: powershell -ExecutionPolicy Bypass -File register_task.ps1 -Unregister
```

## 5. Cấu hình

Pipeline đọc `ai-service/.env` sẵn có. Có thể override trong `retrain/.env.retrain`:

| Biến | Bắt buộc | Ý nghĩa |
|------|----------|---------|
| `SUPABASE_URL`, `SUPABASE_KEY` | ✅ | đã có trong `.env` của service |
| `R2_ENDPOINT_URL`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET_NAME` | ⬜ | thiếu → chỉ deploy local |
| `ARTIFACT_CACHE_DIR` | ⬜ | cache R2 của service (mặc định `/tmp/ai_cache`) — pipeline xóa sau khi upload |
| `RETRAIN_FOODY_RATINGS_JSONL` | ⬜ | ratings Foody lịch sử (mặc định trỏ `Recommendation_System/foody_two_tower_training_data_with_place_id.jsonl`) |
| `RETRAIN_RESTART_CMD` | ⬜ | lệnh restart ai-service (vd `nssm restart ai-service`); thiếu → nhắc restart tay |
| `RETRAIN_RMSE_TOLERANCE` | ⬜ | ngưỡng quality gate, mặc định `0.02` (2%) |

## 6. Trả lời các câu hỏi thiết kế

**Địa điểm mới bao lâu thì được gợi ý?** Tối đa 1 chu kỳ (24h với lịch mặc định).
Sau retrain, nó có mặt trong Places.csv + CB lookup (embedding từ name/vibes/
description...) nên được gợi ý qua nhánh CB ngay cả khi **chưa có review nào**.
Khi có review, nó vào cả ma trận CF.

**User mới bao giờ được cá nhân hóa?** Review của user thật đã được đưa vào ma trận
CF (cải thiện item factors/bias cho mọi người). Cá nhân hóa CF theo từng user thật
**đã kích hoạt**: NestJS truyền thẳng `tourist_id` (UUID của user đăng nhập, mobile
gửi kèm khi gọi `GET /places/:id`) sang ai-service; route
`/recommend/places/{id}/recommendations` nhận `user_id` dạng chuỗi và
`HybridRecommender.resolve_user_id` tra `tourist_user_map.csv` (UUID → id số) để
chạy nhánh CF. File map được deploy kèm artifact (`deploy_local` + upload R2 prefix
`recommender_artifacts/`); thiếu map thì user thật chỉ nhận CB + khoảng cách như cũ,
không lỗi. Lưu ý: user mới chỉ vào map ở lần retrain kế tiếp (sau khi có review).

**Vì sao không grid-search mỗi đêm?** 24 tổ hợp × 3 fold quá nặng để chạy hàng ngày;
tham số tối ưu ít khi đổi theo ngày. Mặc định dùng lại `best_svd_params` trong
manifest của bản đang chạy; chạy `--grid-search` định kỳ thưa (vd đầu tháng) hoặc
khi dữ liệu tăng đột biến.

**Vì sao phải xóa cache sau khi upload R2?** `r2_downloader._sync_prefix` bỏ qua
download nếu **size local = size remote**. Các file `.npy` (factors/bias) giữ nguyên
shape giữa 2 lần train → cùng size → service restart sẽ dùng nhầm bản cũ nếu không
xóa cache.

**Rollback thế nào?** Copy thư mục trong `backups/<timestamp>/` ngược lại vào
`recommender_artifacts/` + `data/` của ai-service (và upload lại R2 nếu dùng R2),
rồi restart service.

## 7. Giới hạn hiện tại

- Notebook gốc vẫn là "source of truth" học thuật; script train là bản port phục vụ
  vận hành (thuật toán giữ nguyên, khác biệt liệt kê ở docstring `train_recommender.py`).
- Chưa có endpoint reload nóng — deploy xong cần restart service (mất vài chục giây
  load model). Muốn zero-downtime cần thêm endpoint reload vào ai-service (đụng code).
- `district_old`, `travel_type` có thể không tồn tại trong `travel.places` (dữ liệu
  crawl cũ) → cột rỗng, embedding vẫn chạy bình thường, chỉ kém giàu ngữ cảnh hơn chút.
