import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { ParameterMetaDto } from './two-tower-settings.dto';

export type ReviewFilterTopicKey =
  | 'traffic'
  | 'weather'
  | 'crowd'
  | 'service'
  | 'price'
  | 'infra'
  | 'cleanliness'
  | 'food'
  | 'atmosphere'
  | 'activity'
  | 'other';

export class ReviewFilterAlgorithmDto {
  @ApiProperty()
  id: string;

  @ApiProperty({ example: 'review_filter' })
  name: 'review_filter';

  @ApiPropertyOptional({ nullable: true })
  description: string | null;

  @ApiProperty()
  isActive: boolean;

  @ApiPropertyOptional({ nullable: true })
  updatedAt: string | null;
}

export class ReviewFilterSettingsDto {
  @ApiProperty({ type: ReviewFilterAlgorithmDto })
  algorithm: ReviewFilterAlgorithmDto;

  @ApiProperty({ description: 'Ordered review filter topics.' })
  topics: Array<{ key: ReviewFilterTopicKey; label: string }>;

  @ApiProperty({ description: 'Parameter metadata keyed by parameter_name.' })
  parameters: Record<string, ParameterMetaDto>;
}
