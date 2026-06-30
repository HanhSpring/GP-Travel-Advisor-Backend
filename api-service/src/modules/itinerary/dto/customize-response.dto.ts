import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

/**
 * Thông tin một hoạt động sau khi tùy chỉnh.
 * Trả về đủ dữ liệu để Flutter cập nhật UI mà không cần gọi lại API lấy toàn bộ lịch trình.
 */
export class ActivityCustomizeResultDto {
  @ApiProperty({
    example: 'detail-uuid-123',
    description: 'ID bản ghi itinerary_details',
  })
  id: string;

  @ApiProperty({ example: 'place-uuid-456', description: 'ID địa điểm' })
  placeId: string;

  @ApiProperty({
    example: 'Bảo tàng Mỹ thuật TP.HCM',
    description: 'Tên địa điểm',
  })
  title: string;

  @ApiProperty({ example: '09:30', description: 'Giờ bắt đầu tham quan' })
  startTime: string;

  @ApiProperty({ example: '11:00', description: 'Giờ kết thúc tham quan' })
  endTime: string;

  @ApiProperty({
    example: '97A Phó Đức Chính, Quận 1, TP.HCM',
    description: 'Địa chỉ',
  })
  address: string;

  @ApiProperty({
    example: 'https://storage.example.com/places/bao-tang-my-thuat.jpg',
    description: 'URL ảnh đại diện địa điểm',
  })
  imageUrl: string;

  @ApiProperty({ example: 30000, description: 'Chi phí ước tính (VNĐ)' })
  estimatedCost: number;

  @ApiProperty({ example: false, description: 'Có miễn phí không' })
  isFree: boolean;

  @ApiProperty({ example: 90, description: 'Thời gian tham quan (phút)' })
  durationMinutes: number;

  @ApiProperty({ example: true, description: 'Có đang ghim giờ không' })
  isLocked: boolean;

  @ApiPropertyOptional({
    example: '09:30',
    description: 'Giờ ghim (HH:mm) — chỉ có khi isLocked = true',
  })
  lockedArriveTime?: string;

  @ApiPropertyOptional({
    example: 'Nhớ mang theo thẻ sinh viên',
    description: 'Ghi chú cá nhân của user',
  })
  userNotes?: string;

  @ApiPropertyOptional({
    example: '20 phút đi xe máy',
    description: 'Thông tin di chuyển đến địa điểm tiếp theo',
  })
  transportInfo?: string;

  @ApiProperty({ example: 1, description: 'Thứ tự trong ngày' })
  sequenceOrder: number;

  @ApiProperty({ example: 4.5, description: 'Điểm đánh giá trung bình' })
  rating: number;

  @ApiProperty({ example: 1200, description: 'Tổng số đánh giá' })
  reviewCount: number;
}

/**
 * Response trả về sau khi tùy chỉnh lịch trình.
 * Chứa danh sách hoạt động đã được sắp xếp lại của ngày bị ảnh hưởng.
 */
export class CustomizeActivityResponseDto {
  @ApiProperty({ example: true, description: 'Thao tác thành công' })
  success: boolean;

  @ApiProperty({
    example: 'Đã chỉnh sửa và ghim giờ thành công',
    description: 'Thông báo kết quả',
  })
  message: string;

  @ApiProperty({
    example: 2,
    description: 'Ngày bị ảnh hưởng (Ngày 1, Ngày 2...)',
  })
  affectedDay: number;

  @ApiProperty({
    type: [ActivityCustomizeResultDto],
    description: 'Danh sách hoạt động đã sắp xếp lại trong ngày bị ảnh hưởng',
  })
  updatedActivities: ActivityCustomizeResultDto[];

  @ApiPropertyOptional({
    example: ['Địa điểm Cơm tấm Ba Ghiền đã được dời từ 11:30 → 12:15'],
    description: 'Các thay đổi phụ khi optimizer sắp xếp lại (nếu có)',
    isArray: true,
  })
  reorderNotes?: string[];
}

/**
 * Response trả về sau khi gợi ý địa điểm thay thế.
 */
export class SuggestedPlaceDto {
  @ApiProperty({ example: 'place-uuid-789', description: 'ID địa điểm' })
  id: string;

  @ApiProperty({ example: 'Nhà thờ Đức Bà', description: 'Tên địa điểm' })
  name: string;

  @ApiProperty({ example: 'Tham quan', description: 'Danh mục' })
  category: string;

  @ApiProperty({
    example: '1 Công xã Paris, Bến Nghé, Quận 1',
    description: 'Địa chỉ',
  })
  address: string;

  @ApiProperty({
    example: 'https://storage.example.com/places/nha-tho-duc-ba.jpg',
    description: 'URL ảnh',
  })
  imageUrl: string;

  @ApiProperty({ example: 4.7, description: 'Điểm đánh giá' })
  rating: number;

  @ApiProperty({ example: 0, description: 'Chi phí ước tính (0 = miễn phí)' })
  estimatedCost: number;

  @ApiProperty({ example: true, description: 'Miễn phí không' })
  isFree: boolean;

  @ApiProperty({
    example: '+5 phút so với vị trí hiện tại',
    description: 'Ước tính thời gian di chuyển thêm so với địa điểm gốc',
  })
  timeDiffLabel: string;
}

export class SuggestionsResponseDto {
  @ApiProperty({
    type: [SuggestedPlaceDto],
    description: 'Danh sách gợi ý địa điểm thay thế',
  })
  suggestions: SuggestedPlaceDto[];
}
