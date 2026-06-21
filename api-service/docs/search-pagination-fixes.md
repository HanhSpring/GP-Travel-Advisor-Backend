# Search — Pagination, Filter & Performance Fixes

## Tổng quan

Session này tập trung vào màn hình "Xem tất cả kết quả" (`SearchAllScreen`): thêm phân trang vô hạn (infinite scroll), filter tỉnh/TP, sửa UI thẻ khách sạn, và xử lý toàn bộ vấn đề timeout của autocomplete + search/all.

---

## 1. Phân trang vô hạn (Infinite Scroll)

### State (`search_all_state.dart`)
Thêm field `@Default(10) int displayedCount` vào `SearchAllState.loaded`.  
Sau khi thêm phải xóa file `.freezed.dart` cũ rồi chạy lại:
```
dart run build_runner build --delete-conflicting-outputs
```

### Cubit (`search_all_cubit.dart`)
- **`loadMore()`** — tăng `displayedCount` thêm 10, dừng khi đã hiển thị hết.
- **`applyTypeFilter()`** và **`applyCityFilter()`** — reset `displayedCount = 10` khi filter thay đổi.

### Screen (`search_all_screen.dart`)
- `_SearchAllView` chuyển từ `StatelessWidget` → `StatefulWidget` để giữ `ScrollController`.
- Listener scroll: khi cuộn đến cách cuối 200px → gọi `cubit.loadMore()`.
- Trong `state.when(loaded: ...)` thêm tham số thứ 6 `displayedCount`.
- Hiển thị `allFiltered.take(displayedCount).toList()` thay vì toàn bộ list.
- `_FlatList` nhận thêm `hasMore` + `scrollController`; khi `hasMore = true` hiển thị spinner ở cuối list.

---

## 2. Filter Tỉnh/TP hoạt động đúng

**Nguyên nhân rỗng**: trước đây `mapPlaceItem` hardcode `city: ''` vì join `cities:city_id(name)` gây timeout khi kết hợp với `ILIKE '%q%'`.

**Giải pháp** (backend `search.service.ts`):
1. Thêm `city_id` vào `SELECT` của `queryPlaces` (không JOIN).
2. Sau khi có `rawPlaces`, batch-fetch tên thành phố qua `buildCityMap()`:
   - Lấy danh sách `city_id` unique từ kết quả.
   - Query bảng `cities` (nhỏ, ~63 tỉnh/TP) một lần duy nhất bằng `.in('id', cityIds)`.
   - Trả về `Map<id, name>`.
3. `mapPlaceItem(place, cityMap)` giờ resolve city từ map thay vì để rỗng.
4. Cả `searchAll` và `searchByType` đều dùng pattern này.

---

## 3. Load hết kết quả (bỏ giới hạn 300)

`queryPlaces(q, 300)` → `queryPlaces(q, 2000)`. Supabase max row per request là 1000 (hoặc theo cấu hình project), nhưng giới hạn 2000 đảm bảo lấy được hết các kết quả thực tế.

---

## 4. Sửa UI thẻ Khách sạn

`HotelVerticalCard` trước đây là thẻ dọc lớn (16:9 ảnh trên đầu + nội dung bên dưới). Được viết lại thành layout **ngang compact** giống `ActivityVerticalCard` và `RestaurantVerticalCard`:
- Ảnh thumbnail 100×100 bên trái.
- Tên + sao + địa chỉ + giá bên phải.
- Xóa bỏ nút favorite dạng circle, dùng icon thông thường.
- Dòng giá ẩn khi giá = "Liên hệ".

---

## 5. Đổi nhãn filter

Trong `_FilterSheet._typeOptions`:
```
'Nhà hàng'  →  'Nhà hàng/Quán ăn'
```

---

## 6. Sửa timeout Autocomplete

### Vấn đề
- `search_autocomplete` RPC trên Supabase gọi `ILIKE '%q%'` không có GIN index → full sequential scan 45k dòng → PostgreSQL statement_timeout (code `57014`).
- Backend bắt lỗi và gọi `autocompleteFallback`, nhưng Supabase phải chờ hết timeout (~5-10s) mới trả về lỗi → tổng thời gian > 15s → Dio trên mobile bị receive timeout.

### Giải pháp

**Backend** — `Promise.race` với 2.5s:
```typescript
const rpcResult = await Promise.race([
  supabase.schema('travel').rpc('search_autocomplete', { p_query: q }),
  new Promise((resolve) =>
    setTimeout(() => resolve({ data: null, error: new Error('rpc_timeout') }), 2500)
  ),
]);
if (rpcResult.error || !rpcResult.data) return this.autocompleteFallback(q);
```
RPC có tối đa 2.5s để trả về. Nếu không kịp → ngay lập tức dùng fallback (prefix search).

**Mobile** — Tăng `receiveTimeout` cho endpoint autocomplete:
```dart
options: Options(receiveTimeout: const Duration(seconds: 30)),
```

---

## 7. Sửa timeout Search/All trả về rỗng

### Vấn đề
`queryPlaces` với `ILIKE '%q%'` không có GIN index → timeout → trả về `[]` im lặng → `searchAll` trả về `{activities: [], restaurants: [], hotels: []}`.

### Giải pháp — Infix + Prefix fallback

```typescript
// searchAll
let rawPlaces = await this.queryPlaces(q, 2000);       // ILIKE '%q%'
if (!rawPlaces.length)
  rawPlaces = await this.queryPlacesPrefix(q, 500);    // ILIKE 'q%'
```

`queryPlacesPrefix` dùng `ILIKE 'q%'` (prefix-only) — không cần GIN index, dùng được B-tree index tiêu chuẩn → nhanh hơn nhiều.

**Giải thích sự khác biệt**:
| Query | Index cần | Kết quả |
|---|---|---|
| `ILIKE '%bánh%'` | GIN trigram | Khớp "bánh" ở bất kỳ vị trí nào |
| `ILIKE 'bánh%'` | B-tree | Chỉ khớp từ đầu tên |

---

## 8. SQL Migration (`2026_search_optimization.sql`)

**Fix lỗi khi chạy trên Supabase**:
```sql
-- Lỗi: function unaccent(text) does not exist
-- Extension unaccent cài vào schema public, cần qualify đầy đủ:
select public.unaccent(lower(txt));   -- ✅
select unaccent(lower(txt));           -- ❌
```

### Nội dung migration (cần chạy toàn bộ file):
1. `CREATE EXTENSION pg_trgm, unaccent`
2. `CREATE FUNCTION travel.immutable_unaccent` (dùng `public.unaccent`)
3. GIN trigram index trên `immutable_unaccent(name)` — cho phép `ILIKE '%q%'` nhanh
4. B-tree prefix index (`text_pattern_ops`) — cho `ILIKE 'q%'` ngắn
5. Index composite `(is_approved, is_active)`
6. DROP + CREATE `travel.search_autocomplete` với signature mới

**Cách chạy**: Supabase Dashboard → SQL Editor → paste toàn bộ file → Run.

> Sau khi migration thành công, cả infix search và autocomplete chạy dưới 100ms. Các fallback prefix sẽ không còn cần thiết nữa.

---

## 9. AppBar Header — Hiển thị 2 dòng

```dart
appBar: AppBar(
  toolbarHeight: 80,   // tăng từ default 56 → 80
  titleSpacing: 0,
  title: Padding(
    padding: const EdgeInsets.only(right: 8),
    child: Text(
      'Kết quả tìm kiếm của "${widget.query}"',
      maxLines: 2,               // cho phép xuống dòng
      overflow: TextOverflow.ellipsis,
      style: TextStyle(height: 1.35, ...),
    ),
  ),
),
```

---

## Files đã thay đổi

| File | Thay đổi |
|---|---|
| `search_all_state.dart` | Thêm `displayedCount` |
| `search_all_state.freezed.dart` | Regenerate (xóa cũ + build_runner) |
| `search_all_cubit.dart` | Thêm `loadMore()`, reset displayedCount trong filter methods |
| `search_all_screen.dart` | StatefulWidget + ScrollController, 2-line AppBar, filter label |
| `hotel_vertical_card.dart` | Viết lại layout ngang compact |
| `search_remote_datasource.dart` | `receiveTimeout: 30s` cho autocomplete và search/all |
| `search.service.ts` | buildCityMap, queryPlacesPrefix, Promise.race autocomplete, prefix fallback |
| `2026_search_optimization.sql` | Sửa `public.unaccent` |
