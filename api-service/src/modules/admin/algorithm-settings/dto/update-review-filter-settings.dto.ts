import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsObject, IsOptional } from 'class-validator';

export class UpdateReviewFilterSettingsDto {
  @ApiPropertyOptional({
    description:
      'Changed parameter values keyed by ai_config.algorithm_parameters.parameter_name.',
  })
  @IsOptional()
  @IsObject()
  parameters?: Record<string, number>;
}
