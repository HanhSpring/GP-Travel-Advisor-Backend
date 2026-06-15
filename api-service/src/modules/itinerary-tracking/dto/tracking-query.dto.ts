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

/** Query cho GET /status */
export class TrackingStatusQueryDto {
  @ApiProperty({
    description: 'ID lịch trình',
    example: '9fc65e77-a159-4e7b-ac44-aeee50309a61',
  })
  @IsUUID()
  itineraryId!: string;

  @ApiPropertyOptional({
    description: 'Ngày cần xem (YYYY-MM-DD). Mặc định = hôm nay.',
    example: '2026-05-10',
  })
  @IsOptional()
  @IsISO8601()
  date?: string;
}

/** Query cho GET /geofences */
export class GeofencesQueryDto extends TrackingStatusQueryDto {
  @ApiPropertyOptional({
    description: `Bán kính geofence (mét), tự giới hạn trong [${MIN_GEOFENCE_RADIUS_M}, ${MAX_GEOFENCE_RADIUS_M}].`,
    example: 100,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(1000)
  radiusM?: number;
}
