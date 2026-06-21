# Search — Toàn bộ Logic

## Tổng quan kiến trúc

```
Mobile (Flutter)
  └── SearchScreen / SearchAllScreen
      └── SearchAllCubit  ──▶  SearchAllUseCase
                                   └── SearchRepository
                                           └── SearchRemoteDataSource  ──▶  HTTP
                                                                              │
Backend (NestJS)                                                              │
  └── SearchController  ◀────────────────────────────────────────────────────┘
          └── SearchService
                  └── Supabase (travel schema)
```

---

## Backend

### API Endpoints (`SearchController`)

| Method | Path | Tham số | Mô tả |
|--------|------|---------|-------|
| `GET` | `/search/autocomplete` | `q: string` | Gợi ý tên địa điểm / thành phố khi gõ |
| `GET` | `/search/all` | `q: string` | Tìm tất cả loại — trả về top 50 lịch trình + tất cả địa điểm |
| `GET` | `/search/results` | `q, type, page, limit` | Tìm phân trang cho 1 loại cụ thể |
| `GET` | `/search/filter` | `city, category` | Lọc địa điểm theo tỉnh/TP và danh mục |
| `GET` | `/search/nearby` | `lat, lng, limit?, excludeIds?, preferCategory?, radius?` | Địa điểm gần vị trí hiện tại |

---

### SearchService — Chi tiết từng method

#### 1. `autocomplete(query)`

**Mục đích:** Gợi ý tên trong thanh tìm kiếm khi user đang gõ.

**Flow:**
```
query → RPC travel.search_autocomplete(p_query)  ──[≤ 2500ms]──▶ trả kết quả
                                                                │
                                                   timeout / lỗi
                                                                │
                                                                ▼
                                               autocompleteFallback(q)
                                               └── places ILIKE 'q%'  (prefix, B-tree)
                                                   limit 15, order by rating DESC
```

**Race condition:** Dùng `Promise.race` giữa RPC và timeout 2.5 giây. Nếu RPC không kịp trả về → fallback prefix search chạy ngay, không chờ timeout của PostgreSQL (~5-10s).

**Kết quả trả về (`AutocompleteItem[]`):**
```typescript
{
  id: string
  name: string
  type: 'place' | 'city'
  image: string      // rỗng với city
  city: string       // tên tỉnh/TP của địa điểm
  rating: number
  score: number      // relevance score từ RPC
}
```

---

#### 2. `searchAll(query)`

**Mục đích:** Tìm đồng thời tất cả loại khi user xem "Xem tất cả kết quả".

**Flow:**
```
query
  ├── queryItineraries(q, page=1, limit=50)  ─┐ Promise.all (song song)
  └── queryPlaces(q, maxRows=2000)            ─┘
        │
        ├── nếu rawPlaces rỗng (infix timeout / no GIN index)
        │       └── queryPlacesPrefix(q, 500)   // ILIKE 'q%' — prefix fallback
        │
        └── buildCityMap(rawPlaces)
              └── batch fetch cities bảng travel.cities

classify rawPlaces → activities / restaurants / hotels

return {
  itineraries: { data, total }
  activities:  { data, total }
  restaurants: { data, total }
  hotels:      { data, total }
}
```

---

#### 3. `searchByType(query, type, page, limit)`

**Mục đích:** Phân trang khi user filter theo 1 loại.

**Logic:**
- `type === 'itinerary'` → gọi `queryItineraries(q, page, limit)` trực tiếp
- Còn lại: `queryPlaces` → infix fallback prefix → lọc theo `placeType === type` → slice theo page/limit

**Trả về:**
```typescript
{ data, total, page, pages }
```

---

#### 4. `queryItineraries(q, page, limit)`

**Bảng:** `travel.itineraries`

**Điều kiện bắt buộc:**
- `is_public = true`
- `status = 'completed'`
- `description ILIKE '%q%'` OR `destination ILIKE '%q%'`

**Các bước sau query:**
1. Lấy danh sách `creator_id` → `fetchCreatorNames()` → Map id→full_name
2. Lấy danh sách `itinerary_id` → `fetchItineraryImages()` → Map id→image_url (lấy ảnh từ `itinerary_details` join `places`)
3. Map kết quả:
```typescript
{
  id, title (= description || destination || 'Lịch trình'),
  authorName, authorAvatar (pravatar.cc),
  imageUrl, duration ("N NGÀY"),
  destination, views: '0', likes: '0'
}
```

---

#### 5. `queryPlaces(q)` / `queryPlacesPrefix(q)` (infix/prefix fallback)

| Method | Pattern | Index cần | Tốc độ |
|--------|---------|-----------|--------|
| `queryPlaces` | `ILIKE '%q%'` | GIN trigram | Nhanh nếu có GIN, timeout nếu chưa |
| `queryPlacesPrefix` | `ILIKE 'q%'` | B-tree tiêu chuẩn | Luôn nhanh |

**SELECT fields:** `id, name, address, average_rating, review_count, image_url, city_id, types(id, category_id, categories(id, name))`

**Phân loại (`classifyPlaceType`):**

| Keyword trong category | Loại |
|------------------------|------|
| lưu trú, khách sạn, homestay, resort, nhà nghỉ, căn hộ, bungalow... | `hotel` |
| ẩm thực, nhà hàng, quán ăn, cà phê, cafe, trà sữa, buffet... | `restaurant` |
| Còn lại | `activity` |

---

#### 6. `getNearbyPlaces(lat, lng, limit, excludeIds, preferCategory, radius)`

**Logic:**
1. Tính bounding box từ `radius` (km) → `latDelta`, `lngDelta`
2. Query bảng `places` với bộ lọc bounding box (gte/lte lat/lng)
3. Tính Haversine distance chính xác cho từng kết quả
4. Lọc bỏ những điểm vượt quá `radius` km
5. Sắp xếp: cùng `preferCategory` → ưu tiên trước, còn lại → sắp xếp theo khoảng cách

---

### Phân loại địa điểm (`mapPlaceItem`)

Sau khi classify `placeType`, map sang các shape khác nhau:

```typescript
// activity
{ id, name, imageUrl, rating, reviewCount, address, city, placeType,
  status: 'Đang mở cửa', category: catName, priceType: 'free', district: '' }

// restaurant
{ ...base, status: 'Đang mở cửa', cuisine: 'vietnamese', priceLevel: 'mid_range', amenities: [] }

// hotel
{ ...base, price: 'Liên hệ', starRating: 4, priceValue: 0, accommodationType: 'hotel', amenities: [] }
```

**City resolution:** không JOIN (tránh timeout). Thay vào đó: lấy `city_id` → `buildCityMap()` → batch-fetch bảng `cities` một lần.

---

## Mobile (Flutter)

### Entities & Types

**`SearchType` (enum):**
```dart
enum SearchType { itinerary, activity, restaurant, hotel }
```

**`FlatSearchItem`:**
```dart
class FlatSearchItem {
  final SearchType type;
  final String id;
  final dynamic data;   // CityItinerary | CityActivity | CityRestaurant | CityHotel
  final String city;
}
```

**`SearchMultiResults`:**
```dart
class SearchMultiResults {
  final SearchTypeCount<CityItinerary> itineraries;
  final SearchTypeCount<CityActivity> activities;
  final SearchTypeCount<CityRestaurant> restaurants;
  final SearchTypeCount<CityHotel> hotels;
  final Map<String, String> cityById;
}
```

---

### SearchAllState (Freezed)

```dart
SearchAllState.initial()
SearchAllState.loading()
SearchAllState.loaded(
  allItems: List<FlatSearchItem>,  // toàn bộ kết quả phẳng
  cities: List<String>,            // danh sách tỉnh/TP để filter
  query: String,
  typeFilter: SearchType?,
  cityFilter: String?,
  displayedCount: int = 10,        // infinite scroll — số item đang hiển thị
)
SearchAllState.error(String message)
```

---

### SearchAllCubit — Methods

| Method | Hành động |
|--------|-----------|
| `loadAll(query)` | Gọi API `/search/all`, flatten kết quả vào `allItems`, emit `loaded` |
| `loadMore()` | Tăng `displayedCount` thêm 10 (infinite scroll) |
| `applyTypeFilter(type?)` | Cập nhật `typeFilter`, reset `displayedCount = 10` |
| `applyCityFilter(city?)` | Cập nhật `cityFilter`, reset `displayedCount = 10` |
| `filteredItems(state)` | Lọc `allItems` theo `typeFilter` + `cityFilter` hiện tại |

**`filteredItems` logic:**
```dart
// Loại không khớp → loại bỏ
if (typeFilter != null && item.type != typeFilter) return false;
// Item không có city → luôn pass city filter
if (cityFilter != null && item.city.isNotEmpty && item.city != cityFilter) return false;
return true;
```

---

### SearchRemoteDataSource

**Timeout đặc biệt:**
- `GET /search/autocomplete`: `receiveTimeout: 30s` (RPC có thể chậm)
- `GET /search/all`: `receiveTimeout: 45s`

**Parse itinerary từ JSON:**
```dart
// cityById map: dùng destination của itinerary làm "city" để filter tỉnh/TP
for (final raw in itinList) {
  cityById[raw['id']] = raw['destination'] ?? '';
}
```

**`_parseItineraries`:** `CityItineraryModel.fromJson(item).toEntity()`

---

### SearchAllScreen — UI Flow

```
SearchAllScreen
  └── BlocProvider(create: SearchAllCubit..loadAll(query))
      └── _SearchAllView (StatefulWidget)
          ├── AppBar: tiêu đề query (2 dòng) + nút filter (chấm đỏ nếu có filter)
          ├── ScrollController → listener → cubit.loadMore() khi cách cuối 200px
          └── BlocBuilder<SearchAllCubit>
              ├── loading → CircularProgressIndicator
              ├── error   → thông báo + nút "Thử lại"
              └── loaded  → Column
                    ├── "N kết quả"
                    └── _FlatList(items: allFiltered.take(displayedCount))
                          └── ListView.builder
                                ├── item → GestureDetector → _navigateToDetail
                                └── last item (hasMore) → spinner
```

**Filter bottom sheet (`_FilterSheet`):**
- Dropdown "Loại hình": Tất cả / Lịch trình / Hoạt động tham quan / Nhà hàng/Quán ăn / Khách sạn / Lưu trú
- Dropdown "Tỉnh / Thành phố": từ danh sách `cities` trong state
- Nút "Áp dụng" → `cubit.applyTypeFilter` + `cubit.applyCityFilter`
- Nút "Đặt lại" → clear cả hai filter

---

### Navigation từ kết quả tìm kiếm

```dart
// Lịch trình
MultiBlocProvider(
  providers: [
    BlocProvider(create: (_) => sl<ItineraryCubit>()),
    BlocProvider(create: (_) => sl<TrackingCubit>()),  // bắt buộc — summary screen đọc cả hai
  ],
  child: ItinerarySummaryScreen(itineraryId: item.id),
)

// Địa điểm (activity / restaurant / hotel)
BlocProvider(
  create: (_) => sl<PlaceDetailCubit>(),
  child: PlaceDetailScreen(placeId: item.id),
)
```

> **Lý do cần `TrackingCubit`:** `ItinerarySummaryScreen._navigateToDetail` gọi `context.read<TrackingCubit>()` để truyền xuống `ItineraryDetailScreen`. Nếu thiếu → `ProviderNotFoundException` crash.

---

### Card UI theo loại (SearchAllScreen / city_detail)

| Loại | Widget | Layout |
|------|--------|--------|
| Lịch trình | `ItineraryVerticalCard` | Ngang compact — ảnh 100×100 trái, 4 hàng: tiêu đề + label "Lịch trình", thời lượng + tác giả, địa điểm, lượt thích |
| Hoạt động | `ActivityVerticalCard` | Ngang compact — ảnh 100×100 trái, 4 hàng: tên + heart, sao + review, địa chỉ, trạng thái |
| Nhà hàng | `RestaurantVerticalCard` | Ngang compact — cấu trúc giống Activity |
| Khách sạn | `HotelVerticalCard` | Ngang compact — cấu trúc giống Activity, ẩn dòng giá nếu = "Liên hệ" |

---

## Infinite Scroll

```
Scroll listener (cách cuối 200px)
  └── cubit.loadMore()
        └── state.displayedCount + 10
              └── dừng khi displayedCount >= allFiltered.length

_FlatList render: allFiltered.take(displayedCount).toList()
  └── khi hasMore = true → thêm spinner ở cuối ListView
```

---

## SQL Migration cần thiết (`2026_search_optimization.sql`)

Để infix search (`ILIKE '%q%'`) chạy nhanh, cần chạy migration trên Supabase:

1. `CREATE EXTENSION IF NOT EXISTS pg_trgm, unaccent`
2. `CREATE FUNCTION travel.immutable_unaccent` (dùng `public.unaccent` — phải qualify schema)
3. GIN trigram index trên `immutable_unaccent(name)` của bảng `places`
4. B-tree prefix index (`text_pattern_ops`) cho `ILIKE 'q%'`
5. Index composite `(is_approved, is_active)`
6. DROP + CREATE `travel.search_autocomplete` RPC

> Sau khi có GIN index, cả infix search lẫn autocomplete chạy dưới 100ms. Prefix fallback vẫn giữ trong code để đề phòng.

---

## Files liên quan

### Backend
| File | Vai trò |
|------|---------|
| `src/modules/search/search.controller.ts` | 5 endpoints: autocomplete, all, results, filter, nearby |
| `src/modules/search/search.service.ts` | Toàn bộ business logic |
| `src/modules/search/dto/search.dto.ts` | `SearchQueryDto { q }` |
| `src/modules/search/dto/search-filter.dto.ts` | `SearchFilterDto { city, category }` |
| `src/modules/search/dto/search-response.dto.ts` | `AutocompleteItemDto`, `SearchResultDto` |
| `sql/2026_search_optimization.sql` | GIN index, unaccent function, autocomplete RPC |

### Mobile
| File | Vai trò |
|------|---------|
| `features/search/domain/entities/search_results.dart` | `SearchType`, `FlatSearchItem`, `SearchMultiResults`, `SearchPageResult` |
| `features/search/domain/usecases/search_all_usecase.dart` | Thin wrapper gọi repository |
| `features/search/data/datasources/search_remote_datasource.dart` | HTTP calls + JSON parsing |
| `features/search/presentation/cubit/search_all_state.dart` | State (Freezed) với `displayedCount` |
| `features/search/presentation/cubit/search_all_cubit.dart` | `loadAll`, `loadMore`, `applyTypeFilter`, `applyCityFilter`, `filteredItems` |
| `features/search/presentation/screens/search_all_screen.dart` | UI: list, infinite scroll, filter sheet, navigation |
| `features/city_detail/presentation/widgets/itinerary_vertical_card.dart` | Card lịch trình ngang compact |
| `features/city_detail/presentation/widgets/activity_vertical_card.dart` | Card hoạt động ngang compact |
| `features/city_detail/presentation/widgets/restaurant_vertical_card.dart` | Card nhà hàng ngang compact |
| `features/city_detail/presentation/widgets/hotel_vertical_card.dart` | Card khách sạn ngang compact |
