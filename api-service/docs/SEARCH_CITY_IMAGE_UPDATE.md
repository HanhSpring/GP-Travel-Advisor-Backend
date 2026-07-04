# Search City Image Update

Ngày cập nhật: 2026-07-03

## Mục tiêu

Khi người dùng search tỉnh/thành phố trong app mobile, kết quả search phải hiển thị ảnh đại diện của tỉnh/thành phố đó từ bảng `travel.cities`, ưu tiên cột `image_url` và hỗ trợ fallback `url_image`.

## Backend đã chỉnh

File:

- `src/modules/search/search.service.ts`
- `src/modules/search/dto/search-response.dto.ts`

Logic chính:

- Giữ nguyên endpoint hiện tại `GET /search/autocomplete`, không đổi contract response đang dùng ở mobile.
- Với kết quả autocomplete type `city`, backend đọc ảnh từ các key có thể có trong response: `image`, `image_url`, `url_image`.
- Nếu RPC `travel.search_autocomplete` trả city nhưng chưa có ảnh, backend tự enrich lại bằng cách query bảng `travel.cities` theo `id` và `name`.
- Khi query `travel.cities`, backend ưu tiên select `image_url`. Nếu database/schema ở môi trường khác dùng `url_image`, service có fallback query sang `url_image`.
- Nếu RPC autocomplete lỗi hoặc timeout, fallback search hiện tại vẫn chạy và được bổ sung thêm kết quả city từ `travel.cities` để tỉnh/thành phố vẫn có ảnh.
- Swagger description của field `image` được cập nhật thành ảnh đại diện của địa điểm hoặc tỉnh/thành phố.

Response city sau chỉnh sửa vẫn theo dạng cũ:

```json
{
  "id": "city-id",
  "name": "Đà Nẵng",
  "type": "city",
  "image": "https://...",
  "city": "Đà Nẵng",
  "rating": 0,
  "score": 0
}
```

## Mobile đã chỉnh

File:

- `lib/features/search/data/models/search_location_model.dart`
- `lib/features/search/presentation/widgets/search_result_widget.dart`

Logic chính:

- `SearchLocationModel.fromJson` giờ nhận ảnh từ `image`, `image_url`, hoặc `url_image`.
- Entity `SearchLocation.imageUrl` không đổi, nên UI search hiện tại tiếp tục dùng thumbnail cũ.
- `SearchResultWidget` đã có `_Thumbnail` dùng `CachedNetworkImage`; khi city có ảnh thì tự hiển thị ảnh, nếu không có ảnh vẫn fallback về icon.
- Nhãn kết quả city đổi từ `Thành phố` thành `Tỉnh/Thành phố`.

## Phạm vi không chỉnh

- Không đổi navigation khi nhấn vào city/place/itinerary.
- Không đổi màn Search All, filter, nearby, home, city detail.
- Không đổi schema database.
- Không đổi API path hoặc DTO field name mà mobile đang phụ thuộc.

## Kiểm tra đã chạy

Backend:

```bash
npm run build
```

Kết quả: pass.

Mobile:

```bash
flutter analyze lib/features/search/data/models/search_location_model.dart lib/features/search/presentation/widgets/search_result_widget.dart
```

Kết quả: pass, no issues found.
