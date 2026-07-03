# Itinerary Tracking Restore Fix

Ngày cập nhật: 2026-07-03

## Vấn đề

Có case người dùng đã bấm bắt đầu lịch trình và đang theo dõi lịch trình. Sau khi dừng build/thoát app rồi mở lại, trang quản lý lịch trình không còn hiển thị lịch trình đó là đang diễn ra. Tuy nhiên khi bắt đầu lịch trình khác, app vẫn báo đang có một lịch trình đang bắt đầu và không cho bắt đầu lịch trình mới.

Nguyên nhân là trạng thái tracking bị lệch giữa backend và UI mobile:

- Backend vẫn giữ lịch trình đang chạy bằng `status = ongoing` và `tracking_active = true`.
- Mobile `TrackingCubit` có thể restore lại tracking active từ backend.
- Nhưng danh sách lịch trình trong `ItineraryCubit` không được đồng bộ lại sau restore, nên card có thể nhìn như chưa bắt đầu.
- Một số response itinerary list/detail chưa đảm bảo trả `tracking_active`, làm mobile thiếu dữ liệu để render đúng sau khi reload.

## Backend đã chỉnh

File:

- `src/modules/itinerary/itinerary.service.ts`

Thay đổi:

- Sau khi lấy danh sách lịch trình từ RPC/list, backend enrich lại `status` và `tracking_active` trực tiếp từ bảng `travel.itineraries`.
- Danh sách lịch trình được chia sẻ cũng select và trả thêm `tracking_active`.
- API chi tiết lịch trình trả thêm cả hai key:
  - `trackingActive`
  - `tracking_active`

Mục tiêu là đảm bảo mobile luôn biết lịch trình nào đang bật tracking, kể cả sau khi app restart hoặc list RPC chưa trả đủ field.

## Mobile đã chỉnh

File:

- `lib/core/navigation/main_shell.dart`
- `lib/features/itinerary/presentation/cubit/itinerary_cubit.dart`
- `lib/features/itinerary/presentation/screens/itinerary_screen.dart`

Thay đổi:

- `MainShell` lắng nghe `TrackingCubit`. Khi tracking được restore thành active và có `itineraryId`, app đồng bộ lại trạng thái sang `ItineraryCubit`.
- `ItineraryCubit.toggleItineraryStatus` giờ cập nhật cả:
  - item trong danh sách lịch trình
  - `selectedItinerary` đang mở
- Card lịch trình ưu tiên `trackingActive == true` để vẫn hiện nút trạng thái đang diễn ra/dừng tracking, kể cả khi status list chưa kịp đồng bộ.

## Luồng sau khi fix

1. Người dùng bấm bắt đầu lịch trình.
2. Backend lưu `status = ongoing`, `tracking_active = true`.
3. Nếu app bị dừng build/thoát app, khi mở lại `TrackingCubit.restoreIfActive()` gọi backend để restore tracking active.
4. Khi restore thành công, `MainShell` sync itinerary đang active vào `ItineraryCubit`.
5. Trang quản lý lịch trình hiển thị đúng lịch trình đang diễn ra.
6. Nếu người dùng bắt đầu lịch trình khác, app vẫn chặn đúng vì đang có tracking active.

## Phạm vi không chỉnh

- Không đổi logic geofence/check-in/dwell.
- Không đổi endpoint start/stop tracking.
- Không đổi UI layout của card ngoài điều kiện hiển thị trạng thái đang diễn ra.
- Không đổi database schema.

## Kiểm tra đã chạy

Backend:

```bash
npm run build
```

Kết quả: pass.

Mobile:

```bash
flutter analyze lib/core/navigation/main_shell.dart lib/features/itinerary/presentation/cubit/itinerary_cubit.dart lib/features/itinerary/presentation/screens/itinerary_screen.dart
```

Kết quả: không còn error. Analyzer còn một số warning/info cũ trong các file liên quan, không phát sinh lỗi compile cho fix này.
