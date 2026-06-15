# Theo dõi lịch trình

Tài liệu này mô tả phần backend đã tích hợp cho use case **Theo dõi lịch trình** trong `api-service`.

## Mô hình dữ liệu (schema `tracking`)

Chức năng lưu trên **2 bảng** trong schema `tracking`:

### `tracking.geofences` — vùng geofence (1 place ↔ 1 geofence)

| Cột | Kiểu | Ghi chú |
| --- | --- | --- |
| `id` | uuid (PK) | |
| `name` | varchar | tên hiển thị (mặc định lấy tên place) |
| `polygon` | geometry(Polygon, 4326) | vùng xấp xỉ hình tròn quanh toạ độ place |
| `created_at` | timestamp | |
| `is_active` | bool | |
| `place_id` *(thêm)* | uuid → `travel.places` | liên kết 1-1, có **unique index** |
| `radius_m` *(thêm)* | integer | bán kính (mét) để mobile dựng geofence hình tròn |

### `tracking.geofence_visits` — trạng thái ghé từng điểm dừng

PK ghép `(geofence_id, itinerary_detail_id)`.

| Cột | Kiểu | Ghi chú |
| --- | --- | --- |
| `geofence_id` | uuid (PK, FK → geofences) | |
| `itinerary_detail_id` | uuid (PK) | định danh điểm dừng — dùng làm khoá ở API |
| `status` | `tracking.visit_status_enum` | `not_visited` / `visited` / `skipped` (default `not_visited`) |
| `recorded_at` | timestamp | thời điểm cập nhật trạng thái gần nhất |
| `itinerary_id` *(thêm)* | uuid | truy vấn theo lịch trình |
| `tourist_id` *(thêm)* | uuid | xác thực + gửi thông báo |
| `track_date` *(thêm)* | date | truy vấn theo ngày |
| `dwell_seconds` *(thêm)* | integer | dwell time tích luỹ |
| `dwell_threshold_seconds` *(thêm)* | integer | ngưỡng để tính "Đã ghé" |
| `expected_duration_minutes` *(thêm)* | integer | thời lượng dự kiến |
| `entered_at` / `exited_at` *(thêm)* | timestamptz | mốc ENTER / EXIT |
| `enter_count` *(thêm)* | integer | số lần vào vùng |
| `checked_in_at` *(thêm)* | timestamptz | mốc được tính "Đã ghé" |
| `last_event_type` *(thêm)* | text | ENTER / DWELL / EXIT / MANUAL_CHECKIN |

> **Trạng thái** (enum `visit_status_enum`): `not_visited` = Chưa ghé (xám, icon `pin`) ·
> `visited` = Đã ghé (xanh lá, icon `check`) · `skipped` = Bỏ qua (đỏ, icon `skip`).

## Mục tiêu đã làm

- Module NestJS `ItineraryTrackingModule` tại `src/modules/itinerary-tracking`, đọc/ghi vào schema `tracking`.
- API Swagger group `Itinerary Tracking` test được trước khi tích hợp mobile.
- Geofence song song, không phụ thuộc thứ tự trong lịch trình.
- Tính dwell time theo rule: `max(2 phút, 30% thời lượng hoạt động dự kiến)`.
- Trả màu/icon marker cho bản đồ (xem bảng trạng thái ở trên).
- Khi đủ dwell hoặc check-in thủ công:
  - cập nhật `geofence_visits.status = 'visited'`, lưu `checked_in_at` + `recorded_at`
  - tạo notification nội bộ: `Bạn đã đến [Tên địa điểm]`
  - emit activity log `visited`
- Cuối ngày:
  - trả danh sách geofence cần remove trên thiết bị (`removedGeofenceIds` / `removedPlaceIds`)
  - chuyển các điểm còn `not_visited` thành `skipped`
  - trả thời điểm AlarmManager cần đăng ký lại geofence cho ngày kế tiếp
  - nếu hết ngày cuối, chuyển itinerary sang `completed`

> **Định danh ở API:** PK của `geofence_visits` là khoá ghép, nên không còn `trackingId`
> đơn. Mỗi điểm dừng được định danh bằng **`itineraryDetailId`** (lấy từ kết quả `/start`),
> kèm `geofenceId`.

## Luồng geofence ↔ place

`geofences` không tham chiếu place trực tiếp khi tạo bảng, nên khi `/start` backend sẽ:

1. Lấy `itinerary_details` của ngày → `place_id` + toạ độ từ `travel.places`.
2. **Tìm hoặc tạo** geofence theo `place_id` (`ensureGeofenceForPlace`): nếu chưa có thì
   insert một geofence với polygon vòng tròn xấp xỉ (EWKT, SRID 4326) quanh toạ độ place;
   nếu đã có thì tái dùng.
3. Tạo `geofence_visits` (status `not_visited`) nối `geofence_id` ↔ `itinerary_detail_id`.

Mobile vẫn dùng **tâm + bán kính** (Google Geofencing API dùng hình tròn); cột `polygon`
trong DB phục vụ lưu vết / hiển thị / truy vấn không gian về sau.

## API endpoints

Base path: `/itinerary/tracking`

### 1. Bắt đầu theo dõi

`POST /itinerary/tracking/start`

```json
{
  "itineraryId": "9fc65e77-a159-4e7b-ac44-aeee50309a61",
  "touristId": "5f56692b-8daa-4852-bfe7-1032a07635ff",
  "date": "2026-05-10",
  "radiusM": 100
}
```

Backend sẽ:

- kiểm tra itinerary thuộc tourist
- chuyển itinerary sang `ongoing` nếu chưa `completed`
- tạo/tái dùng geofence cho từng place trong ngày + tạo `geofence_visits`
- trả danh sách geofence gồm `itineraryDetailId`, `geofenceId`, `placeId`, `latitude`, `longitude`, `radiusM`, `dwellThresholdSeconds`

### 2. Lấy geofence để đăng ký lại

`GET /itinerary/tracking/geofences?itineraryId=...&date=2026-05-10&radiusM=100`

Dùng cho AlarmManager khi app cần đăng ký lại geofence sáng hôm sau. Nếu ngày đó chưa gọi `/start`, API vẫn dựng danh sách geofence từ lịch trình nhưng `geofenceId` sẽ rỗng.

### 3. Gửi sự kiện geofence

`POST /itinerary/tracking/event`

Body `ENTER`:

```json
{
  "itineraryDetailId": "itinerary-detail-id",
  "touristId": "5f56692b-8daa-4852-bfe7-1032a07635ff",
  "eventType": "ENTER",
  "occurredAt": "2026-05-10T09:00:00+07:00"
}
```

Body `DWELL` đủ ngưỡng:

```json
{
  "itineraryDetailId": "itinerary-detail-id",
  "touristId": "5f56692b-8daa-4852-bfe7-1032a07635ff",
  "eventType": "DWELL",
  "occurredAt": "2026-05-10T09:20:00+07:00",
  "dwellSeconds": 1200
}
```

Nếu dwell đủ ngưỡng, response có `status: "visited"` và `notificationCreated: true` nếu tạo notification thành công.

> Có thể thay `itineraryDetailId` bằng cặp `itineraryId` + `placeId` (+ `date`) nếu mobile không giữ `itineraryDetailId`.

### 4. Check-in thủ công

`POST /itinerary/tracking/check-in`

```json
{
  "itineraryDetailId": "itinerary-detail-id",
  "touristId": "5f56692b-8daa-4852-bfe7-1032a07635ff"
}
```

Dùng cho nút "Tôi đã đến đây", bỏ qua điều kiện dwell.

### 5. Xem trạng thái bản đồ

`GET /itinerary/tracking/status?itineraryId=...&date=2026-05-10`

Response trả `summary` và danh sách `places` kèm `itineraryDetailId`, `geofenceId`, `statusLabelVi`, `mapColor`, `mapIcon`, `enteredAt`, `checkedInAt`, `dwellSeconds`.

### 6. Kết thúc ngày

`POST /itinerary/tracking/end-day`

```json
{
  "itineraryId": "9fc65e77-a159-4e7b-ac44-aeee50309a61",
  "date": "2026-05-10",
  "markPendingAsSkipped": true
}
```

Backend trả:

- `removedGeofenceIds`, `removedItineraryDetailIds`, `removedPlaceIds`: mobile dùng để remove geofence trong Google Play Services
- `nextDayDate`, `nextDayAlarmAt`: mobile dùng để đặt AlarmManager
- `itineraryStatus`: `ongoing` hoặc `completed`

## Migration cần chạy trong Supabase

Do Supabase REST key không chạy được DDL trực tiếp, cần chạy migration một lần trong **Supabase Dashboard -> SQL Editor**.

> File local: `api-service/sql/2026_tracking_geofence.sql` (repo đang ignore `*.sql`, nội dung đặt kèm dưới đây để copy nhanh).

```sql
create extension if not exists postgis;

-- 1) geofences: liên kết 1-1 với place + bán kính cho geofence hình tròn ở mobile.
alter table tracking.geofences
  add column if not exists place_id uuid references travel.places(id) on delete cascade,
  add column if not exists radius_m integer not null default 100;

create unique index if not exists uq_geofences_place_id
  on tracking.geofences (place_id);

-- 2) geofence_visits: bổ sung cột dwell/audit + khoá truy vấn theo ngày.
alter table tracking.geofence_visits
  add column if not exists itinerary_id              uuid,
  add column if not exists tourist_id                uuid,
  add column if not exists track_date                date,
  add column if not exists dwell_seconds             integer     not null default 0,
  add column if not exists dwell_threshold_seconds   integer     not null default 120,
  add column if not exists expected_duration_minutes integer,
  add column if not exists entered_at                timestamptz,
  add column if not exists exited_at                 timestamptz,
  add column if not exists enter_count               integer     not null default 0,
  add column if not exists checked_in_at             timestamptz,
  add column if not exists last_event_type           text,
  add column if not exists created_at                timestamptz not null default now(),
  add column if not exists updated_at                timestamptz not null default now();

alter table tracking.geofence_visits
  alter column recorded_at set default now();

create index if not exists idx_gv_itin_date
  on tracking.geofence_visits (itinerary_id, track_date);

create index if not exists idx_gv_detail
  on tracking.geofence_visits (itinerary_detail_id);

notify pgrst, 'reload schema';
```

## Swagger test nhanh

1. Chạy migration ở trên.
2. Chạy backend.

Nếu đang đứng ở repo root `GP-Travel-Advisor-Backend`:

```bash
npm run start
```

Hoặc chuyển vào package `api-service` rồi chạy:

```bash
cd api-service
npm run start
```

3. Mở Swagger:

```text
http://localhost:3000/api-docs
```

4. Test theo thứ tự:

- `POST /itinerary/tracking/start`
- lấy `itineraryDetailId` trong response
- `POST /itinerary/tracking/event` với `ENTER`
- `POST /itinerary/tracking/event` với `DWELL` và `dwellSeconds` lớn hơn `dwellThresholdSeconds`
- `GET /itinerary/tracking/status`
- `POST /itinerary/tracking/end-day`

## Đề xuất cải tiến từ 2 bảng

Mô hình 2 bảng mở ra vài cải tiến có thể làm tiếp:

- **Tái dùng geofence giữa các lịch trình:** vì `geofences` gắn `place_id` (unique), nhiều
  lịch trình ghé cùng một place sẽ dùng chung 1 vùng — giảm số polygon trùng. Đã hỗ trợ ở
  `ensureGeofenceForPlace`.
- **Truy vấn không gian thật:** thay vì mobile tự point-in-polygon, có thể thêm RPC PostGIS
  `ST_Contains(polygon, ST_MakePoint(lng,lat))` để backend xác nhận vị trí — chống giả mạo
  check-in.
- **`is_active` cho geofence:** ẩn tạm một vùng (đóng cửa, sửa chữa) mà không xoá dữ liệu lịch sử ghé.
- **Lịch sử ghé nhiều lần:** hiện PK ghép `(geofence_id, itinerary_detail_id)` chỉ giữ 1
  dòng/điểm dừng. Nếu cần nhật ký mọi lần ENTER/EXIT, tách thêm bảng `geofence_events` append-only.
- **Polygon tuỳ biến:** với địa điểm lớn (công viên, khu du lịch) có thể thay polygon vòng tròn
  bằng polygon vẽ tay để geofence sát ranh giới thực tế.

## Ghi chú mobile

- Backend không xin quyền vị trí; mobile xử lý quyền Always Allow / Background Location theo luồng use case.
- Backend không trực tiếp remove/register geofence trong Android; API trả đủ dữ liệu (tâm + bán kính) để mobile gọi Google Play Services Geofencing API.
- Backend không chạy AlarmManager; API trả `dayEndAt` và `nextDayAlarmAt` để mobile đặt lịch.
- Với GPS yếu, mobile nên hiển thị thông báo "Không thể xác định chính xác vị trí, đang chờ tín hiệu" trước khi gửi event lên backend.
