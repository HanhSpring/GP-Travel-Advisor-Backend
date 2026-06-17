import { AppConfig } from '../../../config/app.config';
import {
  Injectable,
  InternalServerErrorException,
  Logger,
} from '@nestjs/common';
import { HttpService } from '@nestjs/axios';
import { firstValueFrom } from 'rxjs';
import {
  PipelineHistoryResponseDto,
  PipelineRunRequestDto,
  PipelineRunResponseDto,
} from './dto/pipeline-run.dto';

@Injectable()
export class AdminAlgorithmPipelineService {
  private readonly logger = new Logger(AdminAlgorithmPipelineService.name);
  private readonly aiServiceUrl: string;

  constructor(private readonly httpService: HttpService) {
    this.aiServiceUrl = AppConfig.AI_SERVICE_URL;
  }

  async runPipeline(dto: PipelineRunRequestDto): Promise<PipelineRunResponseDto> {
    this.logger.log('Kích hoạt pipeline phân loại review...');
    try {
      const response = await firstValueFrom(
        this.httpService.post<PipelineRunResponseDto>(
          `${this.aiServiceUrl}/api/v1/review-pipeline/run`,
          dto,
          { timeout: 600_000 },
        ),
      );
      return response.data;
    } catch (error) {
      this.logger.error(`Pipeline run failed: ${error.message}`);
      if (error.response?.data) {
        throw new InternalServerErrorException(
          error.response.data.detail || 'Pipeline thất bại',
        );
      }
      throw new InternalServerErrorException(
        'Không thể kết nối đến AI service. Hãy kiểm tra ai-service đang chạy.',
      );
    }
  }

  async getPipelineHistory(limit = 20): Promise<PipelineHistoryResponseDto> {
    try {
      const response = await firstValueFrom(
        this.httpService.get<PipelineHistoryResponseDto>(
          `${this.aiServiceUrl}/api/v1/review-pipeline/history`,
          { params: { limit } },
        ),
      );
      return response.data;
    } catch (error) {
      this.logger.warn(`Không lấy được lịch sử pipeline: ${error.message}`);
      return { history: [], total: 0 };
    }
  }
}
