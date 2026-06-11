import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsInt,
  IsISO8601,
  IsOptional,
  IsUUID,
  Max,
  Min,
} from 'class-validator';
import {
  MAX_GEOFENCE_RADIUS_M,
  MIN_GEOFENCE_RADIUS_M,
} from '../itinerary-tracking.constants';

export class StartTrackingDto {
  @ApiProperty({
    description: 'ID lịch trình cần theo dõi',
    example: '9fc65e77-a159-4e7b-ac44-aeee50309a61',
  })
  @IsUUID()
  itineraryId!: string;

  @ApiProperty({
    description: 'ID của tourist (chủ lịch trình)',
    example: '5f56692b-8daa-4852-bfe7-1032a07635ff',
  })
  @IsUUID()
  touristId!: string;

  @ApiPropertyOptional({
    description:
      'Ngày bắt đầu theo dõi (YYYY-MM-DD). Mặc định = hôm nay (giờ VN).',
    example: '2026-05-10',
  })
  @IsOptional()
  @IsISO8601()
  date?: string;

  @ApiPropertyOptional({
    description: `Bán kính geofence (mét), tự giới hạn trong [${MIN_GEOFENCE_RADIUS_M}, ${MAX_GEOFENCE_RADIUS_M}].`,
    example: 100,
    minimum: MIN_GEOFENCE_RADIUS_M,
    maximum: MAX_GEOFENCE_RADIUS_M,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(1000)
  radiusM?: number;
}
