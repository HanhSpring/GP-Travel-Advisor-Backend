import { Controller, Get, Query } from '@nestjs/common';
import {
  ApiOkResponse,
  ApiOperation,
  ApiQuery,
  ApiTags,
} from '@nestjs/swagger';
import { NotificationsService } from './notifications.service';
import { TouristNotificationsResponseDto } from './dto/notification-response.dto';

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
}
