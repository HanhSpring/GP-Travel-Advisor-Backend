# Search — Sort mặc định theo Rating + Số lượt đánh giá

> Ngày: 2026-07-04
> Phạm vi: `api-service` (backend NestJS + SQL Supabase) và `GP-Travel-Advisor-Mobile` (Flutter).

## 1. Mục tiêu

Kết quả search (autocomplete, search all, search theo loại) **mặc định sort theo địa điểm có rating cao nhất VÀ số lượt đánh giá nhiều nhất**. Trước đây:

- Backend chỉ `ORDER BY average_rating DESC` → địa điểm **5.0★ với 1 review** xếp trên **4.7★ với 500 review** (sai lệch vì rating ít review không đáng tin).
- Mobile (màn "Tất cả kết quả") ghép list phẳng theo **thứ tự loại** (lịch trình → hoạt động → nhà hàng → khách sạn), hoàn toàn không sort theo rating.

## 2. Công thức xếp hạng (dùng chung backend + mobile + SQL)

**Bayesian weighted rating** (kiểu IMDb Top 250):

```
rank = (v / (v + m)) × R  +  (m / (v + m)) × C
```

| Ký hiệu | Ý nghĩa | Giá trị |
|---|---|---|
| `R` | `average_rating` của địa điểm | 0–5 |
| `v` | `review_count` (số lượt đánh giá) | ≥ 0 |
| `m` | Ngưỡng review tối thiểu để rating "đáng tin" | **10** |
| `C` | Rating nền giả định (prior) | **3.0** |

Tính chất:

- Ít review → điểm bị kéo về mức nền `C = 3.0`; càng nhiều review → điểm càng tiến về rating thật `R`.
- Ví dụ: `5.0★ / 1 review` → rank ≈ **3.18**; `4.7★ / 500 review` → rank ≈ **4.67** → địa điểm nhiều review thắng, đúng kỳ vọng.
- Edge case: `v = 0` và `R = 0` (chưa có dữ liệu) → rank = **0**, xếp cuối (không được "ăn" điểm nền 3.0).

Tie-break khi rank bằng nhau: `rating DESC` → `reviewCount DESC` → giữ thứ tự gốc (sort ổn định).

## 3. Thay đổi Backend — `src/modules/search/search.service.ts`

### 3.1. Thêm bộ tính điểm dùng chung

- `weightedRank(rating, reviewCount)`: cài đúng công thức mục 2, hằng số `RANK_MIN_REVIEWS = 10`, `RANK_PRIOR_RATING = 3.0`.
- `sortByRank(items)`: sort **ổn định** (decorate với index gốc vì `Array.sort` không đảm bảo stable cho mọi engine cũ), rank chỉ tính **1 lần/phần tử** → O(n log n), n ≤ 2000 → không đáng kể (~vài ms).

### 3.2. `searchAll(query)` — `GET /search/all`

- Sau khi map + classify place, **sort toàn bộ bằng `sortByRank` một lần trước khi tách loại** (activities / restaurants / hotels) — `filter` giữ nguyên thứ tự nên cả 3 nhóm đều đã xếp đúng.
- Itineraries giữ nguyên sort theo `created_at DESC` (không có rating).

### 3.3. `searchByType(query, type, page, limit)` — `GET /search/results`

- **Sort `sortByRank` TRƯỚC khi phân trang** (slice offset/limit) → thứ tự giữa các trang ổn định, không trùng/sót item khi user cuộn load-more.

### 3.4. `queryPlaces` / `queryPlacesPrefix` (query DB)

- Thêm khóa sort thứ hai ở DB: `.order('average_rating', desc).order('review_count', desc)`.
- Lý do: khi bảng có > 2000 dòng khớp query, DB cắt top 2000 — thêm `review_count` làm khóa phụ để **việc cắt top lấy đúng những dòng đáng giữ**, tránh mất địa điểm nhiều review có cùng rating ở biên.

### 3.5. `autocomplete(query)` — `GET /search/autocomplete`

- Kết quả RPC được **re-sort phòng thủ** ở Node theo `score DESC → rating DESC → thứ tự RPC`: kể cả khi DB còn function bản cũ (chưa chạy migration mới) thì API vẫn trả thứ tự hợp lý nhất có thể.
- City có score 100 (prefix) / 50 (infix) nên **luôn nổi trên cùng** — đúng yêu cầu ưu tiên tỉnh/thành phố.
- `autocompleteFallback` (khi RPC lỗi/timeout): select thêm `review_count`, sort DB 2 khóa, và gán `score = weightedRank(...)` rồi sort — nhất quán với đường chính.

## 4. Thay đổi SQL — `sql/2026_search_rating_sort.sql` (MỚI — cần chạy)

Nâng cấp RPC `travel.search_autocomplete` (giữ nguyên chữ ký & cột trả về → **backend không cần đổi mapping**, tương thích ngược hoàn toàn):

- **Score của PLACE** đổi từ `prefix_boost + rating/5` thành:
  `prefix_boost (3) + Bayesian(rating, review_count) / 5` — đúng công thức mục 2, tính ngay trong SQL.
- `ORDER BY score DESC, rating DESC, review_count DESC` (thêm 2 khóa phụ để thứ tự ổn định).
- Score CITY giữ nguyên 100/50 → city vẫn đứng đầu.
- Thêm index `idx_places_rating_reviews (average_rating DESC, review_count DESC)` hỗ trợ các truy vấn top-N sort theo 2 cột này (không bắt buộc nhưng vô hại, `IF NOT EXISTS`).
- Vẫn dùng `EXECUTE format(...)` với mẫu LIKE là hằng → planner chắc chắn dùng **GIN trigram index** (đã tạo ở `2026_search_optimization.sql`) → giữ hiệu năng sub-100ms trên bảng 45k+ dòng.

**Cách chạy:** Supabase Dashboard → SQL Editor → dán toàn bộ file `sql/2026_search_rating_sort.sql` → Run. Script idempotent, chạy lại nhiều lần không lỗi. Yêu cầu đã chạy `2026_search_optimization.sql` trước đó (để có `immutable_unaccent` + index trigram).

**Kiểm tra nhanh sau khi chạy:**

```sql
select * from travel.search_autocomplete('ha noi', 20);
select * from travel.search_autocomplete('pho', 20);
```

Kỳ vọng: city đứng đầu; place rating cao + nhiều review có score lớn hơn place rating cao nhưng ít review.

## 5. Thay đổi Mobile — `lib/features/search/presentation/cubit/search_all_cubit.dart`

Màn "Tất cả kết quả" (`SearchAllScreen`) hiển thị list phẳng từ `SearchAllCubit`:

- Thêm `_weightedRank(rating, reviewCount)` — **cùng công thức, cùng hằng số** (m=10, C=3.0) với backend.
- `_rankOf(item)`: lấy rating/reviewCount từ `CityActivity` / `CityRestaurant` / `CityHotel`; **itinerary không có rating → rank = -1, xếp sau toàn bộ địa điểm**, giữ nguyên thứ tự mới-nhất-trước mà backend trả về.
- `_sortByRank(items)`: sort ổn định (tie-break bằng index gốc, vì `List.sort` của Dart **không stable**) → thứ tự không nhảy lung tung giữa các lần build.
- Áp dụng trong `loadAll()` trước khi `emit` state `loaded` → mọi filter (theo loại, theo thành phố) và load-more về sau đều giữ đúng thứ tự đã xếp vì `filteredItems()` chỉ `where` (không sort lại).

Màn phân trang theo loại (`searchByType`) không cần sửa — backend đã sort trước khi phân trang (mục 3.3).

## 6. Hiệu năng

| Điểm | Đánh giá |
|---|---|
| Sort ở DB (autocomplete RPC) | Tính score trong cùng 1 query, tận dụng index trigram sẵn có; không thêm round-trip. |
| Sort ở Node (`searchAll`/`searchByType`) | Sort in-memory ≤ 2000 phần tử, rank precompute 1 lần/phần tử → ~vài ms, không thêm query DB nào. |
| `.order('review_count')` thêm ở DB | Chỉ thêm khóa sort phụ trên tập đã lọc, chi phí không đáng kể. |
| Index mới `idx_places_rating_reviews` | `IF NOT EXISTS`, tạo 1 lần; giúp top-N sort ở fallback prefix. |
| Sort ở Mobile | List đã fetch sẵn (≤ ~2050 item), sort O(n log n) một lần khi load → không ảnh hưởng khung hình. |

## 7. Khả năng chịu lỗi (backward compatibility)

- **Chưa chạy migration SQL mới:** RPC cũ vẫn chạy (cùng chữ ký); backend re-sort theo score/rating nên kết quả vẫn hợp lý. Chạy migration xong thì score có thêm trọng số review_count.
- **RPC lỗi/timeout:** fallback đã tự tính `weightedRank` ở Node → hành vi sort giống đường chính.
- **Dữ liệu thiếu:** `rating`/`review_count` null/âm được coalesce về 0; place chưa có dữ liệu (0★, 0 review) xếp cuối thay vì hưởng điểm nền.

## 8. File thay đổi

| File | Thay đổi |
|---|---|
| `api-service/src/modules/search/search.service.ts` | Thêm `weightedRank` + `sortByRank`; sort trong `searchAll`, `searchByType`, `autocomplete` (re-sort + fallback); thêm `.order('review_count')` ở 3 query places. |
| `api-service/sql/2026_search_rating_sort.sql` | **MỚI** — nâng cấp score RPC `search_autocomplete` theo Bayesian(rating, review_count); index phụ. **Cần chạy trên Supabase.** |
| `Mobile/lib/features/search/presentation/cubit/search_all_cubit.dart` | Sort list phẳng theo weighted rank; itinerary xếp sau địa điểm. |

## 9. Đã kiểm tra

- `npx tsc --noEmit` (api-service): **pass, 0 lỗi**.
- `flutter analyze lib/features/search`: **No issues found**.
