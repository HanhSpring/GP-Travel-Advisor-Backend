import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsIn,
  IsInt,
  IsISO8601,
  IsOptional,
  IsUUID,
  Min,
} from 'class-validator';
import { GEOFENCE_EVENTS } from '../itinerary-tracking.constants';
import type { GeofenceEventType } from '../itinerary-tracking.constants';

export class GeofenceEventDto {
  @ApiPropertyOptional({
    description:
      'ID itinerary_detail (lấy từ kết quả /start). Ưu tiên dùng trường này.',
    example: 'b2c4...-itinerary-detail-id',
  })
  @IsOptional()
  @IsUUID()
  itineraryDetailId?: string;

  @ApiPropertyOptional({
    description: 'ID lịch trình (bắt buộc nếu không có itineraryDetailId).',
  })
  @IsOptional()
  @IsUUID()
  itineraryId?: string;

  @ApiPropertyOptional({
    description: 'ID địa điểm (bắt buộc nếu không có itineraryDetailId).',
  })
  @IsOptional()
  @IsUUID()
  placeId?: string;

  @ApiPropertyOptional({
    description: 'Ngày theo dõi (YYYY-MM-DD). Mặc định = hôm nay.',
    example: '2026-05-10',
  })
  @IsOptional()
  @IsISO8601()
  date?: string;

  @ApiProperty({
    description: 'ID của tourist (để xác thực + gửi thông báo).',
    example: '5f56692b-8daa-4852-bfe7-1032a07635ff',
  })
  @IsUUID()
  touristId!: string;

  @ApiProperty({
    enum: GEOFENCE_EVENTS,
    description:
      'Loại sự kiện geofence từ Google Play Services: ENTER khi vào vùng, DWELL khi lưu lại, EXIT khi rời đi.',
    example: 'DWELL',
  })
  @IsIn(GEOFENCE_EVENTS)
  eventType!: GeofenceEventType;

  @ApiPropertyOptional({
    description:
      'Thời điểm xảy ra sự kiện (ISO 8601). Mặc định = thời điểm gọi API.',
  })
  @IsOptional()
  @IsISO8601()
  occurredAt?: string;

  @ApiPropertyOptional({
    description:
      'Dwell time (giây) do thiết bị tính sẵn. Nếu bỏ trống, backend tự tính từ thời điểm ENTER.',
    example: 150,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  dwellSeconds?: number;
}
