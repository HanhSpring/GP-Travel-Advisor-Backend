import { ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsBoolean,
  IsIn,
  IsNumber,
  IsOptional,
  IsString,
  Max,
  Min,
} from 'class-validator';

export class PipelineRunRequestDto {
  @ApiPropertyOptional({
    description: 'Giới hạn số review xử lý (không truyền = tất cả pending)',
  })
  @IsOptional()
  @IsNumber()
  @Min(1)
  limit?: number;

  @ApiPropertyOptional({
    default: false,
    description: 'Bỏ qua ML models, chỉ dùng rule-based',
  })
  @IsOptional()
  @IsBoolean()
  no_pretrained?: boolean;

  @ApiPropertyOptional({
    default: 0.18,
    description: 'Ngưỡng E5 để gán topic=other',
  })
  @IsOptional()
  @IsNumber()
  topic_other_threshold?: number;

  @ApiPropertyOptional({ default: 'all', enum: ['all', 'topk'] })
  @IsOptional()
  @IsString()
  candidate_mode?: string;

  @ApiPropertyOptional({
    default: 'representative',
    enum: ['representative', 'all'],
  })
  @IsOptional()
  @IsString()
  promotion_mode?: string;

  @ApiPropertyOptional({
    default: false,
    description: 'Xử lý nhưng không ghi về Supabase',
  })
  @IsOptional()
  @IsBoolean()
  dry_run?: boolean;
}

export interface PipelineRunResponseDto {
  success: boolean;
  run_id: string;
  total_reviews: number;
  contents_processed: number;
  conflicts_detected: number;
  long_term_summaries: number;
  hidden_reviews: number;
  output_dir: string;
  started_at: string;
  completed_at: string;
  duration_seconds: number;
  embedding_model_active: boolean;
  sentiment_model_active: boolean;
  zeroshot_model_active: boolean;
  phobert_model_active: boolean;
  error: string | null;
}

export interface PipelineHistoryItemDto {
  run_id: string;
  algorithm_id?: string | null;
  algorithm_name?: string;
  status?: string;
  action?: string;
  details?: Record<string, any> | null;
  started_at: string;
  completed_at: string;
  total_reviews: number;
  contents_processed: number;
  conflicts_detected: number;
  long_term_summaries: number;
  duration_seconds: number;
  success: boolean;
  error: string | null;
  created_at?: string;
}

export interface PipelineHistoryResponseDto {
  history: PipelineHistoryItemDto[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
}

export interface PipelineHistoryQueryDto {
  page?: number;
  pageSize?: number;
  limit?: number;
  algorithm?: string;
  date?: string;
}

export type ReviewFilterScheduleFrequency = 'daily' | 'weekly' | 'monthly';

export class ReviewFilterScheduleDto {
  @ApiPropertyOptional()
  autoEnabled: boolean;

  @ApiPropertyOptional({ enum: ['daily', 'weekly', 'monthly'] })
  frequency: ReviewFilterScheduleFrequency;

  @ApiPropertyOptional({ example: '02:00' })
  runTime: string;

  @ApiPropertyOptional({ example: '1' })
  runDay: string;

  @ApiPropertyOptional({ nullable: true })
  lastRunAt: string | null;
}

export class UpdateReviewFilterScheduleDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  autoEnabled?: boolean;

  @ApiPropertyOptional({ enum: ['daily', 'weekly', 'monthly'] })
  @IsOptional()
  @IsIn(['daily', 'weekly', 'monthly'])
  frequency?: ReviewFilterScheduleFrequency;

  @ApiPropertyOptional({ example: '02:00' })
  @IsOptional()
  @IsString()
  runTime?: string;

  @ApiPropertyOptional({ minimum: 0, maximum: 31 })
  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(31)
  runDay?: number;
}
