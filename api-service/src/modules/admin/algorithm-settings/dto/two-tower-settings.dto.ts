import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export type IntentKey =
  | 'general'
  | 'food'
  | 'urban'
  | 'nature'
  | 'beach'
  | 'culture';

export type SlotKey =
  | 'attraction'
  | 'restaurant'
  | 'cafe'
  | 'entertainment'
  | 'accommodation';

export class ParameterMetaDto {
  @ApiProperty()
  name: string;

  @ApiProperty()
  defaultValue: number;

  @ApiProperty()
  currentValue: number | boolean;

  @ApiProperty()
  minValue: number;

  @ApiProperty()
  maxValue: number;

  @ApiPropertyOptional({ nullable: true })
  description: string | null;
}

export class TwoTowerAlgorithmDto {
  @ApiProperty()
  id: string;

  @ApiProperty({ example: 'two_tower_retrieval' })
  name: 'two_tower_retrieval';

  @ApiPropertyOptional({ nullable: true })
  description: string | null;

  @ApiProperty()
  isActive: boolean;

  @ApiPropertyOptional({ nullable: true })
  updatedAt: string | null;
}

export class TwoTowerCoreSettingsDto {
  @ApiProperty({ type: ParameterMetaDto })
  defaultTopK: ParameterMetaDto;

  @ApiProperty({ type: ParameterMetaDto })
  maxTopK: ParameterMetaDto;

  @ApiProperty({ type: ParameterMetaDto })
  maxIntents: ParameterMetaDto;

  @ApiProperty({ type: ParameterMetaDto })
  fetchBufferMultiplier: ParameterMetaDto;

  @ApiProperty({ type: ParameterMetaDto })
  enableAttractionTravelTypeFilter: ParameterMetaDto;

  @ApiProperty({ type: ParameterMetaDto })
  enableDiversityBudget: ParameterMetaDto;

  @ApiProperty({ type: ParameterMetaDto })
  moderationBatchIntervalMinutes: ParameterMetaDto;
}

export class AlgorithmLogDto {
  @ApiProperty()
  id: string;

  @ApiProperty()
  status: string;

  @ApiProperty()
  action: string;

  @ApiPropertyOptional({ nullable: true })
  details: unknown;

  @ApiProperty()
  createdAt: string;
}

export class TwoTowerSettingsDto {
  @ApiProperty({ type: TwoTowerAlgorithmDto })
  algorithm: TwoTowerAlgorithmDto;

  @ApiProperty({ type: TwoTowerCoreSettingsDto })
  core: TwoTowerCoreSettingsDto;

  @ApiProperty({
    description:
      'Quota settings grouped by intent key and slot key. Values are ParameterMetaDto objects.',
  })
  quotas: Record<IntentKey, Record<SlotKey, ParameterMetaDto>>;
}
