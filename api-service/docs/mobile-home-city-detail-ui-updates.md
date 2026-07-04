# Mobile — Chỉnh sửa UI thẻ địa điểm (Home + City Detail)

> Ngày: 2026-07-04
> Phạm vi: chỉ **GP-Travel-Advisor-Mobile** — không đụng backend.
> Liên quan: [search-rating-sort.md](./search-rating-sort.md), [search-address-city-only.md](./search-address-city-only.md).

## 1. Trang Home

### 1.1. Xem tất cả "Nhà hàng tiêu biểu" — bỏ text "Chưa có giờ mở cửa"

Nguồn gốc chuỗi này: backend `explore.service.ts` (hàm `getPlaceOpenStatus`) trả `"Chưa có giờ mở cửa"` khi địa điểm thiếu dữ liệu giờ mở cửa — không phải fallback phía mobile.

- `lib/features/home/data/datasources/home_datasource.dart` — `_mapRestaurant`:
  - Bỏ fallback `'Chưa có giờ mở cửa'` khi API không trả status.
  - Lọc luôn trường hợp backend trả đúng chuỗi `"Chưa có giờ mở cửa"` → coi như status rỗng.
- `lib/features/city_detail/presentation/widgets/restaurant_vertical_card.dart`:
  - Dòng status chỉ render khi có nội dung (`status.trim().isNotEmpty`) — status rỗng thì ẩn hẳn, không chừa khoảng trống.
  - Status thật ("Đang mở cửa" / "Đã đóng cửa") vẫn hiển thị bình thường ở mọi màn dùng chung card này.

### 1.2. "Khách sạn nổi bật" — luôn hiển thị giá, đặt trên địa chỉ

Yêu cầu: load phần giá ở cả ngoài home và trong xem tất cả; chưa có data giá thì hiển thị placeholder **"Liên hệ giá"** (sẽ bổ sung data giá sau — backend trả `price`/`min_price` trong `/explore/places` là giá thật tự hiển thị, không cần sửa thêm mobile).

- **Ngoài home** (`city_detail_cards.dart` → `HotelCard`): đã hiển thị "Liên hệ giá" sẵn từ trước — không sửa.
- **Trong xem tất cả** (`lib/features/city_detail/presentation/widgets/hotel_vertical_card.dart`):
  - Trước: dòng giá bị **ẩn** khi `price` rỗng hoặc bằng `'Liên hệ'`.
  - Sau: luôn hiển thị — có giá thật thì `Từ 5.450.000đ`, chưa có thì `Liên hệ giá` (màu primary, weight 600).
  - Dòng giá được đưa **lên trên** dòng địa chỉ. Thứ tự card: tên → rating/đánh giá → **giá** → địa chỉ.

## 2. Trang City Detail

Dữ liệu city detail lấy từ `GET /explore/cities/:cityId/overview`, được chuẩn hóa tại `RemoteCityDetailDataSource` (`lib/features/city_detail/data/datasources/city_detail_mock_data_source.dart`). Các chỉnh sửa đặt ở **datasource** nên có hiệu lực cho cả thẻ ngang trong section lẫn danh sách xem tất cả của city detail, và **không ảnh hưởng màn nào khác** (search, home dùng datasource riêng).

### 2.1. Rút gọn địa chỉ — chỉ hiển thị Phường/Xã (bỏ tỉnh/TP thừa)

Áp dụng cho cả 3 loại thẻ: hoạt động tham quan & giải trí, nhà hàng tiêu biểu, khách sạn & chỗ ở.

Helper mới `_shortAddress(address)`:

1. Tách địa chỉ theo dấu phẩy.
2. Bỏ `"Việt Nam"` ở cuối nếu có.
3. **Ưu tiên** trả về phần bắt đầu bằng `Phường / P. / Xã / X. / Thị trấn / TT.` nếu tách được.
4. Không tách được Phường/Xã → **bỏ phần cuối** (tên tỉnh/TP — thừa vì đang ở trong city detail của tỉnh đó), giữ phần còn lại.
5. Địa chỉ chỉ có 1 phần (không có dấu phẩy) → giữ nguyên.

Ví dụ:
- `"86 Trần Phú, Phường Lộc Thọ, Nha Trang, Khánh Hòa"` → `"Phường Lộc Thọ"`
- `"86 Trần Phú, Lộc Thọ, Nha Trang, Khánh Hòa"` (không có chữ Phường) → `"86 Trần Phú, Lộc Thọ, Nha Trang"`
- `"Quận 1, TP.HCM"` → `"Quận 1"`

Áp dụng trong `_normalizeActivity`, `_normalizeRestaurant`, `_normalizeHotel` (hotel áp dụng sau khi đã fallback `city`/`location`).

### 2.2. Bỏ "Chưa có giờ mở cửa" trong xem tất cả hoạt động + nhà hàng

Helper mới `_readStatus(value)`: nếu backend trả đúng chuỗi `"Chưa có giờ mở cửa"` → trả chuỗi rỗng. Card (`ActivityVerticalCard`, `RestaurantVerticalCard`) đã có sẵn check ẩn dòng status rỗng nên không cần sửa thêm widget. Áp dụng trong `_normalizeActivity` và `_normalizeRestaurant`.

### 2.3. Chỉnh UI rating + review count trong xem tất cả hoạt động

`lib/features/city_detail/presentation/widgets/activity_vertical_card.dart` — `_ActivityRatingRow`:

- Trước: icon sao + số rating + `(1.2k)` dạng text thường.
- Sau: **2 pill** đồng bộ style với `RestaurantVerticalCard` / `HotelVerticalCard`:
  - Pill 1: ⭐ `4.5`
  - Pill 2: 📝 `1.2k đánh giá`
  - (nền `#F8FAFC`, viền `#E2E8F0`, chữ `#334155` đậm — tái dùng `_StatPill` có sẵn trong file)
- `_DestinationStatsRow` (chế độ `showDestinationStats` của màn khác) giữ nguyên.

## 3. File thay đổi

| File | Thay đổi |
|---|---|
| `Mobile/lib/features/home/data/datasources/home_datasource.dart` | `_mapRestaurant`: lọc status "Chưa có giờ mở cửa" → rỗng. |
| `Mobile/lib/features/city_detail/presentation/widgets/restaurant_vertical_card.dart` | Ẩn dòng status khi rỗng. |
| `Mobile/lib/features/city_detail/presentation/widgets/hotel_vertical_card.dart` | Luôn hiển thị dòng giá ("Từ ..." / "Liên hệ giá"), đặt trên địa chỉ. |
| `Mobile/lib/features/city_detail/data/datasources/city_detail_mock_data_source.dart` | Thêm `_shortAddress` + `_readStatus`; áp dụng cho activity/restaurant/hotel trong `RemoteCityDetailDataSource`. |
| `Mobile/lib/features/city_detail/presentation/widgets/activity_vertical_card.dart` | `_ActivityRatingRow` đổi sang pill style đồng bộ các card khác. |

## 4. Đã kiểm tra

- `flutter analyze` trên toàn bộ file đã sửa: **No issues found** (các warning/info còn lại là của file khác, có từ trước).
- Lưu ý khi test: cần **hot restart** (không chỉ hot reload) vì thay đổi nằm ở datasource mapping; city detail có cache overview trong session (`_overviewCache`) nên mở lại màn city detail mới thấy data mới.
