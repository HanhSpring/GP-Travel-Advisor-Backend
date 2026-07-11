import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsArray,
  IsEnum,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
} from 'class-validator';
import { CostType } from './cost-type.enum';

export class CreateIncurredCostDto {
  @ApiProperty({
    description: 'ID người tạo khoản chi này (dùng để kiểm tra quyền sửa/xoá sau này)',
    example: '00000000-0000-0000-0000-000000000000',
  })
  @IsString()
  @IsNotEmpty()
  userId: string;

  @ApiPropertyOptional({
    description:
      'Loại chi phí: "Điều chỉnh giá" (chỉ chủ lịch trình, bắt buộc kèm placeId, amount là chênh lệch có thể âm), "Nước uống", "Quà tặng", "Mua sắm", "Phí gửi xe", "Khác" (mặc định).',
    enum: CostType,
    example: CostType.PHI_GUI_XE,
  })
  @IsOptional()
  @IsEnum(CostType)
  type?: CostType;

  @ApiProperty({
    description: 'Nội dung/ghi chú khoản chi phát sinh',
    example: 'Gửi xe máy ở bãi gần biển',
  })
  @IsString()
  @IsNotEmpty()
  note: string;

  @ApiProperty({
    description:
      'Số tiền (VND), tối thiểu 1.000đ (trị tuyệt đối), server sẽ làm tròn đến đơn vị nghìn. Với type="Điều chỉnh giá" đây là CHÊNH LỆCH so với giá ước tính của hệ thống, có thể âm. Với các type khác phải > 0.',
    example: 20000,
  })
  @IsNumber()
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
