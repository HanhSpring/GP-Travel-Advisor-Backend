import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsArray,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  Min,
} from 'class-validator';

export class CreateIncurredCostDto {
  @ApiProperty({
    description: 'ID người tạo khoản chi này (dùng để kiểm tra quyền sửa/xoá sau này)',
    example: '00000000-0000-0000-0000-000000000000',
  })
  @IsString()
  @IsNotEmpty()
  userId: string;

  @ApiProperty({
    description: 'Nội dung/ghi chú khoản chi phát sinh',
    example: 'Gửi xe máy ở bãi gần biển',
  })
  @IsString()
  @IsNotEmpty()
  note: string;

  @ApiProperty({
    description: 'Số tiền phát sinh thêm (VND)',
    example: 20000,
  })
  @IsNumber()
  @Min(0.01, { message: 'Số tiền phải lớn hơn 0' })
  amount: number;

  @ApiPropertyOptional({
    description:
      'ID địa điểm gắn với khoản chi này (phải thuộc lịch trình và đã ở trạng thái đã đi). Bỏ trống nếu không gắn địa điểm cụ thể.',
    example: '00000000-0000-0000-0000-000000000000',
  })
  @IsOptional()
  @IsString()
  placeId?: string;

  @ApiPropertyOptional({
    description:
      'Danh sách user_id phải gánh khoản chi này. Bỏ trống/mảng rỗng = chia đều cho cả nhóm.',
    example: [],
    type: [String],
  })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  chargedTo?: string[];
}
