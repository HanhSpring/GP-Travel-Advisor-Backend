# Chia sẻ lịch trình

## Phạm vi đã chỉnh

- Backend itinerary module:
  - Thêm DTO `ShareItineraryDto` cho request gửi lời mời chia sẻ.
  - Thêm DTO `RespondItineraryShareDto` cho request xác nhận hoặc từ chối lời mời.
  - Thêm DTO `CreateItineraryShareLinkDto` cho request tạo link chia sẻ qua mạng xã hội.
  - Thêm DTO `RespondItineraryShareLinkDto` cho request xác nhận hoặc từ chối từ link.
  - Thêm endpoint `POST /itinerary/:id/share`.
  - Thêm endpoint `POST /itinerary/:id/share/respond`.
  - Thêm endpoint `POST /itinerary/:id/share-link`.
  - Thêm endpoint `GET /itinerary/share-link/:token`.
  - Thêm endpoint `POST /itinerary/share-link/respond`.
  - Bổ sung danh sách lịch trình được chia sẻ vào `GET /itinerary/my-itineraries`.

- Mobile itinerary:
  - Dời nút chia sẻ khỏi màn chi tiết lịch trình.
  - Thêm nút chia sẻ vào màn tóm tắt lịch trình.
  - Bottom sheet chia sẻ cho phép nhập email hoặc số điện thoại và gửi lời mời.
  - Bottom sheet chia sẻ có thêm phần tạo/copy link và mở nhanh Facebook, Zalo, TikTok.
  - Nối flow qua datasource, repository, usecase và cubit của itinerary.

- Mobile notifications:
  - Thêm action xác nhận/từ chối lời mời chia sẻ trong màn chi tiết thông báo.
  - Nối action qua datasource, repository, usecase và cubit của notifications.

- Mobile deep link:
  - App nhận link `gptraveladvisor://itinerary-share?token=...`.
  - Android khai báo intent-filter cho scheme `gptraveladvisor`.
  - iOS khai báo URL scheme `gptraveladvisor`.
  - Khi mở link, app gọi API preview và hiện dialog xác nhận/từ chối.

## Logic backend

### Gửi lời mời chia sẻ

Endpoint:

```http
POST /itinerary/:id/share
```

Body:

```json
{
  "senderUserId": "user-id-nguoi-gui",
  "recipient": "email-hoac-so-dien-thoai"
}
```

Luồng xử lý:

1. Kiểm tra lịch trình tồn tại trong `travel.itineraries`.
2. Kiểm tra người gửi là `creator_id` của lịch trình.
3. Tìm người nhận trong `public.users` bằng email hoặc `phone_number`.
4. Nếu không tìm thấy người nhận, trả lỗi `404` với thông báo người dùng không tồn tại.
5. Nếu người nhận là chính người gửi, trả lỗi `400`.
6. Nếu người nhận đã có trong `travel.itinerary_members`, trả lỗi `409`.
7. Tạo bản ghi trong `public.notifications` với:
   - `type = itinerary_share`
   - `action_type = respond_itinerary_share`
   - `target_type = itinerary_share_invitation`
   - `metadata.share_status = pending`
   - `metadata.itinerary_id`, `sender_user_id`, `recipient_user_id`
8. Tạo bản ghi trong `public.users_notifications` để thông báo xuất hiện cho người nhận.

### Xác nhận hoặc từ chối lời mời

Endpoint:

```http
POST /itinerary/:id/share/respond
```

Body:

```json
{
  "userId": "user-id-nguoi-nhan",
  "notificationId": "notification-id",
  "action": "accept"
}
```

`action` nhận một trong hai giá trị:

- `accept`
- `reject`

Luồng xử lý:

1. Kiểm tra notification đã được gửi đến đúng `userId` trong `public.users_notifications`.
2. Kiểm tra notification là lời mời chia sẻ đúng `itineraryId`.
3. Nếu `action = accept`, insert vào `travel.itinerary_members` với:

```json
{
  "itinerary_id": "itinerary-id",
  "user_id": "user-id-nguoi-nhan"
}
```

4. Cập nhật notification metadata:
   - `share_status = accepted` nếu xác nhận.
   - `share_status = rejected` nếu từ chối.
   - `responded_at = ISO datetime`.
5. Đổi `action_type` của notification sang `itinerary_share_accepted` hoặc `itinerary_share_rejected` để app không hiện lại nút xác nhận/từ chối.
6. Đánh dấu notification là đã đọc.

### Tạo link chia sẻ qua social

Endpoint:

```http
POST /itinerary/:id/share-link
```

Body:

```json
{
  "senderUserId": "user-id-chu-lich-trinh"
}
```

Luồng xử lý:

1. Kiểm tra lịch trình tồn tại.
2. Kiểm tra `senderUserId` là `creator_id` của lịch trình.
3. Tạo `share_token` bằng UUID.
4. Lưu một notification dạng invitation-store trong `public.notifications`, không gắn vào `users_notifications` vì link có thể chia sẻ công khai cho nhiều người.
5. Token và thông tin lời mời được lưu trong `metadata`: `share_token`, `share_status`, `itinerary_id`, `itinerary_title`, `sender_user_id`, `sender_name`.
6. API trả về `deepLink` dạng `gptraveladvisor://itinerary-share?token=<share_token>`.

### Preview và phản hồi từ link

Preview:

```http
GET /itinerary/share-link/:token
```

Phản hồi:

```http
POST /itinerary/share-link/respond
```

Body:

```json
{
  "userId": "user-id-nguoi-bam-link",
  "token": "share-token",
  "action": "accept"
}
```

Luồng xử lý:

1. Backend tìm invitation theo token trong `notifications.metadata.share_token`.
2. Preview trả tên chủ lịch trình, tên lịch trình, itinerary id và trạng thái token.
3. Nếu người bấm link chính là chủ lịch trình thì trả lỗi.
4. Nếu `action = accept`, insert vào `travel.itinerary_members`.
5. Nếu `action = reject`, không ghi member.
6. Token social vẫn giữ `active` để nhiều người có thể tham gia bằng cùng link.

### Load lịch trình được chia sẻ

Endpoint hiện có:

```http
GET /itinerary/my-itineraries?userId=:userId
```

Logic mới:

1. Vẫn gọi RPC `travel.get_my_itineraries` để lấy lịch trình do user tạo.
2. Query thêm `travel.itinerary_members` theo `user_id`.
3. Lấy các itinerary tương ứng từ `travel.itineraries`.
4. Loại trùng với itinerary do user tạo.
5. Merge vào response `itineraries`.
6. Tính lại `stats` theo danh sách đã merge.
7. Vẫn chạy enrich estimated cost như logic cũ.

## Logic mobile

### Màn tóm tắt lịch trình

- Nút share mới nằm trong app bar của `ItinerarySummaryScreen`.
- Khi bấm share:
  1. Mở bottom sheet.
  2. Người dùng nhập email hoặc số điện thoại.
  3. App gọi `ItineraryCubit.shareItinerary`.
  4. Cubit gọi usecase, repository, datasource.
  5. Datasource gọi `POST /itinerary/:id/share`.
  6. Thành công thì hiện snackbar đã gửi lời mời.
  7. Thất bại thì hiện lỗi ngay dưới input.
- Phần link social:
  1. Người dùng bấm Copy/Facebook/Zalo/TikTok.
  2. App gọi `ItineraryCubit.createShareLink`.
  3. Datasource gọi `POST /itinerary/:id/share-link`.
  4. App copy nội dung lời mời vào clipboard.
  5. Với Facebook/Zalo, app mở URL share tương ứng nếu hệ điều hành hỗ trợ.
  6. Với TikTok, do TikTok không có web share URL chuẩn cho text/link, app copy lời mời và thử mở app TikTok bằng scheme `tiktok://`.

### Deep link lời mời

- Link app hiện dùng custom scheme:

```text
gptraveladvisor://itinerary-share?token=<share_token>
```

- Khi app đã cài trên máy:
  1. OS mở app bằng scheme `gptraveladvisor`.
  2. `main.dart` chuyển link vào `NotificationNavigationService.handleItineraryShareLink`.
  3. Service gọi `GET /itinerary/share-link/:token`.
  4. App hiện dialog: `Bạn đã được {tên chủ lịch trình} mời tham gia lịch trình {tên lịch trình}...`
  5. Nếu chấp nhận, app gọi `POST /itinerary/share-link/respond` với `action = accept`.
  6. Sau khi accept, app mở màn tóm tắt lịch trình.

- Nếu app chưa cài:
  - Custom scheme không tự fallback sang CH Play.
  - Khi app được đưa lên CH Play, nên chuyển sang Android App Links/Universal Links dạng HTTPS và cấu hình fallback tới `APP_PLAY_STORE_URL`.
  - Backend đã để sẵn biến môi trường `APP_PLAY_STORE_URL` trong response tạo link, hiện có thể để trống.

### Màn chi tiết lịch trình

- Đã bỏ nút share khỏi floating buttons.
- Đã xóa share sheet mock dùng danh sách user giả.
- Các chức năng khác trong detail giữ nguyên.

### Màn chi tiết thông báo

- Nếu notification có `action_type = respond_itinerary_share` và có `itineraryId`, app hiển thị hai nút:
  - `Từ chối`
  - `Xác nhận`
- Khi bấm:
  1. App gọi `NotificationCubit.respondToItineraryShare`.
  2. Cubit gọi usecase, repository, datasource.
  3. Datasource gọi `POST /itinerary/:id/share/respond`.
  4. Sau khi backend xử lý, cubit reload chi tiết notification.
  5. Snackbar báo kết quả.

## Ghi chú schema

Phần insert member đang dùng cột tối thiểu theo mô tả chức năng:

- `travel.itinerary_members.itinerary_id`
- `travel.itinerary_members.user_id`

Nếu database đang dùng tên cột khác, cần đồng bộ lại trong:

- `ItineraryService.getSharedItineraryListItems`
- `ItineraryService.isItineraryMember`
- `ItineraryService.addItineraryMember`

## Kiểm tra đã chạy

- Đã chạy Prettier cho các file TypeScript itinerary.
- Đã chạy `dart format` cho các file Dart đã chỉnh.
- Sau khi chạy `npm install`, `npm run build` backend đã pass.
- Đã chạy `dart run build_runner build --delete-conflicting-outputs` để tạo generated files còn thiếu.
- `flutter analyze` trên các file liên quan share/deep link không còn error compile; còn warning/info cũ như `avoid_print`, helper chưa dùng, deprecated API.
