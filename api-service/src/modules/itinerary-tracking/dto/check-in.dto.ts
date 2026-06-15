import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsISO8601, IsOptional, IsUUID } from 'class-validator';

/** Đánh dấu "Đã ghé" thủ công (nút "Tôi đã đến đây") — bỏ qua điều kiện dwell. */
export class CheckInDto {
  @ApiPropertyOptional({
    description: 'ID itinerary_detail (ưu tiên). Lấy từ kết quả /start.',
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
    description: 'ID của tourist.',
    example: '5f56692b-8daa-4852-bfe7-1032a07635ff',
  })
  @IsUUID()
  touristId!: string;
}
