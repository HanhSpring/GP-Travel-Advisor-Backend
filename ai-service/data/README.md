# data/

Đặt **file gốc** mà recommender cần load thêm lúc serve vào đây:

| File | Dùng để |
|------|---------|
| `Places.csv` | `id, name, city_name, latitude, longitude, category_name, type_name` — hiển thị + lọc city + tính khoảng cách |
| `rating_matrix_foody.npz` | ma trận thưa CSR (users × items) — **mask** địa điểm user đã tương tác |

> `Places.csv` phải là **cùng bản** dùng để train notebook (cùng tập `id`).
> `id` là UUID chuỗi, khớp với `cf_item_ids.csv` và `travel.places.id` trên Supabase.
