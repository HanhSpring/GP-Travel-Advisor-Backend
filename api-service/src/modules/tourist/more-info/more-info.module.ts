import { Module } from '@nestjs/common';
import { MoreInfoController } from './more-info.controller';
import { MoreInfoService } from './more-info.service';

@Module({
  controllers: [MoreInfoController],
  providers: [MoreInfoService],
})
export class MoreInfoModule {}
