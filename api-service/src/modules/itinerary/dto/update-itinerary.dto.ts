import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, MaxLength } from 'class-validator';

export class UpdateItineraryDto {
  @ApiPropertyOptional({
    example: 'Chuyến đi Đà Nẵng 3 ngày',
    description: 'Tên/mô tả lịch trình',
  })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  description?: string;
}
