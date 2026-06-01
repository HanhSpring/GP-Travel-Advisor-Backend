import { Module } from '@nestjs/common';
import { HttpModule } from '@nestjs/axios';
import { AiTestController } from './ai-test.controller';
import { AiTestService } from './ai-test.service';

@Module({
  imports: [HttpModule], // Yêu cầu HttpModule để AiTestService gọi được API
  controllers: [AiTestController],
  providers: [AiTestService],
})
export class AiTestModule {}
