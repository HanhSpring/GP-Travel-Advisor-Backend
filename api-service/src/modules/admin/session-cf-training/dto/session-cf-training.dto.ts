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

export class SessionCfTrainingRunRequestDto {
  @ApiPropertyOptional({
    default: 90,
    description: 'Số ngày activity_logs lấy về',
  })
  @IsOptional()
  @IsNumber()
  @Min(1)
  lookback_days?: number;

  @ApiPropertyOptional({
    default: true,
    description: 'Tự upload artifact lên R2 ngay sau khi train xong',
  })
  @IsOptional()
  @IsBoolean()
  upload_r2?: boolean;

  @ApiPropertyOptional({
    default: false,
    description: 'Chỉ train + eval, không ghi artifact/upload R2',
  })
  @IsOptional()
  @IsBoolean()
  dry_run?: boolean;
}

export interface SessionCfTrainingRunResponseDto {
  success: boolean;
  run_id: string;
  n_users: number;
  n_items: number;
  n_interactions: number;
  n_explicit: number;
  n_implicit: number;
  overlap_places: number;
  model_type: string;
  global_mean: number;
  n_train: number;
  n_test: number;
  metrics: Record<string, number>;
  artifact_dir: string;
  exported: boolean;
  uploaded_r2: boolean;
  n_artifact_users: number | null;
  n_artifact_items: number | null;
  started_at: string;
  completed_at: string;
  duration_seconds: number;
  error: string | null;
}

export type SessionCfTrainingScheduleFrequency = 'daily' | 'weekly' | 'monthly';

export class SessionCfTrainingScheduleDto {
  @ApiPropertyOptional()
  autoEnabled: boolean;

  @ApiPropertyOptional({ enum: ['daily', 'weekly', 'monthly'] })
  frequency: SessionCfTrainingScheduleFrequency;

  @ApiPropertyOptional({ example: '02:00' })
  runTime: string;

  @ApiPropertyOptional({ example: '1' })
  runDay: string;

  @ApiPropertyOptional({ nullable: true })
  lastRunAt: string | null;
}

export class UpdateSessionCfTrainingScheduleDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  autoEnabled?: boolean;

  @ApiPropertyOptional({ enum: ['daily', 'weekly', 'monthly'] })
  @IsOptional()
  @IsIn(['daily', 'weekly', 'monthly'])
  frequency?: SessionCfTrainingScheduleFrequency;

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
