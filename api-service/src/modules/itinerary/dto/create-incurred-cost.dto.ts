import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsArray,
  IsEnum,
  IsInt,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  Min,
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
      'Loại chi phí: "Nước uống", "Quà tặng", "Mua sắm", "Phí gửi xe", "Khác" (mặc định), "Điều chỉnh xăng xe" (chỉ chủ lịch trình, amount là chênh lệch có thể âm, không gắn placeId/dayNumber). "Chi phí kế hoạch"/"Điều chỉnh giá" KHÔNG tạo tay được — "Chi phí kế hoạch" do hệ thống tự ghi khi check-in, sửa giá 1 địa điểm dùng API riêng (updatePlaceEffectivePrice).',
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
      'Số tiền (VND), tối thiểu 1.000đ (trị tuyệt đối), server sẽ làm tròn đến đơn vị nghìn. Với type="Điều chỉnh xăng xe" đây là CHÊNH LỆCH so với chi phí xăng xe ước tính, có thể âm. Với các type khác phải > 0.',
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
      'Ngày thứ N (1-indexed) của chuyến, dùng khi khoản chi không gắn địa điểm cụ thể nhưng vẫn biết rơi vào ngày nào. Không dùng cùng lúc với placeId, và không áp dụng cho type "Chi phí kế hoạch"/"Điều chỉnh xăng xe".',
    example: 3,
  })
  @IsOptional()
  @IsInt()
  @Min(1)
  dayNumber?: number;

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
