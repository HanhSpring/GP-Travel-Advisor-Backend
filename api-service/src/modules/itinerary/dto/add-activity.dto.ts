import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsNotEmpty,
  IsString,
  IsInt,
  IsOptional,
  Min,
  Max,
  Matches,
} from 'class-validator';

/**
 * DTO dùng cho API POST thêm một địa điểm mới vào lịch trình.
 * Hệ thống sẽ tự tìm khe thời gian trống trong ngày để chèn địa điểm.
 */
export class AddActivityDto {
  /**
   * ID của địa điểm trong bảng travel.places (UUID).
   * Client lấy từ màn hình tìm kiếm / gợi ý địa điểm.
   */
  @ApiProperty({
    example: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
    description: 'UUID của địa điểm trong bảng travel.places',
  })
  @IsNotEmpty({ message: 'placeId không được để trống' })
  @IsString({ message: 'placeId phải là chuỗi UUID' })
  placeId: string;

  /**
   * Ngày muốn thêm địa điểm (bắt đầu từ 1).
   * VD: dayNumber = 2 → Ngày 2 của lịch trình.
   */
  @ApiProperty({
    example: 2,
    minimum: 1,
    description: 'Ngày muốn thêm địa điểm (Ngày 1, Ngày 2...)',
  })
  @IsInt({ message: 'dayNumber phải là số nguyên' })
  @Min(1, { message: 'dayNumber tối thiểu là 1' })
  dayNumber: number;

  /**
   * Thời gian tham quan mong muốn (phút).
   * Nếu không cung cấp, hệ thống sẽ lấy giá trị mặc định từ travel.places.
   */
  @ApiPropertyOptional({
    example: 60,
    minimum: 15,
    maximum: 480,
    description: 'Thời gian tham quan (phút). Nếu bỏ qua, dùng giá trị mặc định của địa điểm.',
  })
  @IsOptional()
  @IsInt({ message: 'durationMinutes phải là số nguyên' })
  @Min(15, { message: 'Thời gian tối thiểu 15 phút' })
  @Max(480, { message: 'Thời gian tối đa 480 phút' })
  durationMinutes?: number;

  /**
   * Giờ muốn đến (tùy chọn).
   * Nếu cung cấp, hệ thống sẽ ghim giờ này và ưu tiên giữ trong quá trình tối ưu.
   */
  @ApiPropertyOptional({
    example: '14:00',
    description: 'Giờ muốn đến (HH:mm). Nếu có, sẽ tự động ghim giờ.',
  })
  @IsOptional()
  @IsString()
  @Matches(/^\d{2}:\d{2}$/, {
    message: 'preferredTime phải đúng định dạng HH:mm',
  })
  preferredTime?: string;
}
