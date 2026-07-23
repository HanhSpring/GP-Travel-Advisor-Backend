import { Body, Controller, Get, Patch, Post, Request, UseGuards } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { SessionCfTrainingService } from './session-cf-training.service';
import {
  SessionCfTrainingRunRequestDto,
  UpdateSessionCfTrainingScheduleDto,
} from './dto/session-cf-training.dto';
import { JwtAuthGuard } from '../../auth/jwt-auth.guard';
import { RolesGuard } from '../../../common/guards/roles.guard';
import { Roles } from '../../../common/decorators/roles.decorator';
import { Role } from '../../../common/enum/role.enum';

@ApiTags('Admin - Session CF Training')
@Controller('admin/session-cf-training')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(Role.ADMIN)
export class SessionCfTrainingController {
  constructor(private readonly service: SessionCfTrainingService) {}

  @Post('run')
  @ApiOperation({
    summary: 'Train lại Session-Aware CF Reranker (Funk-SVD) từ dữ liệu Supabase thật',
  })
  async run(@Body() dto: SessionCfTrainingRunRequestDto, @Request() req: any) {
    return this.service.runTraining(dto, req.user?.userId ?? null);
  }

  @Get('schedule')
  @ApiOperation({ summary: 'Lấy cấu hình lịch chạy tự động train Session-CF' })
  async getSchedule() {
    return this.service.getSchedule();
  }

  @Patch('schedule')
  @ApiOperation({ summary: 'Cập nhật lịch chạy tự động train Session-CF' })
  async updateSchedule(@Body() dto: UpdateSessionCfTrainingScheduleDto, @Request() req: any) {
    return this.service.updateSchedule(dto, req.user?.userId ?? null);
  }
}
