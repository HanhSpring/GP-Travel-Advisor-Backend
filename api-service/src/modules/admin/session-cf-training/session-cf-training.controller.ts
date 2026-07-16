import { Body, Controller, Get, Patch, Post } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { SessionCfTrainingService } from './session-cf-training.service';
import {
  SessionCfTrainingRunRequestDto,
  UpdateSessionCfTrainingScheduleDto,
} from './dto/session-cf-training.dto';

@ApiTags('Admin - Session CF Training')
@Controller('admin/session-cf-training')
export class SessionCfTrainingController {
  constructor(private readonly service: SessionCfTrainingService) {}

  @Post('run')
  @ApiOperation({
    summary: 'Train lại Session-Aware CF Reranker (Funk-SVD) từ dữ liệu Supabase thật',
  })
  async run(@Body() dto: SessionCfTrainingRunRequestDto) {
    return this.service.runTraining(dto);
  }

  @Get('schedule')
  @ApiOperation({ summary: 'Lấy cấu hình lịch chạy tự động train Session-CF' })
  async getSchedule() {
    return this.service.getSchedule();
  }

  @Patch('schedule')
  @ApiOperation({ summary: 'Cập nhật lịch chạy tự động train Session-CF' })
  async updateSchedule(@Body() dto: UpdateSessionCfTrainingScheduleDto) {
    return this.service.updateSchedule(dto);
  }
}
