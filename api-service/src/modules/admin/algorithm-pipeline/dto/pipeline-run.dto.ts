import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsBoolean, IsNumber, IsOptional, IsString, Min } from 'class-validator';

export class PipelineRunRequestDto {
  @ApiPropertyOptional({ description: 'Giới hạn số review xử lý (không truyền = tất cả pending)' })
  @IsOptional()
  @IsNumber()
  @Min(1)
  limit?: number;

  @ApiPropertyOptional({ default: false, description: 'Bỏ qua ML models, chỉ dùng rule-based' })
  @IsOptional()
  @IsBoolean()
  no_pretrained?: boolean;

  @ApiPropertyOptional({ default: 0.18, description: 'Ngưỡng E5 để gán topic=other' })
  @IsOptional()
  @IsNumber()
  topic_other_threshold?: number;

  @ApiPropertyOptional({ default: 'all', enum: ['all', 'topk'] })
  @IsOptional()
  @IsString()
  candidate_mode?: string;

  @ApiPropertyOptional({ default: 'representative', enum: ['representative', 'all'] })
  @IsOptional()
  @IsString()
  promotion_mode?: string;

  @ApiPropertyOptional({ default: false, description: 'Xử lý nhưng không ghi về Supabase' })
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
  started_at: string;
  completed_at: string;
  total_reviews: number;
  contents_processed: number;
  conflicts_detected: number;
  long_term_summaries: number;
  duration_seconds: number;
  success: boolean;
  error: string | null;
}

export interface PipelineHistoryResponseDto {
  history: PipelineHistoryItemDto[];
  total: number;
}
