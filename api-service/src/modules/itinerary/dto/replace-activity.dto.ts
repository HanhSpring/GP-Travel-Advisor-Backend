import { ApiPropertyOptional, ApiProperty } from '@nestjs/swagger';
import { IsOptional, IsString } from 'class-validator';

export class ReplaceActivityDto {
  @ApiProperty({ description: 'UUID của địa điểm mới từ travel.places' })
  @IsString()
  newPlaceId: string;

  @ApiPropertyOptional({ description: 'Cờ cho phép giảm giờ các hoạt động khác để xử lý xung đột' })
  @IsOptional()
  allowReduceTime?: boolean;

  @ApiPropertyOptional({ description: 'Cờ cho phép kéo dài thời gian hoạt động của ngày để xử lý xung đột' })
  @IsOptional()
  extendTime?: boolean;
}
