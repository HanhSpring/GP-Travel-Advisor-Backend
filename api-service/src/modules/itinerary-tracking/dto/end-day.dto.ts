import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsBoolean, IsISO8601, IsOptional, IsUUID } from 'class-validator';

/** Kết thúc ngày: gỡ geofence, đánh dấu "Bỏ qua", đặt lịch ngày kế. */
export class EndDayDto {
  @ApiProperty({
    description: 'ID lịch trình',
    example: '9fc65e77-a159-4e7b-ac44-aeee50309a61',
  })
  @IsUUID()
  itineraryId!: string;

  @ApiPropertyOptional({
    description: 'Ngày kết thúc (YYYY-MM-DD). Mặc định = hôm nay.',
    example: '2026-05-10',
  })
  @IsOptional()
  @IsISO8601()
  date?: string;

  @ApiPropertyOptional({
    description:
      'Đánh dấu các địa điểm còn "Chưa ghé" thành "Bỏ qua". Mặc định true.',
    default: true,
  })
  @IsOptional()
  @Type(() => Boolean)
  @IsBoolean()
  markPendingAsSkipped?: boolean;
}
