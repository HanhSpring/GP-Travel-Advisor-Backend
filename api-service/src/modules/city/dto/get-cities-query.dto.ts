import { IsOptional, IsString, MaxLength } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';

export class GetCitiesQueryDto {
  @ApiPropertyOptional({
    description: 'Từ khóa tìm kiếm tên thành phố',
    example: 'Hà Nội',
  })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  search?: string;
}
