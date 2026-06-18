import { Controller, Get, Param, Patch, Query } from '@nestjs/common';
import {
  ApiOkResponse,
  ApiOperation,
  ApiQuery,
  ApiTags,
} from '@nestjs/swagger';
import { NotificationsService } from './notifications.service';
import {
  TouristNotificationDetailDto,
  TouristNotificationsResponseDto,
} from './dto/notification-response.dto';

@ApiTags('Tourist Notifications')
@Controller('notifications')
export class NotificationsController {
  constructor(private readonly service: NotificationsService) {}

  @Get()
  @ApiOperation({
    summary: 'Get all notifications sent to a tourist user',
  })
  @ApiQuery({ name: 'tourist_id', required: true, type: String })
  @ApiOkResponse({ type: TouristNotificationsResponseDto })
  getNotifications(
    @Query('tourist_id') touristId: string,
  ): Promise<TouristNotificationsResponseDto> {
    return this.service.getNotifications(touristId);
  }

  @Patch('read-all')
  @ApiOperation({
    summary: 'Mark all notifications as read for a tourist user',
  })
  @ApiQuery({ name: 'tourist_id', required: true, type: String })
  markAllAsRead(@Query('tourist_id') touristId: string) {
    return this.service.markAllAsRead(touristId);
  }

  @Patch(':id/read')
  @ApiOperation({
    summary: 'Mark one notification as read for a tourist user',
  })
  @ApiQuery({ name: 'tourist_id', required: true, type: String })
  @ApiOkResponse({ type: TouristNotificationDetailDto })
  markAsRead(
    @Param('id') notificationId: string,
    @Query('tourist_id') touristId: string,
  ): Promise<TouristNotificationDetailDto> {
    return this.service.markAsRead(touristId, notificationId);
  }

  @Get(':id')
  @ApiOperation({
    summary: 'Get notification detail for a tourist user',
  })
  @ApiQuery({ name: 'tourist_id', required: true, type: String })
  @ApiOkResponse({ type: TouristNotificationDetailDto })
  getNotificationDetail(
    @Param('id') notificationId: string,
    @Query('tourist_id') touristId: string,
  ): Promise<TouristNotificationDetailDto> {
    return this.service.getNotificationDetail(touristId, notificationId);
  }
}
