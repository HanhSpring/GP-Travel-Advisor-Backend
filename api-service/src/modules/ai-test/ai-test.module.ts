import { Module } from '@nestjs/common';
import { HttpModule } from '@nestjs/axios';
import { AiTestController } from './ai-test.controller';
import { AiTestService } from './ai-test.service';

@Module({
  imports: [HttpModule],
  controllers: [AiTestController],
  providers: [AiTestService],
})
export class AiTestModule {}
