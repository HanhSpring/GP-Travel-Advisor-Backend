import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Post,
  Query,
} from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { ItineraryTrackingService } from './itinerary-tracking.service';
import { StartTrackingDto } from './dto/start-tracking.dto';
import { GeofenceEventDto } from './dto/geofence-event.dto';
import { CheckInDto } from './dto/check-in.dto';
import { EndDayDto } from './dto/end-day.dto';
import {
  GeofencesQueryDto,
  TrackingStatusQueryDto,
} from './dto/tracking-query.dto';
import {
  EndDayResponseDto,
  StartTrackingResponseDto,
  TrackingEventResponseDto,
  TrackingStatusResponseDto,
} from './dto/tracking-response.dto';

@ApiTags('Itinerary Tracking')
@Controller('itinerary/tracking')
export class ItineraryTrackingController {
  constructor(private readonly service: ItineraryTrackingService) {}

  @Post('start')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Bắt đầu theo dõi — đăng ký geofence cho các địa điểm của ngày',
    description:
      'Đặt lịch trình sang "ongoing", tạo geofence (gắn place_id) + bản ghi ghé ' +
      'cho mỗi địa điểm trong ngày và trả về danh sách geofence (toạ độ, bán kính, ' +
      'ngưỡng dwell, itineraryDetailId) để mobile đăng ký với Google Play Services. ' +
      'Idempotent: gọi lại không làm mất tiến độ.',
  })
  @ApiOkResponse({ type: StartTrackingResponseDto })
  start(@Body() dto: StartTrackingDto) {
    return this.service.start(dto);
  }

  @Get('geofences')
  @ApiOperation({
    summary:
      'Lấy danh sách geofence của một ngày (cho AlarmManager đăng ký lại)',
    description:
      'Trả về geofence của ngày. Nếu đã /start sẽ kèm geofenceId + trạng thái; ' +
      'nếu chưa, dựng tạm từ lịch trình với geofenceId rỗng.',
  })
  @ApiOkResponse({ type: StartTrackingResponseDto })
  getGeofences(@Query() query: GeofencesQueryDto) {
    return this.service.getGeofences(query);
  }

  @Get('active')
  @ApiOperation({
    summary:
      'Khôi phục tracking active cho user — tạo geofence ngày hiện tại khi đăng nhập lại',
  })
  @ApiOkResponse({ type: StartTrackingResponseDto })
  getActiveTracking(
    @Query('touristId') touristId: string,
    @Query('radiusM') radiusM?: string,
  ) {
    return this.service.startActiveForTourist(
      touristId,
      radiusM ? Number(radiusM) : undefined,
    );
  }

  @Post('event')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Nhận sự kiện geofence (ENTER / DWELL / EXIT)',
    description:
      'ENTER: ghi nhận thời điểm vào, bắt đầu tính dwell. DWELL/EXIT: tính dwell ' +
      'time; nếu ≥ ngưỡng → đánh dấu "Đã ghé", tạo thông báo push và đồng bộ DB. ' +
      'Nếu chưa đủ → giữ "Chưa ghé".',
  })
  @ApiOkResponse({ type: TrackingEventResponseDto })
  handleEvent(@Body() dto: GeofenceEventDto) {
    return this.service.handleEvent(dto);
  }

  @Post('check-in')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Check-in thủ công — đánh dấu "Đã ghé" (bỏ qua điều kiện dwell)',
  })
  @ApiOkResponse({ type: TrackingEventResponseDto })
  checkIn(@Body() dto: CheckInDto) {
    return this.service.checkIn(dto);
  }

  @Get('status')
  @ApiOperation({
    summary: 'Trạng thái theo dõi của một ngày + marker bản đồ',
    description:
      'Trả về trạng thái từng địa điểm (Đã ghé / Chưa ghé / Bỏ qua), màu + icon ' +
      'marker và thống kê tiến độ — dùng để cập nhật bản đồ.',
  })
  @ApiOkResponse({ type: TrackingStatusResponseDto })
  getStatus(@Query() query: TrackingStatusQueryDto) {
    return this.service.getStatus(query);
  }

  @Post('end-day')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Kết thúc ngày — gỡ geofence, đánh dấu "Bỏ qua", đặt lịch ngày kế',
    description:
      'Đánh dấu các địa điểm còn "Chưa ghé" thành "Bỏ qua" (tuỳ chọn), trả về ' +
      'danh sách geofenceId/itineraryDetailId cần gỡ trên thiết bị và thời điểm ' +
      'đăng ký lại cho ngày kế (AlarmManager). Nếu là ngày cuối, lịch trình ' +
      'chuyển "completed".',
  })
  @ApiOkResponse({ type: EndDayResponseDto })
  endDay(@Body() dto: EndDayDto) {
    return this.service.endDay(dto);
  }
}
