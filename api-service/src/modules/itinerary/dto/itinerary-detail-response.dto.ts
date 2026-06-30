import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

// --- TẦNG 3: CHI TIẾT HOẠT ĐỘNG & DI CHUYỂN ---
class TransitInfoDto {
  @ApiProperty({
    example: 'BIKE',
    description: 'Phương tiện: WALK, BIKE, TAXI, TRANSIT',
  })
  mode: string;

  @ApiProperty({
    example: '15 phút',
    description: 'Thời gian di chuyển ước tính',
  })
  durationStr: string;

  @ApiPropertyOptional({
    example: 45000,
    description: 'Chi phí ước tính (nếu có, VD: Taxi)',
  })
  estimatedCost?: number;
}

class ItineraryActivityDto {
  @ApiProperty({ example: 'act-123', description: 'ID của hoạt động' })
  id: string;

  @ApiPropertyOptional({ example: 'place-123', description: 'ID của địa điểm' })
  placeId?: string;

  @ApiProperty({ example: '08:00', description: 'Giờ bắt đầu' })
  startTime: string;

  @ApiProperty({ example: '09:00', description: 'Giờ kết thúc' })
  endTime: string;

  @ApiProperty({ example: 'Chợ Hoa Hồ Thị Kỷ', description: 'Tên địa điểm' })
  placeName: string;

  @ApiProperty({
    example: 'Hẻm 52 Hồ Thị Kỷ, Phường 1...',
    description: 'Địa chỉ ngắn gọn',
  })
  address: string;

  @ApiProperty({
    example: 'https://img-url.com/cho-hoa.jpg',
    description: 'Ảnh thumbnail',
  })
  imageUrl: string;

  @ApiProperty({
    example: 'MIỄN PHÍ',
    description: 'Nhãn hiển thị giá (VD: 30K VNĐ, MIỄN PHÍ)',
  })
  priceLabel: string;

  @ApiProperty({
    example: 120000,
    description: 'Chi phí ước tính dạng số (VNĐ)',
  })
  estimatedCost: number;

  @ApiProperty({
    example: 120000,
    description: 'Alias cho estimatedCost để mobile UI hiển thị giá',
  })
  price: number;

  @ApiProperty({
    example: false,
    description: 'Địa điểm miễn phí hay không',
  })
  isFree: boolean;

  @ApiProperty({
    example: ['Vé vào cổng'],
    description: 'Các tag thông tin thêm',
    isArray: true,
  })
  tags: string[];

  // Điểm mấu chốt: Liên kết với điểm đến tiếp theo
  @ApiPropertyOptional({
    type: TransitInfoDto,
    description: 'Thông tin di chuyển ĐẾN điểm tiếp theo',
  })
  transitToNext?: TransitInfoDto;
}

// --- TẦNG 2: CHI TIẾT TỪNG NGÀY ---
class ItineraryDayDto {
  @ApiProperty({ example: '12/06', description: 'Ngày tháng (dùng cho Tab)' })
  dateLabel: string;

  @ApiProperty({ example: 1, description: 'Ngày số mấy (Ngày 1, Ngày 2)' })
  dayNumber: number;

  @ApiProperty({
    example: 32,
    description: 'Nhiệt độ dự báo (°C)',
    nullable: true,
  })
  weatherTemp: number | null;

  @ApiProperty({
    example: '6 tiếng 30 phút',
    description: 'Tổng thời gian tham quan',
  })
  activeTimeStr: string;

  @ApiProperty({
    example: 1200000,
    description: 'Ngân sách phân bổ cho ngày này',
  })
  dayBudget: number;

  @ApiProperty({
    example: 35,
    description: 'Phần trăm hoàn thành (cho thanh Progress bar)',
  })
  progressPercent: number;

  @ApiProperty({
    example: '12.5km',
    description: 'Tổng quãng đường di chuyển trong ngày',
    nullable: true,
  })
  totalDistanceStr: string | null;

  @ApiProperty({
    example: '~45 phút',
    description: 'Tổng thời gian di chuyển trong ngày',
    nullable: true,
  })
  totalTransitTimeStr: string | null;

  @ApiProperty({
    type: [ItineraryActivityDto],
    description: 'Danh sách các điểm đến trong ngày',
  })
  activities: ItineraryActivityDto[];
}

// --- TẦNG 1: TỔNG QUAN LỊCH TRÌNH (ROOT) ---
export class ItineraryDetailResponseDto {
  @ApiProperty({ example: 'itn-uuid-999' })
  id: string;

  @ApiProperty({
    example: 'Khám phá Sài Gòn 3 ngày',
    description: 'Tiêu đề lịch trình',
  })
  title: string;

  @ApiProperty({
    example: '12 Th06 - 15 Th06, 2026',
    description: 'Chuỗi ngày tham quan',
  })
  dateRangeLabel: string;

  @ApiProperty({
    example: 'IN_PROGRESS',
    description: 'Trạng thái: ĐANG DIỄN RA, SẮP TỚI, ĐÃ KẾT THÚC',
  })
  status: string;

  @ApiProperty({
    example: true,
    description: 'Trạng thái Công khai / Riêng tư (Toggle)',
  })
  isPublic: boolean;

  @ApiProperty({ example: 5000000, description: 'Tổng ngân sách' })
  totalBudget: number;

  @ApiProperty({ example: 3, description: 'Tổng số ngày' })
  totalDays: number;

  @ApiProperty({ example: 12, description: 'Tổng số địa điểm' })
  totalPlaces: number;

  @ApiProperty({
    type: [ItineraryDayDto],
    description: 'Mảng chi tiết từng ngày',
  })
  days: ItineraryDayDto[];
}
