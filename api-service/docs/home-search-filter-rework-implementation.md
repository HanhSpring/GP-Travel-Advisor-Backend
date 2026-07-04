# Home/Search Filter Rework Implementation

## Phạm vi đã làm

- Đưa bộ lọc kiểu city-detail sang màn "Xem tất cả" của Home qua `PaginatedSeeAllScreen`.
- Tùy chỉnh filter theo từng section:
  - Lịch trình gợi ý: tỉnh/thành, loại hình du lịch, sắp xếp.
  - Điểm đến nổi bật: đánh giá tối thiểu, sắp xếp.
  - Nhà hàng tiêu biểu: đánh giá tối thiểu, chỉ hiện đang mở cửa, sắp xếp.
  - Khách sạn nổi bật: đánh giá tối thiểu, chỉ hiện đang mở cửa, giá mỗi đêm, sắp xếp.
- Thêm filter cho màn "Xem tất cả" của Search:
  - Loại hình.
  - Tỉnh/thành.
  - Đánh giá tối thiểu.
  - Chỉ hiện đang mở cửa.
  - Giá khách sạn.
  - Sắp xếp theo mặc định, đánh giá cao nhất, nhiều đánh giá nhất.

## Giờ mở cửa

- Backend `ExploreService` đã select `open_hour_compressed` và tính `status` ưu tiên theo lịch trong cột này.
- Backend `SearchService` cũng đã select `open_time`, `close_time`, `open_hour_compressed`, `price` và tính `status` thật thay vì hard-code "Đang mở cửa".
- Logic giờ mở cửa:
  - Ưu tiên `open_hour_compressed` theo ngày hiện tại, timezone Việt Nam (UTC+7).
  - Hỗ trợ nhiều khung giờ trong một ngày.
  - Hỗ trợ khung giờ qua đêm.
  - Fallback sang `open_time`/`close_time` nếu `open_hour_compressed` thiếu hoặc không parse được.
  - Nếu thiếu toàn bộ dữ liệu giờ thì trả "Chưa có giờ mở cửa"; mobile ẩn giá trị này khỏi UI và chỉ dùng để filter.

## Giá khách sạn

- `CityHotel` và `CityHotelModel` đã có thêm `status`.
- Home map khách sạn đã nhận `status` từ backend.
- Search datasource đã normalize `status`, `priceValue`, `reviewCount`, `imageUrl` từ response backend.
- Filter giá khách sạn hiện dùng các khoảng:
  - Dưới 500K.
  - 500K - 1 triệu.
  - 1 - 2 triệu.
  - Trên 2 triệu.
- Nếu item chưa có giá (`priceValue <= 0`) thì bị loại khi người dùng chọn một khoảng giá cụ thể.

## UI

- Không hiển thị giờ đóng/mở cửa mới trong UI filter hay card.
- Bottom sheet filter của Home và Search dùng chip/dropdown/switch, có trạng thái "Đặt lại", và có thể scroll để tránh tràn màn hình nhỏ.
- Icon filter có chấm báo khi đang có filter/sort active.

## File chính đã chỉnh

- Backend:
  - `api-service/src/modules/tourist/explore/explore.service.ts`
  - `api-service/src/modules/search/search.service.ts`
- Mobile:
  - `lib/features/home/presentation/screens/paginated_see_all_screen.dart`
  - `lib/features/home/presentation/screens/explore_screen.dart`
  - `lib/features/home/data/datasources/home_datasource.dart`
  - `lib/features/search/presentation/screens/search_all_screen.dart`
  - `lib/features/search/presentation/cubit/search_all_cubit.dart`
  - `lib/features/search/data/datasources/search_remote_datasource.dart`
  - `lib/features/city_detail/domain/entities/city_entities.dart`
  - `lib/features/city_detail/domain/entities/city_entities.freezed.dart`
  - `lib/features/city_detail/data/models/city_models.dart`
  - `lib/features/city_detail/data/models/city_models.freezed.dart`
  - `lib/features/city_detail/data/models/city_models.g.dart`

## Kiểm tra

- Backend: đã chạy `npx.cmd tsc --noEmit -p tsconfig.json` trong `api-service`, kết quả pass.
- Mobile: đã thử `flutter analyze` và `dart format`, nhưng Dart process bị treo/timeout nhiều lần trong môi trường hiện tại. Đã dừng các process treo để không giữ lock. Cần chạy lại `flutter analyze` trên máy dev khi Dart toolchain ổn định.

## Bổ sung sửa lỗi Search filter

- Sửa lỗi bấm "Áp dụng" ở màn "Xem tất cả" của Search nhưng danh sách chưa lọc ngay.
- Nguyên nhân: các filter nâng cao của Search (`rating`, `đang mở cửa`, `giá`, `sort`) được lưu trong `SearchAllCubit`, không nằm trong `SearchAllState`; khi chỉ đổi các filter này, Freezed state có thể vẫn bằng state cũ nên Bloc không rebuild.
- Cách sửa: gom thao tác apply vào `SearchAllCubit.applyFilters(...)`; nếu chỉ filter nâng cao thay đổi thì cubit phát một state trung gian rất ngắn rồi phát state kết quả để list rebuild ngay, không cần refresh trang.
