import { ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsBoolean,
  IsIn,
  IsNumber,
  IsObject,
  IsOptional,
  IsString,
  Max,
  Min,
} from 'class-validator';

export class PrepareDatasetRequestDto {
  @ApiPropertyOptional({
    default: false,
    description:
      'Bỏ qua change-detection (so mv_training_interactions với lần export "ready" gần nhất) và ' +
      'luôn export lại — dùng khi chắc chắn muốn 1 dataset mới dù không phát hiện thay đổi.',
  })
  @IsOptional()
  @IsBoolean()
  force?: boolean;
}

export class RunFullTrainingRequestDto {
  @ApiPropertyOptional({
    description:
      'id ai_config.training_datasets muốn dùng — mặc định: bản "ready" mới nhất của thuật toán',
  })
  @IsOptional()
  @IsString()
  trainingDatasetId?: string;

  @ApiPropertyOptional({
    default: false,
    description: 'Chạy nhanh/rẻ để test luồng end-to-end, KHÔNG dùng cho báo cáo',
  })
  @IsOptional()
  @IsBoolean()
  isDemoMode?: boolean;

  @ApiPropertyOptional({
    default: false,
    description:
      'Có nạp thêm dữ liệu Yelp (pretrain corpus gốc) hay không — mặc định false vì Yelp không ' +
      'được upload lên R2 (chỉ lưu Drive), chỉ bật true nếu thực sự muốn pretrain lại từ đầu qua Modal',
  })
  @IsOptional()
  @IsBoolean()
  includeYelp?: boolean;
}

export interface PrepareDatasetResponseDto {
  // null khi skipped=true -- khong co training_runs/training_datasets moi nao duoc tao,
  // trainingDatasetId/r2Prefix/rowCounts... la cua ban "ready" gan nhat duoc tai su dung.
  trainingRunId: string | null;
  trainingDatasetId: string;
  r2Prefix: string;
  rowCounts: Record<string, number>;
  dateRangeStart: string | null;
  dateRangeEnd: string | null;
  skipped?: boolean;
  skipReason?: string;
}

export interface RunFullTrainingResponseDto {
  trainingRunId: string;
  status: string;
  modalCallId: string | null;
}

export interface TrainingRunDto {
  id: string;
  runType: 'data_export' | 'training' | 'promotion';
  status: 'pending' | 'running' | 'completed' | 'failed' | 'cancelled';
  triggerType: 'manual' | 'schedule';
  startedAt: string | null;
  completedAt: string | null;
  durationSeconds: number | null;
  errorMessage: string | null;
  metrics: Record<string, unknown> | null;
  createdAt: string;
}

export interface ModelVersionDto {
  id: string;
  versionTag: string;
  status: 'candidate' | 'active' | 'archived' | 'failed';
  metrics: Record<string, number> | null;
  trainedAt: string | null;
  promotedAt: string | null;
  createdAt: string;
}

export class TrainingCallbackDto {
  @IsString()
  run_id: string;

  @IsString()
  algorithm: string;

  @IsIn(['completed', 'failed'])
  status: 'completed' | 'failed';

  @IsOptional()
  @IsString()
  weights_r2_key?: string;

  @IsOptional()
  @IsString()
  vocab_r2_key?: string;

  @IsOptional()
  @IsObject()
  metrics?: Record<string, number>;

  @IsOptional()
  @IsNumber()
  epochs_run?: number;

  @IsOptional()
  @IsBoolean()
  is_finetune?: boolean;

  @IsOptional()
  @IsString()
  error_message?: string;
}

export type AlgorithmTrainingScheduleFrequency = 'daily' | 'weekly' | 'monthly';

export class AlgorithmTrainingScheduleDto {
  @ApiPropertyOptional()
  autoEnabled: boolean;

  @ApiPropertyOptional({ enum: ['daily', 'weekly', 'monthly'] })
  frequency: AlgorithmTrainingScheduleFrequency;

  @ApiPropertyOptional({ example: '02:00' })
  runTime: string;

  @ApiPropertyOptional({ example: '1' })
  runDay: string;

  @ApiPropertyOptional({ nullable: true })
  lastRunAt: string | null;
}

export class UpdateAlgorithmTrainingScheduleDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  autoEnabled?: boolean;

  @ApiPropertyOptional({ enum: ['daily', 'weekly', 'monthly'] })
  @IsOptional()
  @IsIn(['daily', 'weekly', 'monthly'])
  frequency?: AlgorithmTrainingScheduleFrequency;

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
