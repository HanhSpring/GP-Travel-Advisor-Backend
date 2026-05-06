# Activity Log — Tài liệu triển khai

Hệ thống ghi lại hành động thực của tourist vào bảng `activity_logs` (schema `travel`, Supabase), phục vụ recommendation engine và analytics.

Bảng `activity_logs`:

| Cột | Kiểu | Mô tả |
|---|---|---|
| `id` | uuid | Primary key |
| `tourist_id` | uuid | ID tourist thực hiện hành động |
| `action_type` | varchar | Loại hành động |
| `place_id` | uuid | Địa điểm liên quan (nullable) |
| `created_at` | timestamp | Thời điểm xảy ra |

---

## Các action_type được hỗ trợ

| action_type | Ý nghĩa | Nguồn log |
|---|---|---|
| `click` | Tap vào card POI | Frontend |
| `view` | Ở lại trang chi tiết ≥ 2s | Frontend |
| `save` | Lưu POI vào yêu thích | Frontend |
| `unsave` | Bỏ POI khỏi yêu thích | Frontend |
| `search` | Tìm kiếm và có kết quả trả về | Frontend |
| `visited` | Check-in tại địa điểm thực tế | Frontend |
| `review` | Gửi đánh giá có nội dung | Frontend |
| `rating` | Chấm điểm sao | Frontend |

---

## Kiến trúc

```
Flutter App → POST /activity/track
Dùng cho: click, view, save, unsave, search, visited, review, rating

Flutter ActivityService  →  POST /activity/track  →  ActivityController
(fire-and-forget)                                      ActivityService
                                                       Supabase travel.activity_logs
```

---

## Cài đặt

### Backend
```bash
cd api-service
npm install @nestjs/event-emitter eventemitter2
```

### Frontend
Thêm vào `pubspec.yaml`:
```yaml
visibility_detector: ^0.4.0+2
```
Rồi chạy:
```bash
flutter pub get
```

---

## Cấu trúc file

### Backend

```
api-service/src/
├── app.module.ts                              ← đăng ký ActivityModule + EventEmitterModule
└── modules/
    └── activity/
        ├── dto/
        │   └── track-activity.dto.ts          ← whitelist action_type + validate UUID
        ├── activity.service.ts                ← insert vào Supabase (không throw)
        ├── activity.listener.ts               ← nhận event 'activity.log' async
        ├── activity.controller.ts             ← POST /activity/track → 204
        └── activity.module.ts                 ← đăng ký module
```

### Frontend

```
lib/
├── core/
│   ├── services/
│   │   └── activity_service.dart              ← gọi POST /activity/track, fire-and-forget
│   └── widgets/
│       └── visible_place_tracker.dart         ← VisibilityDetector: 50% pixel + 2s timer
└── features/
    ├── home/presentation/
    │   ├── screens/explore_screen.dart        ← click (nhà hàng PageView, khách sạn PageView, See All)
    │   └── widgets/destination_card.dart      ← click (card địa điểm trang chủ)
    ├── place/presentation/
    │   ├── screens/place_detail_screen.dart   ← view (dwell 2s), save, unsave, visited
    │   └── widgets/related_places_section.dart ← click (địa điểm liên quan)
    ├── search/presentation/
    │   ├── cubit/search_cubit.dart            ← search (sau khi có kết quả)
    │   └── widgets/search_result_widget.dart  ← click (chỉ khi location.type == 'place')
    └── review/presentation/
        └── screens/place_review_screen.dart   ← review, rating (khi submit)
```

---

## Chi tiết từng action

### `click` — Tap vào card POI

Gọi ngay trong `onTap` trước khi push route:

```dart
onTap: () {
  sl<ActivityService>().trackClick(item.id);
  Navigator.push(context, MaterialPageRoute(
    builder: (_) => BlocProvider(
      create: (_) => sl<PlaceDetailCubit>(),
      child: PlaceDetailScreen(placeId: item.id),
    ),
  ));
},
```

Các điểm gọi:

| File | Widget |
|---|---|
| `destination_card.dart` | Card địa điểm trang chủ |
| `explore_screen.dart` | PageView nhà hàng + PageView khách sạn + See All cả hai |
| `related_places_section.dart` | Card địa điểm liên quan trong PlaceDetailScreen |
| `search_result_widget.dart` | Kết quả tìm kiếm (chỉ khi `location.type == 'place'`) |

---

### `view` — Ở lại PlaceDetailScreen ≥ 2s

Dwell timer khởi động khi `BlocConsumer` nhận state `PlaceDetailLoaded`:

```dart
// place_detail_screen.dart
Timer? _dwellTimer;
bool _viewTracked = false;

void _startDwellTimer() {
  if (_viewTracked) return;
  _dwellTimer?.cancel();
  _dwellTimer = Timer(const Duration(seconds: 2), () {
    if (!mounted) return;
    _activityService.trackView(widget.placeId);
    _viewTracked = true;
  });
}

// BlocConsumer listener:
listener: (context, state) {
  if (state is PlaceDetailLoaded) {
    _startDwellTimer();
  }
},
```

Timer bị hủy trong `dispose()` — nếu user rời trước 2s thì không log.

**Card trong danh sách cuộn** dùng `VisiblePlaceTracker`:

```dart
VisiblePlaceTracker(
  placeId: item.id,
  child: GestureDetector(
    onTap: () { ... },
    child: RestaurantCard(item: item),
  ),
)
```

`VisiblePlaceTracker` dùng `VisibilityDetector`:
- `visibleFraction >= 0.5` → bắt đầu timer 2s
- `visibleFraction < 0.5` (user scroll qua) → hủy timer
- Timer fire → `trackView(placeId)`, đặt flag `_tracked = true` (chỉ log 1 lần)

---

### `save` / `unsave` — Nút yêu thích

```dart
// place_detail_screen.dart — trong PlaceHeader.onFavorite
onFavorite: () {
  final wasFavorite = place.isFavorite;
  context.read<PlaceDetailCubit>().toggleFavorite();
  if (!wasFavorite) {
    _activityService.trackSave(widget.placeId);
  } else {
    _activityService.trackUnsave(widget.placeId);
  }
},
```

`wasFavorite` đọc trước khi toggle để xác định đúng hướng action.

---

### `search` — Tìm kiếm

```dart
// search_cubit.dart — trong onSearchQueryChanged, sau khi emit kết quả
_debounce = Timer(const Duration(milliseconds: 300), () async {
  final results = await _searchLocations(query);
  emit(SearchState.searchResults(results));
  _activityService.trackSearch(); // log sau khi có kết quả
});
```

Không log khi: query rỗng, search lỗi, hoặc load recent searches.

---

### `visited` — Check-in thực tế

Nút "Tôi đã đến đây" trong `PlaceDetailScreen`. Khi user xác nhận trong `AlertDialog`:

```dart
ElevatedButton(
  onPressed: () {
    Navigator.pop(context);
    _activityService.trackVisited(widget.placeId);
  },
  child: const Text('Xác nhận'),
)
```

---

### `review` + `rating` — Đánh giá

```dart
// place_review_screen.dart — trong _submit()
void _submit() {
  widget.reviewCubit.updateLocationReviewDetails(...);

  final activityService = sl<ActivityService>();
  if (_rating > 0) {
    activityService.trackRating(widget.locationId);
  }
  if (_reviewController.text.trim().isNotEmpty) {
    activityService.trackReview(widget.locationId);
  }

  Navigator.pop(context);
}
```

User có thể log cả hai (chấm sao + viết nội dung), hoặc chỉ một trong hai.

---

## ActivityService — Cơ chế fire-and-forget + debug logging

```dart
// lib/core/services/activity_service.dart
Future<void> _track({
  required String actionType,
  String? placeId,
}) async {
  try {
    final touristId = await AuthUtils.getCurrentUserId();
    if (touristId == null || touristId.isEmpty) {
      debugPrint('[ActivityLog] ✗ $actionType — bỏ qua: chưa đăng nhập');
      return;
    }

    debugPrint(
      '[ActivityLog] → $actionType'
      '${placeId != null ? ' | place=$placeId' : ''}'
      ' | tourist=$touristId',
    );

    final response = await _dioClient.dio.post(
      '/activity/track',
      data: {
        'tourist_id': touristId,
        'action_type': actionType,
        if (placeId != null) 'place_id': placeId,
      },
    );

    debugPrint('[ActivityLog] ✓ $actionType ghi thành công (${response.statusCode})');
  } catch (e) {
    debugPrint('[ActivityLog] ✗ $actionType thất bại: $e');
  }
}
```

`debugPrint` chỉ in trong debug mode, tự tắt khi build release.

---

## Cách debug trên terminal

```bash
flutter run 2>&1 | grep "\[ActivityLog\]"
```

| Log hiện ra | Ý nghĩa |
|---|---|
| `✗ ... — bỏ qua: chưa đăng nhập` | Chưa login hoặc token hết hạn |
| `→ click \| place=... \| tourist=...` | Request đang được gửi |
| `✓ click ghi thành công (204)` | Ghi Supabase thành công |
| `✗ click thất bại: DioException...` | Request thất bại, xem lý do trong error |

> **Lưu ý:** Phải đăng nhập vào app trước khi test — `getCurrentUserId()` đọc `access_token` từ `FlutterSecureStorage`. Nếu chưa login, mọi action đều bị bỏ qua silently.

---

## Lưu ý kỹ thuật

- `activity.listener.ts` dùng `import type { ActivityLogPayload }` (không phải `import`) do yêu cầu của `isolatedModules` + `emitDecoratorMetadata` trong tsconfig.
- `DioClient` đã có `LogInterceptor` bật sẵn — mọi HTTP request/response đều được in ra terminal kể cả không có `debugPrint` trong `ActivityService`.
- `VisiblePlaceTracker` dùng `Key('vpt_${placeId}')` — mỗi POI có key riêng, đảm bảo `VisibilityDetector` hoạt động đúng khi ListView rebuild.
- Backend cho phép mọi origin `localhost:*` qua CORS — không cần cấu hình thêm khi chạy Flutter web dev.
