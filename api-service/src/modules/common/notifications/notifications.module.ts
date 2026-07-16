import { Module, Global } from '@nestjs/common';
import { NotificationsGateway } from './notifications.gateway';
import { CommonNotificationsService } from './notifications.service';
import { CommonNotificationsController } from './notifications.controller';

@Global()
@Module({
  controllers: [CommonNotificationsController],
  providers: [NotificationsGateway, CommonNotificationsService],
  exports: [NotificationsGateway, CommonNotificationsService],
})
export class CommonNotificationsModule {}
