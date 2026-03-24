import {
  Controller,
  Post,
  Body,
  HttpStatus,
  HttpCode,
  Get,
  Param,
  Patch,
  Delete,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiParam } from '@nestjs/swagger';
import { ItineraryService } from './itinerary.service';
import { CreateItineraryDto } from './dto/create-itinerary.dto';
import { ItinerarySummaryResponseDto } from './dto/itinerary-summary-response.dto';
import { ItineraryDetailResponseDto } from './dto/itinerary-detail-response.dto';
import { ToggleVisibilityDto } from './dto/toggle-visibility.dto';
import { UpdateActivityNoteDto } from './dto/update-activity-note.dto';

@ApiTags('Itinerary')
@Controller('itinerary')
export class ItineraryController {
  constructor(private readonly service: ItineraryService) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Tạo lịch trình du lịch mới bằng AI' })
  @ApiResponse({
    status: 201,
    description: 'Lịch trình đã được khởi tạo thành công',
    type: ItinerarySummaryResponseDto, // Khai báo type trả về tại đây
  })
  create(@Body() body: CreateItineraryDto): ItinerarySummaryResponseDto {
    // Return mock data khớp chuẩn 100% với giao diện UI
    return {
      id: 'uuid-123',
      destinationName: 'Hà Nội',
      dateRangeLabel: '15 Th10 - 20 Th10, 2023',
      mainTransportMode: 'AIRPLANE',
      statistics: {
        totalDays: 6,
        totalActivities: 12,
        totalHotels: 2,
        totalTransfers: 5,
      },
      dailySummaries: [
        {
          dayNumber: 1,
          dateLabel: '15 Th10',
          title: 'Đến nơi & Nhận phòng',
          iconType: 'FLIGHT',
        },
        {
          dayNumber: 2,
          dateLabel: '16 Th10',
          title: 'Khám phá Hồ Gươm & Lăng Bác',
          iconType: 'CAMERA',
        },
        {
          dayNumber: 3,
          dateLabel: '17 Th10',
          title: 'Tham quan Đền chùa & Văn hóa',
          iconType: 'TEMPLE',
        },
        {
          dayNumber: 4,
          dateLabel: '18 Th10',
          title: 'Mua sắm tại Aeon Mall Long Biên',
          iconType: 'SHOPPING',
        },
        {
          dayNumber: 5,
          dateLabel: '19 Th10',
          title: 'Nhà tù Hoả Lò & Chợ Đồng Xuân',
          iconType: 'STAR',
        },
      ],
      budget: {
        estimatedCost: 4500000,
        totalBudget: 7500000,
        statusTag: 'Trong tầm kiểm soát',
      },
      importantNotes: [
        'Mang theo hộ chiếu/ CCCD và bảo hiểm du lịch.',
        'Chuẩn bị quần áo phù hợp với thời tiết.',
        'Pin dự phòng cho điện thoại.',
      ],
    };
  }

  @Get(':id')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Lấy chi tiết toàn bộ lịch trình, từng ngày và từng điểm đến',
  })
  @ApiParam({
    name: 'id',
    description: 'ID của lịch trình',
    example: 'uuid-sg-3days',
  })
  @ApiResponse({
    status: 200,
    description: 'Trả về toàn bộ cây dữ liệu lịch trình',
    type: ItineraryDetailResponseDto,
  })
  getItineraryDetail(@Param('id') id: string): ItineraryDetailResponseDto {
    // Trả về dữ liệu mẫu (Mock data) khớp với hình UI
    return {
      id: id,
      title: 'Khám phá Sài Gòn 3 ngày',
      dateRangeLabel: '12 Th06 - 15 Th06, 2026',
      status: 'IN_PROGRESS',
      isPublic: true,
      totalBudget: 5000000,
      totalDays: 3,
      totalPlaces: 12,
      days: [
        {
          dateLabel: '12/06',
          dayNumber: 1,
          weatherTemp: 32,
          activeTimeStr: '6 tiếng 30 phút',
          dayBudget: 1200000,
          progressPercent: 35,
          totalDistanceStr: '12.5km',
          totalTransitTimeStr: '~45 phút',
          activities: [
            {
              id: 'act-1',
              startTime: '08:00',
              endTime: '09:00',
              placeName: 'Chợ Hoa Hồ Thị Kỷ',
              address: 'Hẻm 52 Hồ Thị Kỷ, Phường 1...',
              imageUrl: 'https://example.com/cho-hoa.jpg',
              priceLabel: 'MIỄN PHÍ',
              tags: [],
              transitToNext: {
                mode: 'BIKE',
                durationStr: '15 phút di chuyển',
              },
            },
            {
              id: 'act-2',
              startTime: '09:30',
              endTime: '11:00',
              placeName: 'Bảo tàng Mỹ thuật',
              address: '97A Phó Đức Chính, Quận 1',
              imageUrl: 'https://example.com/bao-tang.jpg',
              priceLabel: '30K VNĐ',
              tags: ['Vé vào cổng'],
              transitToNext: {
                mode: 'TAXI',
                durationStr: '10 phút taxi',
                estimatedCost: 45000,
              },
            },
            {
              id: 'act-3',
              startTime: '11:30',
              endTime: '12:30',
              placeName: 'Cơm tấm Ba Ghiền',
              address: '84 Đ. Đặng Văn Ngữ, Phường 10, Phú Nhuận',
              imageUrl: 'https://example.com/com-tam.jpg',
              priceLabel: '',
              tags: [],
              // Không có transitToNext vì đây có thể là điểm nghỉ trưa hoặc cuối ngày (tạm thời)
            },
          ],
        },
        // ... Dữ liệu ngày 2, ngày 3
      ],
    };
  }

  @Patch(':id/visibility')
  @ApiOperation({ summary: 'Bật/Tắt trạng thái Công khai của lịch trình' })
  @ApiParam({ name: 'id', description: 'ID của lịch trình' })
  async toggleVisibility(
    @Param('id') id: string,
    @Body() toggleDto: ToggleVisibilityDto,
  ) {
    await this.service.toggleVisibility(id, toggleDto.isPublic);
    return {
      message: toggleDto.isPublic
        ? 'Lịch trình đã được công khai'
        : 'Lịch trình đã chuyển về riêng tư',
      success: true,
    };
  }

  @Delete(':itineraryId/activities/:activityId')
  @ApiOperation({ summary: 'Xóa một địa điểm/hoạt động khỏi lịch trình' })
  @ApiParam({ name: 'itineraryId', description: 'ID của lịch trình tổng' })
  @ApiParam({ name: 'activityId', description: 'ID của hoạt động cần xóa' })
  async deleteActivity(
    @Param('itineraryId') itineraryId: string,
    @Param('activityId') activityId: string,
  ) {
    await this.service.deleteActivity(itineraryId, activityId);
    return {
      message: 'Đã xóa địa điểm khỏi lịch trình và tính toán lại tuyến đường',
      success: true,
    };
  }

  // @Patch(':itineraryId/activities/:activityId/note')
  // @HttpCode(HttpStatus.OK)
  // @ApiOperation({
  //   summary: 'Lưu tự động (Auto-save) ghi chú cá nhân của một địa điểm',
  // })
  // @ApiParam({ name: 'itineraryId', description: 'ID của lịch trình' })
  // @ApiParam({ name: 'activityId', description: 'ID của hoạt động' })
  // async updateActivityNote(
  //   @Param('itineraryId') itineraryId: string,
  //   @Param('activityId') activityId: string,
  //   @Body() updateDto: UpdateActivityNoteDto,
  // ) {
  //   await this.service.updateActivityNote(
  //     itineraryId,
  //     activityId,
  //     updateDto.personalNote,
  //   );

  //   return {
  //     message: 'Đã lưu ghi chú',
  //     success: true,
  //   };
  // }
}
