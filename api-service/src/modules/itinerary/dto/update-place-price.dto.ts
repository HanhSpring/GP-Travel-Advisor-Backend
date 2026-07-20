import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsNumber, IsString } from 'class-validator';

/** Sửa giá HIỆU LỰC của 1 địa điểm đã visited — cập nhật thẳng lên dòng
 * "Chi phí kế hoạch" (amount là giá MỚI tuyệt đối, không phải chênh lệch).
 * Chỉ chủ lịch trình được gọi. Xem IncurredCostsService.updatePlaceEffectivePrice(). */
export class UpdatePlacePriceDto {
  @ApiProperty({
    description: 'ID người gọi (phải là chủ lịch trình)',
    example: '00000000-0000-0000-0000-000000000000',
  })
  @IsString()
  @IsNotEmpty()
  userId: string;

  @ApiProperty({
    description: 'ID địa điểm cần sửa giá (phải đã ở trạng thái đã đi)',
    example: '00000000-0000-0000-0000-000000000000',
  })
  @IsString()
  @IsNotEmpty()
  placeId: string;

  @ApiProperty({
    description: 'Giá MỚI (VNĐ, tuyệt đối, > 0), tối thiểu 1.000đ, server làm tròn đến đơn vị nghìn.',
    example: 60000,
  })
  @IsNumber()
  amount: number;
}
