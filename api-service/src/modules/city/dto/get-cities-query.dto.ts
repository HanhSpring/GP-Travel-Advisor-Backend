import { IsBoolean, IsOptional, IsString, MaxLength } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';

export class GetCitiesQueryDto {
  @ApiPropertyOptional({
    description: 'Từ khóa tìm kiếm tên thành phố',
    example: 'Hà Nội',
  })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  search?: string;

  @ApiPropertyOptional({
    description:
      'Chỉ trả về các tỉnh/thành app đang hỗ trợ chọn làm điểm đến (dùng cho ô "điểm đến")',
    example: true,
  })
  @IsOptional()
  @Transform(({ value }) => value === 'true' || value === true)
  @IsBoolean()
  destinationOnly?: boolean;
}
