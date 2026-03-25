import { ApiProperty } from '@nestjs/swagger';

// --- CÁC CLASS THÀNH PHẦN ---

class ItineraryStatsDto {
  @ApiProperty({ example: 6, description: 'Tổng số ngày' })
  totalDays: number;

  @ApiProperty({ example: 12, description: 'Tổng số hoạt động/địa điểm' })
  totalActivities: number;

  @ApiProperty({ example: 2, description: 'Số lượng khách sạn lưu trú' })
  totalHotels: number;

  @ApiProperty({
    example: 5,
    description: 'Số lượt di chuyển giữa các tỉnh/thành',
  })
  totalTransfers: number;
}

class DailySummaryDto {
  @ApiProperty({ example: 1, description: 'Ngày thứ mấy của chuyến đi' })
  dayNumber: number;

  @ApiProperty({
    example: '15 Th10',
    description: 'Ngày tháng định dạng ngắn gọn',
  })
  dateLabel: string;

  @ApiProperty({
    example: 'Đến nơi & Nhận phòng',
    description: 'Tiêu đề/Chủ đề chính của ngày hôm đó',
  })
  title: string;

  @ApiProperty({
    example: 'FLIGHT',
    description: 'Loại icon hiển thị (FLIGHT, CAMERA, TEMPLE, SHOPPING, STAR)',
  })
  iconType: string;
}

class BudgetSummaryDto {
  @ApiProperty({
    example: 4500000,
    description: 'Ngân sách dự kiến đã chi tiêu (VND)',
  })
  estimatedCost: number;

  @ApiProperty({
    example: 7500000,
    description: 'Tổng ngân sách tối đa do user thiết lập ở Bước 3 (VND)',
  })
  totalBudget: number;

  @ApiProperty({
    example: 'Trong tầm kiểm soát',
    description: 'Trạng thái đánh giá ngân sách',
  })
  statusTag: string;
}

// --- CLASS TỔNG TRẢ VỀ CHO FRONTEND ---

export class ItinerarySummaryResponseDto {
  @ApiProperty({
    example: 'itn-uuid-1234',
    description: 'ID của lịch trình vừa tạo',
  })
  id: string;

  @ApiProperty({ example: 'Hà Nội', description: 'Tên điểm đến' })
  destinationName: string;

  @ApiProperty({
    example: '15 Th10 - 20 Th10, 2023',
    description: 'Chuỗi thời gian hiển thị',
  })
  dateRangeLabel: string;

  @ApiProperty({ example: 'AIRPLANE', description: 'Icon phương tiện chính' })
  mainTransportMode: string;

  @ApiProperty({
    type: ItineraryStatsDto,
    description: 'Khối thống kê tổng quan',
  })
  statistics: ItineraryStatsDto;

  @ApiProperty({
    type: [DailySummaryDto],
    description: 'Danh sách tóm tắt từng ngày',
  })
  dailySummaries: DailySummaryDto[];

  @ApiProperty({
    type: BudgetSummaryDto,
    description: 'Khối thống kê ngân sách',
  })
  budget: BudgetSummaryDto;

  @ApiProperty({
    example: [
      'Mang theo hộ chiếu/ CCCD và bảo hiểm du lịch.',
      'Chuẩn bị quần áo phù hợp với thời tiết thu đông.',
      'Pin dự phòng cho điện thoại.',
    ],
    description: 'Các ghi chú nhắc nhở tự động từ AI',
  })
  importantNotes: string[];
}
