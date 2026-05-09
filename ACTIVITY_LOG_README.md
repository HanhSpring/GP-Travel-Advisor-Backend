# Activity Log — Tài liệu triển khai

Hệ thống ghi lại hành động thực của tourist vào bảng `activity_logs` (schema `travel`, Supabase), phục vụ recommendation engine và analytics.

Bảng `activity_logs`:

| Cột | Kiểu | Mô tả |
|---|---|---|
| `id` | uuid | Primary key |
| `tourist_id` | uuid | ID tourist thực hiện hành động |
| `action_type` | varchar | Loại hành động |
| `place_id` | uuid | Địa điểm liên quan (nullable) |
| `created_at` | timestamptz | Thời điểm xảy ra — **giờ Việt Nam UTC+7** (ví dụ: `2026-05-08T11:09:53.000+07:00`) |

---

## Các action_type được hỗ trợ

| action_type | Ý nghĩa | Nguồn log |
|---|---|---|
| `click` | Tap vào card POI | Frontend |
| `view` | Ở lại trang chi tiết ≥ 2s | Frontend |
| `save` | Lưu POI vào yêu thích | Frontend |
| `unsave` | Bỏ POI khỏi yêu thích | Frontend |
| `search` | Tìm kiếm và click vào kết quả đầu tiên (place) | Frontend |
| `visited` | Check-in tại địa điểm thực tế | Frontend |
| `review` | Gửi đánh giá có nội dung | Frontend + Backend event |
| `rating` | Chấm điểm sao | Frontend (2 điểm gọi) |

---

## Kiến trúc

```
Flutter App → POST /activity/track
Dùng cho: click, view, save, unsave, search, visited, review, rating

Flutter ActivityService  →  POST /activity/track  →  ActivityController
(fire-and-forget)                                      ActivityService
                                                       Supabase travel.activity_logs

Backend ReviewsService   →  EventEmitter 'activity.log'  →  ActivityListener
(khi submit review API)                                       ActivityService
                                                              Supabase travel.activity_logs
```

> `review` có thể được log từ 2 nguồn: Frontend (khi user nhấn "Gửi" trong `PlaceReviewScreen`)
> và Backend (khi review được commit xuống DB qua `/itinerary-reviews/:id/submit`).

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
    ├── activity/
    │   ├── dto/
    │   │   └── track-activity.dto.ts          ← whitelist action_type + validate UUID
    │   ├── activity.service.ts                ← insert vào Supabase (không throw)
    │   ├── activity.listener.ts               ← nhận event 'activity.log' async
    │   ├── activity.controller.ts             ← POST /activity/track → 204
    │   └── activity.module.ts                 ← đăng ký module
    └── tourist/
        └── reviews/
            └── reviews.service.ts             ← emit event 'activity.log' (action_type: 'review')
                                                  sau khi insert review thành công
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
    │   ├── cubit/search_cubit.dart            ← search (khi user click kết quả đầu tiên, kèm place_id)
    │   ├── widgets/search_result_widget.dart  ← click (chỉ khi location.type == 'place')
    │   └── widgets/search_suggestion_widget.dart ← click (tìm kiếm gần đây, chỉ khi location.type == 'place')
    └── review/presentation/
        └── screens/
            ├── place_review_screen.dart       ← review + rating (khi user nhấn "Gửi" trong màn hình chi tiết đánh giá)
            └── rate_itinerary_screen.dart     ← rating (khi user chấm sao trực tiếp trên danh sách địa điểm)
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
| `search_result_widget.dart` | Kết quả tìm kiếm mới (chỉ khi `location.type == 'place'`) |
| `search_suggestion_widget.dart` | Tìm kiếm gần đây (chỉ khi `location.type == 'place'`) |

---

### `view` — Ở lại PlaceDetailScreen ≥ 2s

Dwell timer khởi động khi `BlocConsumer` nhận state `PlaceDetailLoaded`:

```dart
// place_detail_screen.dart
Timer? _dwellTimer;
bool _viewTracked = false;

void _startDwellTimer() {
  if (_viewTracked) return;   // guard: chỉ log 1 lần duy nhất
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
    _startDwellTimer();   // gọi mỗi lần state load/reload, nhưng guard _viewTracked ngăn log lại
  }
},
```

Timer bị hủy trong `dispose()` — nếu user rời trước 2s thì không log.

> **Lưu ý:** `_startDwellTimer()` không reset timer khi state reload — `_viewTracked = true` sau lần đầu
> fire sẽ khiến mọi lần gọi tiếp theo bị skip ngay lập tức (`if (_viewTracked) return`).
> Đây là hành vi đúng: mỗi phiên vào trang chỉ log `view` 1 lần.

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
- `visibleFraction >= 0.5` → khởi động timer 2s (dùng `??=` — không restart nếu timer đang chạy)
- `visibleFraction < 0.5` (user scroll qua) → hủy timer và set `_timer = null`
- Timer fire → `trackView(placeId)`, đặt flag `_tracked = true` (chỉ log 1 lần, mọi lần gọi sau bị skip)

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

Log `search` kèm `place_id` khi user click vào kết quả đầu tiên (chỉ khi `location.type == 'place'`).
Flag `_searchTracked` trong `SearchCubit` đảm bảo chỉ log 1 lần mỗi phiên search (reset khi query thay đổi).

```dart
// search_cubit.dart — trong onLocationSelected
Future<void> onLocationSelected(SearchLocation location) async {
  // Log search với place_id — chỉ lần click đầu tiên mỗi phiên search
  if (!_searchTracked && location.type == 'place') {
    _searchTracked = true;
    _activityService.trackSearch(placeId: location.id);
  }
  await _saveRecentSearch(location);
}
```

`onLocationSelected` được gọi từ `search_result_widget.dart` và `search_suggestion_widget.dart` trong `onTap`.

Không log khi: query rỗng, search throw exception, user click vào city (không phải place), hoặc đã click place trước đó trong cùng phiên search.

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

Có **2 điểm trigger** cho `rating`, và **1 điểm trigger** cho `review`:

#### Điểm 1 — Màn hình chi tiết đánh giá (`place_review_screen.dart`)

User mở màn hình đánh giá từng địa điểm (nhấn "Viết đánh giá" trên `LocationReviewListTile`), điền nội dung, nhấn "Gửi":

```dart
// place_review_screen.dart — trong _submit()
void _submit() {
  // Lấy placeId thực sự của POI trước khi cập nhật state
  // (loc.id là itinerary_detail_id — KHÔNG PHẢI place_id của POI)
  String? placeId;
  final cubitState = widget.reviewCubit.state;
  if (cubitState is ReviewLoaded) {
    final idx = cubitState.itinerary.locations
        .indexWhere((l) => l.id == widget.locationId);
    if (idx != -1) placeId = cubitState.itinerary.locations[idx].placeId;
  }

  widget.reviewCubit.updateLocationReviewDetails(
    locationId: widget.locationId,
    rating: _rating,
    reviewText: _reviewController.text,
    reviewTags: _selectedTags,
    mediaPaths: _mediaPaths,
  );

  if (placeId != null && placeId.isNotEmpty) {
    final activityService = sl<ActivityService>();
    if (_rating > 0) {
      activityService.trackRating(placeId);   // log rating
    }
    if (_reviewController.text.trim().isNotEmpty) {
      activityService.trackReview(placeId);   // log review
    }
  }

  Navigator.pop(context);
}
```

> **Lưu ý `placeId`:** `LocationReviewEntity.id` là `itinerary_detail_id` (khóa chính của bảng
> `itinerary_details`), không phải `place_id` của POI. Field `placeId` được thêm riêng vào entity
> và được lấy từ `item['place_id']` trong response của `/itinerary-reviews/:id/detail`.
> Guard `if (placeId != null && placeId.isNotEmpty)` đảm bảo không ghi log với UUID sai
> (ví dụ chế độ demo khi `placeId` là null).

#### Điểm 2 — Chấm sao inline trên danh sách địa điểm (`rate_itinerary_screen.dart`)

User chấm sao trực tiếp trên `LocationReviewListTile` mà không mở màn hình chi tiết:

```dart
// rate_itinerary_screen.dart — trong onRatingChanged của LocationReviewListTile
onRatingChanged: isReadOnly ? (_) {} : (rating) {
  context.read<ReviewCubit>().setLocationRating(loc.id, rating);
  if (loc.placeId != null && loc.placeId!.isNotEmpty) {
    sl<ActivityService>().trackRating(loc.placeId!);
  }
},
```

#### Backend event (khi submit toàn bộ lịch trình)

Khi user nhấn "Gửi đánh giá" ở cuối `RateItineraryScreen`, `reviewCubit.submitReview()` gọi
`/itinerary-reviews/:id/submit`. Backend `reviews.service.ts` tự động emit event để ghi thêm
một lần `review` vào activity_logs:

```typescript
// api-service/src/modules/tourist/reviews/reviews.service.ts
this.eventEmitter.emit(ACTIVITY_LOG_EVENT, {
  tourist_id: payload.tourist_id,
  action_type: 'review',   // khớp với FRONTEND_ACTIONS
  place_id: payload.place_id,
});
```

Bảng tổng hợp:

| Trigger | action_type ghi | Điều kiện |
|---|---|---|
| `place_review_screen._submit()` | `rating` | `_rating > 0` |
| `place_review_screen._submit()` | `review` | review text không rỗng |
| `rate_itinerary_screen.onRatingChanged` | `rating` | `loc.placeId` hợp lệ |
| Backend `reviews.service.createReview()` | `review` | Sau khi insert review thành công |

---

## ActivityService — Cơ chế fire-and-forget + debug logging

```dart
// lib/core/services/activity_service.dart
Future<void> _track({
  required String actionType,
  String? placeId,
  Map<String, dynamic>? metadata,   // khai báo nhưng hiện không gửi lên server
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
        // metadata không được gửi — body chỉ có 3 field trên
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
| `→ rating \| place=... \| tourist=...` | Request rating đang được gửi |
| `→ review \| place=... \| tourist=...` | Request review đang được gửi |
| `✓ rating ghi thành công (204)` | Ghi Supabase thành công |
| `✗ rating thất bại: DioException...` | Request thất bại, xem lý do trong error |

> **Lưu ý:** Phải đăng nhập vào app trước khi test — `getCurrentUserId()` đọc `access_token`
> từ `FlutterSecureStorage`. Nếu chưa login, mọi action đều bị bỏ qua silently.

---

## Lưu ý kỹ thuật

- `activity.listener.ts` dùng `import type { ActivityLogPayload }` (không phải `import`) do yêu cầu của `isolatedModules` + `emitDecoratorMetadata` trong tsconfig.
- `DioClient` đã có `LogInterceptor` bật sẵn — mọi HTTP request/response đều được in ra terminal kể cả không có `debugPrint` trong `ActivityService`.
- `VisiblePlaceTracker` dùng `Key('vpt_${placeId}')` — mỗi POI có key riêng, đảm bảo `VisibilityDetector` hoạt động đúng khi ListView rebuild.
- Backend cho phép mọi origin `localhost:*` qua CORS — không cần cấu hình thêm khi chạy Flutter web dev.
- `LocationReviewEntity.placeId` (nullable) là `place_id` thực của POI, khác với `LocationReviewEntity.id` vốn là `itinerary_detail_id`. Cả hai field đều cần thiết: `id` dùng cho logic cập nhật state cubit, `placeId` dùng cho activity tracking.
- Chế độ demo (`kDemoMode`): `placeId` là `null` nên activity tracking cho review/rating bị skip hoàn toàn — hành vi đúng vì demo không có POI thực.
- `created_at` trong `activity_logs` được tạo bởi hàm `getNowVN()` tại backend — trả về ISO-8601 với offset `+07:00` thay vì UTC `Z`. Không phụ thuộc vào timezone của server hay Supabase.
