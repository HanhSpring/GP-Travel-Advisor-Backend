/**
 * Hằng số nghiệp vụ cho chức năng "Theo dõi lịch trình" (geofence + dwell time).
 *
 * Dữ liệu lưu ở schema `tracking` với 2 bảng:
 *   - tracking.geofences        : vùng geofence (polygon) gắn với 1 place.
 *   - tracking.geofence_visits  : trạng thái ghé của từng itinerary_detail.
 */

// Bán kính geofence (mét). Use case yêu cầu 80-150m.
export const DEFAULT_GEOFENCE_RADIUS_M = 100;
export const MIN_GEOFENCE_RADIUS_M = 80;
export const MAX_GEOFENCE_RADIUS_M = 150;

// Ngưỡng dwell time theo UC: max(2 phút, 30% thời lượng hoạt động dự kiến).
// 60-phút place → 1080s (18 min); 30-phút → 540s; short → tối thiểu 120s.
export const MIN_DWELL_SECONDS = 120;
export const DWELL_FRACTION = 0.3;
export const DEFAULT_EXPECTED_DURATION_MINUTES = 60;

// Lịch tự động cho mobile (AlarmManager).
export const DAY_END_HOUR = 23; // remove geofence cuối ngày lúc 23h
export const NEXT_DAY_ALARM_HOUR = 7; // đăng ký lại geofence sáng hôm sau lúc 7h
export const VN_TZ_OFFSET = '+07:00'; // Asia/Ho_Chi_Minh

// Các loại sự kiện geofence (khớp Google Geofencing API transitions).
export const GEOFENCE_EVENTS = ['ENTER', 'DWELL', 'EXIT'] as const;
export type GeofenceEventType = (typeof GEOFENCE_EVENTS)[number];

// Trạng thái ghé — khớp enum tracking.visit_status_enum trong DB.
// not_visited = Chưa đến · visited = Đã đến nơi · skipped = Bỏ qua.
export const VISIT_STATUSES = ['not_visited', 'visited', 'skipped'] as const;
export type VisitStatus = (typeof VISIT_STATUSES)[number];
export const DEFAULT_VISIT_STATUS: VisitStatus = 'not_visited';

// Nhãn tiếng Việt + màu/icon hiển thị trên bản đồ.
export const STATUS_LABEL_VI: Record<VisitStatus, string> = {
  not_visited: 'Chưa đến',
  visited: 'Đã đến nơi',
  skipped: 'Bỏ qua',
};

export const STATUS_MAP_COLOR: Record<VisitStatus, string> = {
  not_visited: '#9CA3AF', // xám
  visited: '#22C55E', // xanh lá
  skipped: '#EF4444', // đỏ
};

export const STATUS_MAP_ICON: Record<VisitStatus, string> = {
  not_visited: 'pin',
  visited: 'check',
  skipped: 'skip',
};

/** Tính ngưỡng dwell time (giây) từ thời lượng dự kiến (phút). */
export function computeDwellThresholdSeconds(
  expectedDurationMinutes: number | null | undefined,
): number {
  const minutes = expectedDurationMinutes ?? DEFAULT_EXPECTED_DURATION_MINUTES;
  return Math.max(MIN_DWELL_SECONDS, Math.round(minutes * 60 * DWELL_FRACTION));
}

/** Giới hạn bán kính geofence trong khoảng cho phép. */
export function clampGeofenceRadius(radius: number | null | undefined): number {
  const value = radius ?? DEFAULT_GEOFENCE_RADIUS_M;
  return Math.min(
    MAX_GEOFENCE_RADIUS_M,
    Math.max(MIN_GEOFENCE_RADIUS_M, value),
  );
}

/** Tạo timestamp ISO theo giờ VN, ví dụ 2026-05-10T23:00:00+07:00. */
export function vnTimestamp(date: string, hour: number): string {
  const hh = String(hour).padStart(2, '0');
  return `${date}T${hh}:00:00${VN_TZ_OFFSET}`;
}

const EARTH_RADIUS_M = 6378137; // bán kính Trái Đất (mét) cho phép tính WGS84

/**
 * Sinh polygon (xấp xỉ hình tròn) dạng EWKT để lưu vào cột geometry(Polygon,4326)
 * của tracking.geofences. Mobile vẫn dùng tâm + bán kính cho Google Geofencing,
 * polygon ở DB phục vụ lưu vết / hiển thị / truy vấn không gian.
 */
export function buildCirclePolygonEWKT(
  longitude: number,
  latitude: number,
  radiusM: number,
  segments = 32,
): string {
  const latRad = (latitude * Math.PI) / 180;
  const points: string[] = [];
  for (let i = 0; i <= segments; i += 1) {
    const theta = (i / segments) * 2 * Math.PI;
    const dx = radiusM * Math.cos(theta);
    const dy = radiusM * Math.sin(theta);
    const dLng =
      ((dx / (EARTH_RADIUS_M * Math.cos(latRad))) * 180) / Math.PI;
    const dLat = ((dy / EARTH_RADIUS_M) * 180) / Math.PI;
    points.push(
      `${(longitude + dLng).toFixed(7)} ${(latitude + dLat).toFixed(7)}`,
    );
  }
  return `SRID=4326;POLYGON((${points.join(', ')}))`;
}
