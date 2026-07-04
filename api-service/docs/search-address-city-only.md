# Search — Kết quả chỉ hiển thị Tỉnh/TP (không load địa chỉ đầy đủ)

> Ngày: 2026-07-04
> Phạm vi: chỉ `api-service` (backend) — mobile **không cần sửa**.
> Liên quan: [search-rating-sort.md](./search-rating-sort.md) (sort mặc định theo rating + review).

## 1. Mục tiêu

- Kết quả search (`GET /search/all`, `GET /search/results`) **không trả địa chỉ đầy đủ** nữa, chỉ trả **tên tỉnh/thành phố** của địa điểm.
- Địa chỉ đầy đủ chỉ xem ở **màn chi tiết địa điểm** (endpoint place detail riêng, không thuộc thay đổi này).
- Lợi ích phụ: giảm payload — cột `address` là text dài, bỏ khỏi select giúp DB đọc/truyền ít dữ liệu hơn trên tối đa 2000 dòng mỗi lần search.

## 2. Thay đổi — `src/modules/search/search.service.ts`

### 2.1. `placesSelect` (dùng bởi `queryPlaces` / `queryPlacesPrefix`)

- **Bỏ cột `address`** khỏi câu select:

```
// Trước
'id, name, address, average_rating, review_count, image_url, city_id, types(...)'
// Sau
'id, name, average_rating, review_count, image_url, city_id, types(...)'
```

### 2.2. `mapPlaceItem`

- Trường `address` trong response giờ được gán **tên tỉnh/TP** (map từ `city_id` → `travel.cities.name`, vốn đã có sẵn qua `buildCityMap` — không thêm query nào):

```ts
const cityName = cityMap.get(String(place.city_id ?? '')) ?? '';
address: cityName,  // trước: String(place.address ?? '')
city: cityName,     // giữ nguyên như cũ
```

- **Giữ nguyên key `address`** trong JSON response → tương thích ngược hoàn toàn: mobile (các card `ActivityVerticalCard` / `RestaurantVerticalCard` / `HotelVerticalCard` render `item.address`) tự động hiển thị "Đà Lạt", "Hà Nội"… thay vì địa chỉ dài, không phải sửa dòng nào.

## 3. Những phần KHÔNG đổi (chủ đích)

| Phần | Lý do giữ nguyên |
|---|---|
| `GET /search/nearby` (`getNearbyPlaces`) | Dùng cho bản đồ/gợi ý quanh vị trí — cần địa chỉ đầy đủ để định vị. |
| `GET /search/autocomplete` | Vốn đã chỉ trả `city`, không có address. |
| `GET /search/filter`, `searchAdvanced` | RPC passthrough, không thuộc luồng kết quả search này. |
| Endpoint chi tiết địa điểm (module place) | Nơi duy nhất hiển thị địa chỉ đầy đủ — đúng yêu cầu. |
| Mobile | Không cần sửa: card đọc `address` từ API, filter tỉnh/TP đọc `city` — cả hai giờ cùng giá trị tên tỉnh/TP. |

## 4. Hành vi hiển thị trên mobile sau thay đổi

- Card kết quả search: dòng địa chỉ (icon 📍) hiển thị tên tỉnh/TP.
- Địa điểm chưa gán `city_id`: `address` = chuỗi rỗng → card hotel/activity tự ẩn dòng địa chỉ (đã có check `isNotEmpty`/`hasAddress` sẵn).
- Bấm vào địa điểm → `PlaceDetailScreen` fetch chi tiết theo `placeId` → thấy địa chỉ đầy đủ.

## 5. Đã kiểm tra

- `npx tsc --noEmit` (api-service): **pass, 0 lỗi**.
- Không còn chỗ nào trong luồng search all/results tham chiếu `place.address` (chỗ duy nhất còn lại là `getNearbyPlaces` — chủ đích giữ).
