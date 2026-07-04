# City Detail — Rework bộ lọc theo dữ liệu thật (bỏ mock)

> Ngày: 2026-07-04
> Phạm vi: chỉ phần **filter** của city detail trong `GP-Travel-Advisor-Mobile` — không đụng backend, không đụng phần khác.
> Backup UI mock cũ: `GP-Travel-Advisor-Mobile/docs/deprecated/city_detail_filter_mock/`

## 1. Vấn đề

Bộ lọc 3 tab (Hoạt động / Nhà hàng / Khách sạn) được xây trên **mock data** nên gần như vô dụng với dữ liệu thật:

| Filter cũ | Dữ liệu thật từ `/explore/cities/:id/overview` | Kết quả khi dùng |
|---|---|---|
| Khoảng giá activity (free/paid) | `priceType` luôn = `'free'` | Chọn "Trả phí" → rỗng |
| Khu vực (Quận 1, Quận 3... hard-code TP.HCM) | `district` luôn = tên tỉnh/TP | Chọn gì cũng rỗng |
| Món ăn nhà hàng (Việt/ngoại/chay) | `cuisine` luôn = `'vietnamese'` | Chỉ "Món Việt" có kết quả |
| Mức giá nhà hàng (bình dân/trung cấp/sang) | `priceLevel` luôn = `'mid_range'` | Chỉ "Trung cấp" có kết quả |
| Tiện ích nhà hàng / tiện nghi khách sạn | `amenities` luôn = `[]` | Chọn gì cũng rỗng |
| Khoảng giá + loại lưu trú khách sạn | `priceValue` = 0, `accommodationType` luôn = `'hotel'` | Vô dụng |
| Loại hình activity (8 giá trị, có cafe/museum/photoSpot...) | Backend chỉ trả 4 giá trị | 4 option không bao giờ khớp |
| Sort "Giá rẻ nhất" | Không có data giá | Vô dụng |

Field backend **thực sự có dữ liệu**: `category` của activity (4 giá trị: `attractions`, `culturalHistory`, `entertainment`, `nature` — map từ categories thật trong DB), `rating`, `reviewCount`, `status` giờ mở cửa (`Đang mở cửa`/`Đã đóng cửa`, tính từ `open_time`/`close_time`).

## 2. Bộ lọc mới theo từng section

| Section | Bộ lọc | Ghi chú |
|---|---|---|
| **Hoạt động tham quan** | Loại hình (chọn nhiều: Tham quan & Khám phá / Văn hóa & Di sản / Giải trí & Vui chơi / Thư giãn & Thể thao) · Đánh giá tối thiểu · Chỉ hiện đang mở cửa · Sắp xếp | Loại hình khớp 1-1 với category thật backend trả về |
| **Nhà hàng** | Đánh giá tối thiểu · Chỉ hiện đang mở cửa · Sắp xếp | |
| **Khách sạn** | Đánh giá tối thiểu · Sắp xếp | Khách sạn không có dữ liệu giờ mở cửa hiển thị nên không có switch mở cửa |

Dùng chung:
- **Đánh giá tối thiểu** (`MinRating`): Tất cả / Từ 3.0★ / Từ 3.5★ / Từ 4.0★ / Từ 4.5★.
- **Sắp xếp** (`SortOption`): Mặc định / Đánh giá cao nhất / Nhiều đánh giá nhất — sort ổn định, hòa rating thì xét reviewCount và ngược lại. Bỏ "Giá rẻ nhất" (không có data giá).

## 3. File thay đổi (tất cả trong `GP-Travel-Advisor-Mobile`)

| File | Thay đổi |
|---|---|
| `lib/features/city_detail/domain/entities/filter_enums.dart` | Viết lại: `ActivityCategory` còn 4 giá trị thật; thêm enum `MinRating`; `SortOption` bỏ `cheapest`, đổi `mostPopular` → `mostReviewed`; 3 filter class (`ActivityFilter`/`RestaurantFilter`/`HotelFilter`) chỉ còn field dùng được. Bỏ 6 enum mock (`ActivityPriceType`, `RestaurantCuisine`, `RestaurantPriceLevel`, `RestaurantAmenity`, `AccommodationType`, `HotelAmenity`). |
| `lib/features/city_detail/domain/entities/filter_enums.freezed.dart` | Regenerate bằng `dart run build_runner build --delete-conflicting-outputs`. |
| `lib/features/city_detail/presentation/widgets/filter_bottom_sheet.dart` | Viết lại 3 bottom sheet theo option mới, giữ nguyên ngôn ngữ thiết kế cũ (DraggableScrollableSheet, handle, chip, nút Đặt lại/Áp dụng). Gom khung chung vào `_FilterSheetScaffold`, chip chọn-1 vào `_SingleChoiceChips`, switch mở cửa vào `_OpenNowSwitch`. Bỏ search box loại hình, dropdown quận/huyện mẫu, price range. Sort đổi từ `RadioListTile` (API đã deprecated) sang chip → hết luôn warning deprecation cũ của file này. |
| `lib/features/city_detail/presentation/cubit/city_detail_cubit.dart` | Viết lại logic lọc 3 tab theo filter mới: category (enum.name khớp giá trị backend), `rating >= minRating.value`, `status.contains('Đang mở')`, sort chung qua helper `_sortInPlace` (ổn định, có tie-break). Bỏ `_priceLevelOrder`. |
| `lib/features/city_detail/presentation/screens/city_detail_screen.dart` | Cập nhật 3 getter `_hasActiveFilter` theo field mới (để badge "Bộ lọc" sáng đúng lúc). Không đổi gì khác. |

## 4. Backup UI mock — nơi tìm lại

`GP-Travel-Advisor-Mobile/docs/deprecated/city_detail_filter_mock/`:

- `filter_bottom_sheet.dart.bak` — nguyên bản 3 bottom sheet mock (search loại hình, khoảng giá, quận/huyện, món ăn, mức giá, tiện ích, loại lưu trú, RangeSlider giá khách sạn...).
- `filter_enums.dart.bak` — nguyên bản enum + filter state cũ.
- `README.md` — giải thích và hướng dẫn khôi phục.

Khi backend bổ sung dữ liệu thật (giá phòng, loại lưu trú, tiện ích, món ăn, quận/huyện...), lấy section UI tương ứng từ backup ra ghép lại và thêm field vào filter class là dùng được.

## 5. Đã kiểm tra

- `dart run build_runner build` regenerate freezed: **OK**.
- `flutter analyze lib/features/city_detail`: **No issues found** (trước đó file filter có 8 info deprecation của Radio — giờ hết do đổi sang chip).
- Các enum bị xóa đã xác nhận không được import ở bất kỳ đâu ngoài 4 file city_detail kể trên (`SortOption` của màn see-all home là class riêng trong `paginated_see_all_screen.dart`, không liên quan).
