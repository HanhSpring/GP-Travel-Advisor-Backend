# recommender_artifacts/

Đặt **toàn bộ artifact do `Offline_recommender.ipynb` sinh ra** (thư mục
`recommender_artifacts/` của notebook) vào đây. Service load 1 lần lúc khởi động.

## File bắt buộc

| File | Ý nghĩa |
|------|---------|
| `serve_manifest.json` | `global_mean`, `n_factors`, trọng số hybrid mặc định |
| `cf_user_factors.npy` | P — (num_users × n_factors) |
| `cf_item_factors.npy` | Q — (num_items × n_factors) |
| `cf_user_bias.npy` | b_u |
| `cf_item_bias.npy` | b_i |
| `cf_user_ids.csv` | cột `UserID` (int) theo hàng P |
| `cf_item_ids.csv` | cột `id` (UUID) theo cột Q |
| `cf_city_to_item_idx.pkl` | city_name → chỉ số item trong city |
| `cb_lookup_foody_rich.pkl` | place_id → top-50 CB cùng city |

## Tùy chọn (không bắt buộc)

| File | Ghi chú |
|------|---------|
| `cf_item_latlon.npy` | toạ độ theo thứ tự item (service hiện lấy toạ độ từ `Places.csv`) |
| `content_embeddings_foody_rich.npy` | chỉ cần nếu muốn tính CB ngoài top-50 (~46MB) |

> ⚠️ Tất cả file CF (`cf_item_ids.csv`, `Q`, `b_i`, `cf_city_to_item_idx.pkl`...) phải
> **cùng một lần train** — không trộn artifact của các lần train khác nhau.

`id` địa điểm là **UUID chuỗi**, phải khớp với `travel.places.id` trên Supabase.
