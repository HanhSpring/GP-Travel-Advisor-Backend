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

export class UpdateIncurredCostDto {
  @ApiProperty({
    description: 'ID người gọi thao tác sửa (dùng để kiểm tra quyền)',
    example: '00000000-0000-0000-0000-000000000000',
  })
  @IsString()
  @IsNotEmpty()
  userId: string;

  @ApiPropertyOptional({
    description: 'Đổi loại chi phí (hiếm khi cần — thường giữ nguyên type lúc tạo).',
    enum: CostType,
  })
  @IsOptional()
  @IsEnum(CostType)
  type?: CostType;

  @ApiPropertyOptional({ example: 'Gửi xe máy ở bãi gần biển' })
  @IsOptional()
  @IsString()
  note?: string;

  @ApiPropertyOptional({
    description:
      'Số tiền mới, tối thiểu 1.000đ (trị tuyệt đối), server sẽ làm tròn đến đơn vị nghìn. Với "Điều chỉnh xăng xe" hoặc đính chính 1 dòng "Điều chỉnh giá" cũ, đây là chênh lệch, có thể âm; các type khác phải > 0.',
    example: 20000,
  })
  @IsOptional()
  @IsNumber()
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

  @ApiPropertyOptional({
    description:
      'Ngày thứ N (1-indexed) mới (truyền null để gỡ khỏi ngày hiện tại). Bị bỏ qua nếu khoản chi đang/sẽ gắn placeId — ngày sẽ tự động lấy theo ngày viếng thăm thực tế của địa điểm đó.',
    example: 3,
    nullable: true,
  })
  @IsOptional()
  @IsInt()
  @Min(1)
  dayNumber?: number | null;
}
