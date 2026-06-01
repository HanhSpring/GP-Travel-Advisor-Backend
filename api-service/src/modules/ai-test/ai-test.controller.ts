import { Controller, Get } from '@nestjs/common';
import { AiTestService } from './ai-test.service';

@Controller('test-ai')
export class AiTestController {
  constructor(private readonly aiTestService: AiTestService) {}

  @Get()
  async testAiConnection() {
    return await this.aiTestService.testConnection();
  }
}
