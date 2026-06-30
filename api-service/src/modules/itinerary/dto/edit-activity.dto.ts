import { ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsOptional,
  IsString,
  IsInt,
  Min,
  Max,
  MaxLength,
  Matches,
} from 'class-validator';

/**
 * DTO dùng cho API PATCH chỉnh sửa một hoạt động trong lịch trình.
 * Tất cả trường đều optional — client chỉ gửi trường nào muốn thay đổi.
 */
export class EditActivityDto {
  /**
   * Giờ đến mới, định dạng HH:mm (VD: "09:30").
   * Khi user set giờ này, hệ thống sẽ tự động ghim (is_locked = true).
   */
  @ApiPropertyOptional({
    example: '09:30',
    description: 'Giờ đến mới (HH:mm). Tự động kích hoạt ghim giờ khi set.',
  })
  @IsOptional()
  @IsString()
  @Matches(/^\d{2}:\d{2}$/, {
    message: 'arriveTime phải đúng định dạng HH:mm (VD: 09:30)',
  })
  arriveTime?: string;

  /**
   * Thời gian tham quan tính theo phút.
   * Tối thiểu 15 phút (check-in nhanh), tối đa 480 phút (8 giờ/ngày).
   */
  @ApiPropertyOptional({
    example: 90,
    minimum: 15,
    maximum: 480,
    description: 'Thời gian tham quan (phút). Min: 15, Max: 480.',
  })
  @IsOptional()
  @IsInt({ message: 'durationMinutes phải là số nguyên' })
  @Min(15, { message: 'Thời gian tham quan tối thiểu 15 phút' })
  @Max(480, { message: 'Thời gian tham quan tối đa 480 phút (8 tiếng)' })
  durationMinutes?: number;

  /**
   * Ghi chú cá nhân của user cho địa điểm này.
   * VD: "Mua đồ lưu niệm ở đây, nhớ mặc cả!"
   */
  @ApiPropertyOptional({
    example: 'Nhớ mang theo thẻ sinh viên để được giảm giá 50%',
    maxLength: 500,
    description: 'Ghi chú cá nhân (tối đa 500 ký tự)',
  })
  @IsOptional()
  @IsString({ message: 'userNotes phải là chuỗi ký tự' })
  @MaxLength(500, { message: 'Ghi chú không được vượt quá 500 ký tự' })
  userNotes?: string;

  /**
   * Gỡ ghim giờ — cho phép optimizer tự sắp xếp lại thời gian.
   * Gửi is_locked = false để bỏ ghim, không cần gửi arriveTime.
   */
  @ApiPropertyOptional({
    example: false,
    description:
      'Bỏ ghim giờ (false) hoặc giữ ghim (true). Mặc định: null = không thay đổi.',
  })
  @IsOptional()
  isLocked?: boolean;
}
