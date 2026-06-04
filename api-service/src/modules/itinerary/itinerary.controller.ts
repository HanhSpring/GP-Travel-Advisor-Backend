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
  Query,
} from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiParam,
  ApiBody,
  ApiQuery,
} from '@nestjs/swagger';
import { ItineraryService } from './itinerary.service';
import { RecommendationService } from '../recommendation/recommendation.service';
import { GetItinerariesDto } from './dto/get-itineraries.dto';
import { CreateItineraryDto } from './dto/create-itinerary.dto';
import { ItineraryDetailResponseDto } from './dto/itinerary-detail-response.dto';
import { ItineraryResponseDto } from './dto/itinerary-response.dto';
import { ToggleVisibilityDto } from './dto/toggle-visibility.dto';
import { EditActivityDto } from './dto/edit-activity.dto';
import { AddActivityDto } from './dto/add-activity.dto';
import {
  CustomizeActivityResponseDto,
  SuggestionsResponseDto,
} from './dto/customize-response.dto';
import {
  TwoTowerRetrievalResponseDto,
} from './dto/retrieval-response.dto';

@ApiTags('Itinerary')
@Controller('itinerary')
export class ItineraryController {
  constructor(
    private readonly service: ItineraryService,
    private readonly recommendationService: RecommendationService,
  ) {}

  @Get('my-itineraries')
  @ApiOperation({ summary: 'Lấy danh sách lịch trình của user' })
  @ApiResponse({ type: ItineraryResponseDto })
  getMyItineraries(@Query() query: GetItinerariesDto) {
    return this.service.getMyItineraries(query.userId);
  }

  /**
   * Two-Tower retrieval: nhận tham số chuyến đi → trả top-K địa điểm
   * (cosine_score, predict_ranking = null chờ ranking model).
   */
  @Post()
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary: 'Two-Tower retrieval — trả top-K địa điểm phù hợp',
    description:
      'Gọi FastAPI encode-query → pgvector search → trả danh sách candidates. ' +
      'predict_ranking sẽ được điền bởi ranking model (thành viên khác).',
  })
  @ApiQuery({
    name: 'top_k',
    required: false,
    type: Number,
    example: 100,
    description: 'Số lượng candidates tối đa (mặc định 100)',
  })
  @ApiResponse({
    status: 201,
    description: 'Top-K địa điểm theo cosine similarity',
    type: TwoTowerRetrievalResponseDto,
  })
  async create(
    @Body() body: CreateItineraryDto,
    @Query('top_k') topK?: string,
  ): Promise<TwoTowerRetrievalResponseDto> {
    const k = topK ? Math.min(parseInt(topK, 10) || 100, 200) : 100;
    return this.recommendationService.retrieveCandidates(body, k);
  }

  @Get(':id')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: '[Mock] Lấy chi tiết lịch trình — sẽ được thành viên khác implement',
  })
  @ApiParam({
    name: 'id',
    description: 'ID của lịch trình',
    example: 'uuid-sg-3days',
  })
  async getItineraryDetail(@Param('id') id: string): Promise<any> {
    return this.service.getItineraryDetail(id);
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

  // ════════════════════════════════════════════════════════════════
  // CÁC ENDPOINT TÙY CHỈNH LỊCH TRÌNH (MỚI)
  // ════════════════════════════════════════════════════════════════

  /**
   * CHỈNH SỬA giờ đến, thời gian tham quan hoặc ghi chú của một hoạt động.
   *
   * - PATCH /:itineraryId/activities/:activityId
   * - Nếu truyền `arriveTime` → tự động ghim giờ (is_locked = true)
   * - Sau khi lưu, gọi FastAPI optimizer → trả về lịch ngày đã sắp xếp lại
   *
   * Response: CustomizeActivityResponseDto
   */
  @Patch(':itineraryId/activities/:activityId')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Chỉnh sửa giờ đến / thời gian / ghi chú của một hoạt động',
    description:
      'Truyền `arriveTime` để ghim giờ. Truyền `isLocked: false` để bỏ ghim. ' +
      'Sau khi lưu, FastAPI tự động sắp xếp lại các hoạt động còn lại trong ngày.',
  })
  @ApiParam({ name: 'itineraryId', description: 'ID lịch trình' })
  @ApiParam({ name: 'activityId', description: 'ID hoạt động (itinerary_details.id)' })
  @ApiBody({ type: EditActivityDto })
  @ApiResponse({ status: 200, type: CustomizeActivityResponseDto })
  async editActivity(
    @Param('itineraryId') itineraryId: string,
    @Param('activityId') activityId: string,
    @Body() dto: EditActivityDto,
  ) {
    return this.service.editActivity(itineraryId, activityId, dto);
  }

  /**
   * THÊM địa điểm mới vào lịch trình.
   *
   * - POST /:itineraryId/activities
   * - Hệ thống tự tìm khe thời gian trống phù hợp trong ngày
   * - Nếu truyền `preferredTime` → ghim giờ ngay
   * - FastAPI tối ưu và trả về toàn bộ ngày đã sắp xếp lại
   *
   * Response: CustomizeActivityResponseDto
   */
  @Post(':itineraryId/activities')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary: 'Thêm địa điểm mới vào lịch trình',
    description:
      'Cung cấp `placeId` và `dayNumber`. ' +
      'Hệ thống tự tính giờ dựa trên khe trống. ' +
      'Tùy chọn: `preferredTime` để ghim giờ ngay khi thêm.',
  })
  @ApiParam({ name: 'itineraryId', description: 'ID lịch trình' })
  @ApiBody({ type: AddActivityDto })
  @ApiResponse({ status: 201, type: CustomizeActivityResponseDto })
  async addActivity(
    @Param('itineraryId') itineraryId: string,
    @Body() dto: AddActivityDto,
  ) {
    return this.service.addActivity(itineraryId, dto);
  }

  /**
   * XÓA một hoạt động khỏi lịch trình.
   *
   * - DELETE /:itineraryId/activities/:activityId
   * - Xóa hoàn toàn khỏi DB (hard delete)
   * - FastAPI tối ưu lại ngày sau khi xóa
   *
   * Response: CustomizeActivityResponseDto
   */
  @Delete(':itineraryId/activities/:activityId')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Xóa một hoạt động khỏi lịch trình',
    description: 'Hard delete. Sau khi xóa, các hoạt động còn lại trong ngày được sắp xếp lại.',
  })
  @ApiParam({ name: 'itineraryId', description: 'ID lịch trình' })
  @ApiParam({ name: 'activityId', description: 'ID hoạt động cần xóa' })
  @ApiResponse({ status: 200, type: CustomizeActivityResponseDto })
  async deleteActivity(
    @Param('itineraryId') itineraryId: string,
    @Param('activityId') activityId: string,
  ) {
    return this.service.deleteActivity(itineraryId, activityId);
  }

  /**
   * THAY THẾ địa điểm bằng địa điểm khác.
   *
   * - PATCH /:itineraryId/activities/:activityId/replace
   * - Giữ nguyên thứ tự và giờ ghim (nếu có)
   * - FastAPI tối ưu lại để tính toán đường đi mới
   *
   * Response: CustomizeActivityResponseDto
   */
  @Patch(':itineraryId/activities/:activityId/replace')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Thay thế địa điểm bằng địa điểm khác',
    description:
      'Giữ nguyên thứ tự và giờ ghim. ' +
      'FastAPI tính lại đường đi với địa điểm mới.',
  })
  @ApiParam({ name: 'itineraryId', description: 'ID lịch trình' })
  @ApiParam({ name: 'activityId', description: 'ID hoạt động cần thay thế' })
  @ApiBody({
    schema: {
      type: 'object',
      required: ['newPlaceId'],
      properties: {
        newPlaceId: {
          type: 'string',
          example: 'place-uuid-789',
          description: 'UUID của địa điểm mới từ travel.places',
        },
      },
    },
  })
  @ApiResponse({ status: 200, type: CustomizeActivityResponseDto })
  async replaceActivity(
    @Param('itineraryId') itineraryId: string,
    @Param('activityId') activityId: string,
    @Body('newPlaceId') newPlaceId: string,
  ) {
    return this.service.replaceActivity(itineraryId, activityId, newPlaceId);
  }

  /**
   * LẤY GỢI Ý địa điểm thay thế cho một hoạt động.
   *
   * - GET /:itineraryId/activities/:activityId/suggestions
   * - Tìm địa điểm cùng danh mục, cùng thành phố, chưa có trong lịch trình
   * - Sắp xếp theo khoảng cách từ địa điểm hiện tại
   *
   * Response: SuggestionsResponseDto
   */
  @Get(':itineraryId/activities/:activityId/suggestions')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Lấy danh sách gợi ý địa điểm thay thế',
    description:
      'Trả về tối đa 8 địa điểm cùng danh mục, cùng thành phố, ' +
      'chưa có trong lịch trình, sắp xếp theo điểm đánh giá.',
  })
  @ApiParam({ name: 'itineraryId', description: 'ID lịch trình' })
  @ApiParam({ name: 'activityId', description: 'ID hoạt động cần tìm gợi ý thay thế' })
  @ApiResponse({ status: 200, type: SuggestionsResponseDto })
  async getSuggestions(
    @Param('itineraryId') itineraryId: string,
    @Param('activityId') activityId: string,
  ) {
    return this.service.getSuggestions(itineraryId, activityId);
  }

  @Patch(':id/activities')
  @ApiOperation({ summary: 'Cập nhật danh sách hoạt động/thời gian của lịch trình' })
  @ApiParam({ name: 'id', description: 'ID của lịch trình' })
  async updateActivities(
    @Param('id') id: string,
    @Body() body: { days: any[] },
  ) {
    await this.service.updateActivities(id, body.days);
    return {
      message: 'Đã cập nhật lịch trình thành công',
      success: true,
    };
  }

  @Post('optimize-day')
  @ApiOperation({ summary: 'Tối ưu hoá các hoạt động trong một ngày bằng AI Service (OR-Tools)' })
  async optimizeDay(@Body() body: { activities: any[] }) {
    if (!body.activities || body.activities.length === 0) {
      return { optimized: [] };
    }
    const optimized = await this.service.optimizeDayRoute(body.activities);
    return { optimized };
  }
}
