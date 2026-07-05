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
  - Bổ sung `creatorId`, `isOwner` và danh sách `members` (họ tên + avatar) vào `GET /itinerary/:id`.
  - `GET /itinerary/share-link/:token` nhận thêm query `userId`, trả `isOwner` và `alreadyMember` để mobile load đúng trạng thái tham gia.
  - Accept qua link social sẽ đồng bộ các notification mời trực tiếp đang chờ của user đó sang `accepted`.
  - Respond từ notification khi user đã là thành viên (đã tham gia qua link) cũng tự đồng bộ sang `accepted`.

- Mobile itinerary:
  - Dời nút chia sẻ khỏi màn chi tiết lịch trình.
  - Thêm nút chia sẻ vào màn tóm tắt lịch trình.
  - Nút chia sẻ chỉ hiển thị với chủ lịch trình và khi status là `pending` hoặc `ongoing`.
  - Màn tóm tắt hiển thị dãy avatar xếp chồng của tất cả thành viên trong header (chủ lịch trình đứng đầu).
  - Member được chia sẻ chỉ có quyền xem: ẩn nút sửa tên, switch công khai, chế độ chỉnh sửa và nút chia sẻ.
  - Bottom sheet chia sẻ: nhập email/số điện thoại/họ tên rồi bấm nút tìm kiếm mới hiển thị kết quả; kết quả chỉ hiện họ tên.
  - Bottom sheet chia sẻ có thêm phần tạo link social với 2 nút `Sao chép` và `Chia sẻ` (có hiệu ứng hover).
  - Nối flow qua datasource, repository, usecase và cubit của itinerary.

- Mobile notifications:
  - Thêm action xác nhận/từ chối lời mời chia sẻ trong màn chi tiết thông báo.
  - Nối action qua datasource, repository, usecase và cubit của notifications.

- Mobile deep link:
  - App nhận link `gptraveladvisor://itinerary-share?token=...`.
  - Android khai báo intent-filter cho scheme `gptraveladvisor`.
  - iOS khai báo URL scheme `gptraveladvisor`.
  - Khi mở link, app gọi API preview và hiện dialog xác nhận/từ chối.
  - Ràng buộc đăng nhập: bấm link khi chưa đăng nhập thì app giữ link lại, nhắc đăng nhập; đăng nhập xong mới hiện dialog lời mời.

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
3. Preview nhận thêm query `userId` (tùy chọn): trả `isOwner = true` nếu người bấm link là chủ lịch trình, `alreadyMember = true` nếu đã có trong `travel.itinerary_members` — mobile dựa vào đây để không hiện lại dialog mời.
4. Nếu người bấm link chính là chủ lịch trình thì respond trả lỗi.
5. Nếu `action = accept`:
   - Insert vào `travel.itinerary_members` (đã là member thì bỏ qua, response trả `alreadyMember = true` kèm message "Bạn đã tham gia lịch trình này trước đó").
   - Đồng bộ trạng thái: các notification mời trực tiếp (`action_type = respond_itinerary_share`) đang chờ của chính user đó cho lịch trình đó được chuyển sang `itinerary_share_accepted` + `share_status = accepted` (kèm `responded_via = share_link`), đánh dấu đã đọc — nhờ đó màn thông báo load đúng trạng thái đã tham gia, không hiện lại nút xác nhận/từ chối.
6. Nếu `action = reject`, không ghi member; lời mời trực tiếp (nếu có) vẫn giữ nguyên để user có thể phản hồi sau.
7. Token social vẫn giữ `active` để nhiều người có thể tham gia bằng cùng link.

Chiều ngược lại (đã tham gia qua link → bấm nút trong thông báo):

1. `POST /itinerary/:id/share/respond` kiểm tra `travel.itinerary_members` trước khi xử lý action.
2. Nếu user đã là thành viên: bỏ qua action, đồng bộ notification sang `accepted` và trả message "Bạn đã tham gia lịch trình này trước đó".
3. Mobile sau khi respond sẽ re-fetch chi tiết notification nên trạng thái hiển thị luôn khớp với backend.

### Thành viên trong chi tiết lịch trình

Endpoint hiện có:

```http
GET /itinerary/:id?tourist_id=:touristId
```

Logic mới:

1. Đọc `creator_id` của lịch trình, trả về `creatorId`.
2. `isOwner = tourist_id === creator_id` (thiếu `tourist_id` thì `isOwner = false`).
3. Query `travel.itinerary_members` theo `itinerary_id`, join `public.users` để lấy `full_name`, `avatar_url`.
4. Trả về `members`: mảng `{ id, fullName, avatarUrl, isOwner }`, chủ lịch trình đứng đầu.
5. Lỗi khi load members không làm hỏng response chi tiết (fallback mảng rỗng).

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

- Nút share nằm trong app bar của `ItinerarySummaryScreen`, chỉ hiển thị khi:
  - Người xem là chủ lịch trình (`isOwner = true`), và
  - Status của lịch trình là `PENDING` hoặc `ONGOING`. Các trạng thái khác (completed, uncompleted...) không hiện nút chia sẻ.
- Header màn tóm tắt hiển thị dãy avatar xếp chồng của tất cả thành viên (tối đa 5 avatar, dư thì hiện `+N`), kèm số lượng thành viên. Avatar lấy từ `members` trong response chi tiết; thiếu ảnh thì hiện chữ cái đầu của họ tên.
- Phân quyền trên màn tóm tắt và màn chi tiết:
  - Chủ lịch trình: đầy đủ chức năng như cũ.
  - Member được chia sẻ: chỉ xem. Ẩn nút sửa tên lịch trình, switch công khai/riêng tư, nút chia sẻ và nút vào chế độ chỉnh sửa ở màn chi tiết.
- Khi bấm share:
  1. Mở bottom sheet.
  2. Người dùng nhập email, số điện thoại hoặc họ tên rồi bấm nút tìm kiếm (không tự tìm khi đang gõ).
  3. App gọi `GET /itinerary/share/recipients` và hiển thị kết quả; mỗi kết quả chỉ hiện họ tên (không lộ email/số điện thoại).
  4. Người dùng chọn một người trong danh sách rồi bấm `Chia sẻ`.
  5. App gọi `ItineraryCubit.shareItinerary` → usecase → repository → datasource → `POST /itinerary/:id/share`.
  6. Thành công thì hiện snackbar đã gửi lời mời.
  7. Thất bại thì hiện lỗi ngay dưới input.
- Phần link social:
  1. Người dùng bấm `Sao chép` hoặc `Chia sẻ` (2 nút có hiệu ứng hover khi rê chuột).
  2. App gọi `ItineraryCubit.createShareLink`.
  3. Datasource gọi `POST /itinerary/:id/share-link`.
  4. Nút `Sao chép` copy nội dung lời mời vào clipboard; nút `Chia sẻ` mở share sheet của hệ điều hành.

### Deep link lời mời

- Link app hiện dùng custom scheme:

```text
gptraveladvisor://itinerary-share?token=<share_token>
```

- Khi app đã cài trên máy:
  1. OS mở app bằng scheme `gptraveladvisor`.
  2. `main.dart` chuyển link vào `NotificationNavigationService.handleItineraryShareLink`.
  3. Service kiểm tra đăng nhập bằng `AuthUtils.getCurrentUserId()` trước khi xử lý.
  4. Nếu **chưa đăng nhập** (kể cả đang đứng ở màn đăng nhập):
     - Link được lưu vào `_pendingItineraryShareUri` trong `NotificationNavigationService`.
     - App hiện snackbar: `Vui lòng đăng nhập để mở lời mời tham gia lịch trình. Lời mời sẽ hiển thị ngay sau khi bạn đăng nhập.`
     - Khi đăng nhập thành công, `MainShell` mount và gọi `NotificationNavigationService.processPendingItineraryShareLink()` — link đang chờ được xử lý tiếp và dialog lời mời hiện ra (mọi luồng đăng nhập/khôi phục session đều đi qua `MainShell` nên không sót trường hợp nào).
  5. Nếu **đã đăng nhập**, service gọi `GET /itinerary/share-link/:token?userId=<user hiện tại>`.
  6. Kiểm tra trạng thái tham gia từ preview trước khi hiện dialog:
     - `isOwner = true` → hiện snackbar "Bạn là chủ lịch trình này nên không cần tham gia bằng link mời." và mở thẳng màn tóm tắt.
     - `alreadyMember = true` (đã tham gia trước đó, dù bằng deep link hay lời mời trực tiếp) → hiện snackbar "Bạn đã tham gia lịch trình này rồi." và mở thẳng màn tóm tắt, không hiện lại dialog mời.
  7. Chưa tham gia thì app hiện dialog: `Bạn đã được {tên chủ lịch trình} mời tham gia lịch trình {tên lịch trình}...`
  8. Nếu chấp nhận, app gọi `POST /itinerary/share-link/respond` với `action = accept`; snackbar dùng message backend trả về (phân biệt "đã xác nhận tham gia" và "đã tham gia trước đó").
  9. Sau khi accept, app mở màn tóm tắt lịch trình.

- File đã chỉnh cho ràng buộc đăng nhập:
  - `lib/core/services/notification_navigation_service.dart`: thêm `_pendingItineraryShareUri`, kiểm tra đăng nhập ở đầu `handleItineraryShareLink`, thêm hàm `processPendingItineraryShareLink()`.
  - `lib/core/navigation/main_shell.dart`: gọi `processPendingItineraryShareLink()` trong `initState` (post-frame) để hiện lời mời ngay sau khi đăng nhập xong.

- Nếu app chưa cài:
  - Custom scheme không tự fallback sang CH Play.
  - Khi app được đưa lên CH Play, nên chuyển sang Android App Links/Universal Links dạng HTTPS và cấu hình fallback tới `APP_PLAY_STORE_URL`.
  - Backend đã để sẵn biến môi trường `APP_PLAY_STORE_URL` trong response tạo link, hiện có thể để trống.

### Màn chi tiết lịch trình

- Đã bỏ hẳn nút share khỏi floating buttons (chia sẻ chỉ còn ở màn tóm tắt).
- Đã xóa share sheet mock dùng danh sách user giả cùng callback `onShareTap`.
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
