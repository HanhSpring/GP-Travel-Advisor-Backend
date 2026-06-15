import {
  Body,
  Controller,
  Get,
  Post,
  Query,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { AdminAlgorithmPipelineService } from './admin-algorithm-pipeline.service';
import { PipelineRunRequestDto } from './dto/pipeline-run.dto';

@ApiTags('Admin - Algorithm Pipeline')
@Controller('admin/algorithm-pipeline')
export class AdminAlgorithmPipelineController {
  constructor(private readonly service: AdminAlgorithmPipelineService) {}

  @Post('run')
  @ApiOperation({ summary: 'Kích hoạt pipeline phân loại review (3 thuật toán)' })
  async runPipeline(@Body() dto: PipelineRunRequestDto) {
    return this.service.runPipeline(dto);
  }

  @Get('history')
  @ApiOperation({ summary: 'Lấy lịch sử các lần chạy pipeline' })
  async getPipelineHistory(@Query('limit') limit?: string) {
    const limitNum = limit ? parseInt(limit, 10) : 20;
    return this.service.getPipelineHistory(limitNum);
  }
}
