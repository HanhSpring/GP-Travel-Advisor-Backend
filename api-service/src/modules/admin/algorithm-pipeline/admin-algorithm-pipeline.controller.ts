import { Body, Controller, Get, Param, Patch, Post, Query, Request, UseGuards } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { AdminAlgorithmPipelineService } from './admin-algorithm-pipeline.service';
import {
  PipelineHistoryQueryDto,
  PipelineRunRequestDto,
  UpdateReviewFilterScheduleDto,
} from './dto/pipeline-run.dto';
import { JwtAuthGuard } from '../../auth/jwt-auth.guard';
import { RolesGuard } from '../../../common/guards/roles.guard';
import { Roles } from '../../../common/decorators/roles.decorator';
import { Role } from '../../../common/enum/role.enum';

@ApiTags('Admin - Algorithm Pipeline')
@Controller('admin/algorithm-pipeline')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(Role.ADMIN)
export class AdminAlgorithmPipelineController {
  constructor(private readonly service: AdminAlgorithmPipelineService) {}

  @Post('run')
  @ApiOperation({
    summary: 'Kích hoạt pipeline phân loại review (3 thuật toán)',
  })
  async runPipeline(@Body() dto: PipelineRunRequestDto) {
    return this.service.runPipeline(dto);
  }

  @Get('history')
  @ApiOperation({ summary: 'Lấy lịch sử các lần chạy pipeline' })
  async getPipelineHistory(
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
    @Query('limit') limit?: string,
    @Query('algorithm') algorithm?: string,
    @Query('date') date?: string,
  ) {
    const parseOptionalNumber = (value?: string) => {
      if (!value) {
        return undefined;
      }
      const parsed = parseInt(value, 10);
      return Number.isFinite(parsed) ? parsed : undefined;
    };
    const query: PipelineHistoryQueryDto = {
      page: parseOptionalNumber(page),
      pageSize: parseOptionalNumber(pageSize),
      limit: parseOptionalNumber(limit),
      algorithm,
      date,
    };
    return this.service.getPipelineHistory(query);
  }

  @Get('review-filter/schedule')
  @ApiOperation({
    summary: 'Lấy cấu hình lịch chạy tự động thuật toán lọc đánh giá',
  })
  async getReviewFilterSchedule() {
    return this.service.getReviewFilterSchedule();
  }

  @Patch('review-filter/schedule')
  @ApiOperation({
    summary: 'Cập nhật lịch chạy tự động thuật toán lọc đánh giá',
  })
  async updateReviewFilterSchedule(@Body() dto: UpdateReviewFilterScheduleDto) {
    return this.service.updateReviewFilterSchedule(dto);
  }

  @Post('recommender-retrain/run')
  @ApiOperation({ summary: 'Tạo local recommender retrain job bất đồng bộ' })
  async runRecommenderRetrain(@Request() req: any) {
    return this.service.startRecommenderRetrain(req.user?.userId ?? null, 'manual');
  }

  @Get('recommender-retrain/status')
  @ApiOperation({ summary: 'Trạng thái và quota retrain recommender' })
  async getRecommenderRetrainStatus() {
    return this.service.getRecommenderRetrainStatus();
  }

  @Get('recommender-retrain/runs/:id')
  @ApiOperation({ summary: 'Chi tiết một retrain run' })
  async getRecommenderRetrainRun(@Param('id') id: string) {
    return this.service.getRecommenderRetrainRun(id);
  }

  @Get('recommender-retrain/schedule')
  async getRecommenderRetrainSchedule() {
    return this.service.getRecommenderRetrainSchedule();
  }

  @Patch('recommender-retrain/schedule')
  async updateRecommenderRetrainSchedule(@Body() dto: UpdateReviewFilterScheduleDto) {
    return this.service.updateRecommenderRetrainSchedule(dto);
  }
}
