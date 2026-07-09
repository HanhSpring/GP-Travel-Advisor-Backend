import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsArray,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  Min,
} from 'class-validator';

export class UpdateIncurredCostDto {
  @ApiProperty({
    description: 'ID người gọi thao tác sửa (dùng để kiểm tra quyền)',
    example: '00000000-0000-0000-0000-000000000000',
  })
  @IsString()
  @IsNotEmpty()
  userId: string;

  @ApiPropertyOptional({ example: 'Gửi xe máy ở bãi gần biển' })
  @IsOptional()
  @IsString()
  note?: string;

  @ApiPropertyOptional({ example: 20000 })
  @IsOptional()
  @IsNumber()
  @Min(0.01, { message: 'Số tiền phải lớn hơn 0' })
  amount?: number;

  @ApiPropertyOptional({
    description: 'ID địa điểm mới (truyền null để gỡ khỏi địa điểm hiện tại)',
    example: '00000000-0000-0000-0000-000000000000',
    nullable: true,
  })
  @IsOptional()
  @IsString()
  placeId?: string | null;

  @ApiPropertyOptional({
    description: 'Danh sách user_id mới phải gánh khoản chi này. Mảng rỗng = chia đều cả nhóm.',
    example: [],
    type: [String],
  })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  chargedTo?: string[];
}
