import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import {
  ApiBody,
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

  @Post('fcm-token')
  @ApiOperation({ summary: 'Register or update FCM push token for a user' })
  @ApiBody({
    schema: {
      type: 'object',
      properties: {
        tourist_id: { type: 'string' },
        fcm_token: { type: 'string' },
      },
      required: ['tourist_id', 'fcm_token'],
    },
  })
  registerFcmToken(@Body() body: { tourist_id: string; fcm_token: string }) {
    return this.service.registerFcmToken(body.tourist_id, body.fcm_token);
  }

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
