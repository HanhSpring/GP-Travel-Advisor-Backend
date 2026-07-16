import { Controller, Get, Patch, Delete, Param, UseGuards, Query, Req } from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation } from '@nestjs/swagger';
import { JwtAuthGuard } from '../../auth/jwt-auth.guard';
import { CommonNotificationsService } from './notifications.service';

@ApiTags('Notifications')
@ApiBearerAuth('access-token')
@Controller('notifications/me')
@UseGuards(JwtAuthGuard)
export class CommonNotificationsController {
  constructor(private readonly notificationsService: CommonNotificationsService) {}

  @Get()
  @ApiOperation({ summary: 'Lấy danh sách thông báo của user hiện tại' })
  async getMyNotifications(
    @Req() req: any,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
  ) {
    const userId = req.user?.userId || req.user?.id || req.user?.sub;
    const pageNum = parseInt(page || '1', 10);
    const limitNum = parseInt(limit || '20', 10);
    return this.notificationsService.getUserNotifications(userId, pageNum, limitNum);
  }

  @Patch(':id/read')
  @ApiOperation({ summary: 'Đánh dấu thông báo đã đọc' })
  async markAsRead(
    @Req() req: any,
    @Param('id') notificationId: string,
  ) {
    const userId = req.user?.userId || req.user?.id || req.user?.sub;
    return this.notificationsService.markAsRead(userId, notificationId);
  }

  @Delete(':id')
  @ApiOperation({ summary: 'Xóa một thông báo' })
  async deleteOne(
    @Req() req: any,
    @Param('id') notificationId: string,
  ) {
    const userId = req.user?.userId || req.user?.id || req.user?.sub;
    return this.notificationsService.deleteNotification(userId, notificationId);
  }
}
