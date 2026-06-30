import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { VISIT_STATUSES } from '../itinerary-tracking.constants';

export class GeofenceItemDto {
  @ApiProperty({
    description: 'ID itinerary_detail (dùng cho các API sự kiện / check-in)',
  })
  itineraryDetailId!: string;

  @ApiProperty({ description: 'ID geofence (rỗng nếu ngày chưa /start)' })
  geofenceId!: string;

  @ApiProperty() placeId!: string;
  @ApiProperty() name!: string;
  @ApiProperty({ description: 'Vĩ độ tâm geofence' }) latitude!: number;
  @ApiProperty({ description: 'Kinh độ tâm geofence' }) longitude!: number;
  @ApiProperty({ description: 'Bán kính geofence (mét)' }) radiusM!: number;
  @ApiProperty({
    description: 'Ngưỡng dwell time (giây) để được tính "Đã ghé"',
  })
  dwellThresholdSeconds!: number;
  @ApiProperty({ description: 'Thời lượng hoạt động dự kiến (phút)' })
  expectedDurationMinutes!: number;
  @ApiProperty({ enum: VISIT_STATUSES }) status!: string;
  @ApiProperty({ description: 'Nhãn tiếng Việt của trạng thái' })
  statusLabelVi!: string;
}

export class StartTrackingResponseDto {
  @ApiProperty() itineraryId!: string;
  @ApiProperty({ example: '2026-05-10' }) date!: string;
  @ApiProperty({ description: 'Số geofence đăng ký được' })
  totalGeofences!: number;
  @ApiProperty({
    description: 'Số địa điểm bị bỏ qua do thiếu toạ độ (không thể geofence)',
  })
  skippedNoCoordinates!: number;
  @ApiProperty({
    description: 'Thời điểm gỡ geofence cuối ngày (cho AlarmManager)',
    example: '2026-05-10T23:00:00+07:00',
  })
  dayEndAt!: string;
  @ApiPropertyOptional({
    description: 'Ngày kế tiếp có hoạt động (null nếu là ngày cuối)',
    example: '2026-05-11',
    nullable: true,
  })
  nextDayDate!: string | null;
  @ApiPropertyOptional({
    description:
      'Thời điểm đăng ký lại geofence sáng hôm sau (cho AlarmManager)',
    example: '2026-05-11T07:00:00+07:00',
    nullable: true,
  })
  nextDayAlarmAt!: string | null;
  @ApiProperty({ type: [GeofenceItemDto] }) geofences!: GeofenceItemDto[];
  @ApiProperty() message!: string;
}

export class TrackingEventResponseDto {
  @ApiProperty() itineraryDetailId!: string;
  @ApiProperty() geofenceId!: string;
  @ApiPropertyOptional({ nullable: true }) placeId!: string | null;
  @ApiProperty() placeName!: string;
  @ApiProperty({ enum: VISIT_STATUSES }) status!: string;
  @ApiProperty() statusLabelVi!: string;
  @ApiProperty({ description: 'Trạng thái có thay đổi sau sự kiện này không' })
  statusChanged!: boolean;
  @ApiProperty({ description: 'Dwell time hiện tại (giây)' })
  dwellSeconds!: number;
  @ApiProperty() dwellThresholdSeconds!: number;
  @ApiPropertyOptional({ nullable: true }) checkedInAt!: string | null;
  @ApiProperty({ description: 'Có tạo thông báo push hay không' })
  notificationCreated!: boolean;
  @ApiPropertyOptional({ nullable: true }) notificationMessage!: string | null;
  @ApiProperty() message!: string;
}

export class TrackingStatusItemDto {
  @ApiProperty() itineraryDetailId!: string;
  @ApiProperty() geofenceId!: string;
  @ApiPropertyOptional({ nullable: true }) placeId!: string | null;
  @ApiProperty() name!: string;
  @ApiPropertyOptional({ nullable: true }) address!: string | null;
  @ApiPropertyOptional({ nullable: true }) latitude!: number | null;
  @ApiPropertyOptional({ nullable: true }) longitude!: number | null;
  @ApiProperty({ enum: VISIT_STATUSES }) status!: string;
  @ApiProperty() statusLabelVi!: string;
  @ApiProperty({ description: 'Màu marker trên bản đồ' }) mapColor!: string;
  @ApiProperty({ description: 'Loại icon marker' }) mapIcon!: string;
  @ApiPropertyOptional({ nullable: true }) enteredAt!: string | null;
  @ApiPropertyOptional({ nullable: true }) checkedInAt!: string | null;
  @ApiProperty() dwellSeconds!: number;
  @ApiProperty() dwellThresholdSeconds!: number;
}

export class TrackingSummaryDto {
  @ApiProperty() total!: number;
  @ApiProperty() visited!: number;
  @ApiProperty({ description: 'Số địa điểm chưa ghé (not_visited)' })
  pending!: number;
  @ApiProperty() skipped!: number;
  @ApiProperty({ description: 'Phần trăm hoàn thành (visited/total)' })
  progressPercent!: number;
}

export class TrackingStatusResponseDto {
  @ApiProperty() itineraryId!: string;
  @ApiProperty({ example: '2026-05-10' }) date!: string;
  @ApiProperty({ type: TrackingSummaryDto }) summary!: TrackingSummaryDto;
  @ApiProperty({ type: [TrackingStatusItemDto] })
  places!: TrackingStatusItemDto[];
}

export class EndDayResponseDto {
  @ApiProperty() itineraryId!: string;
  @ApiProperty({ example: '2026-05-10' }) date!: string;
  @ApiProperty({
    description: 'Danh sách geofenceId cần gỡ geofence trên thiết bị',
    type: [String],
  })
  removedGeofenceIds!: string[];
  @ApiProperty({
    description: 'Danh sách itinerary_detail_id tương ứng',
    type: [String],
  })
  removedItineraryDetailIds!: string[];
  @ApiProperty({
    description: 'Danh sách placeId tương ứng cần gỡ geofence',
    type: [String],
  })
  removedPlaceIds!: string[];
  @ApiProperty({ type: TrackingSummaryDto }) summary!: TrackingSummaryDto;
  @ApiPropertyOptional({ nullable: true, example: '2026-05-11' })
  nextDayDate!: string | null;
  @ApiPropertyOptional({ nullable: true, example: '2026-05-11T07:00:00+07:00' })
  nextDayAlarmAt!: string | null;
  @ApiProperty({
    description: 'Trạng thái lịch trình sau khi kết thúc ngày',
    enum: ['ongoing', 'completed', 'uncompleted'],
  })
  itineraryStatus!: string;
  @ApiProperty() message!: string;
}
