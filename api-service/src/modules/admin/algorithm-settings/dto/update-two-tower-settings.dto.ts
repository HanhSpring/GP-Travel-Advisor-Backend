import { ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsBoolean,
  IsNumber,
  IsObject,
  IsOptional,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import { IntentKey, SlotKey } from './two-tower-settings.dto';

class QuotaSlotValuesDto implements Partial<Record<SlotKey, number>> {
  @ApiPropertyOptional()
  @IsOptional()
  @IsNumber()
  attraction?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsNumber()
  restaurant?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsNumber()
  cafe?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsNumber()
  entertainment?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsNumber()
  accommodation?: number;
}

class QuotaValuesDto implements Partial<Record<IntentKey, QuotaSlotValuesDto>> {
  @ApiPropertyOptional({ type: QuotaSlotValuesDto })
  @IsOptional()
  @ValidateNested()
  @Type(() => QuotaSlotValuesDto)
  general?: QuotaSlotValuesDto;

  @ApiPropertyOptional({ type: QuotaSlotValuesDto })
  @IsOptional()
  @ValidateNested()
  @Type(() => QuotaSlotValuesDto)
  food?: QuotaSlotValuesDto;

  @ApiPropertyOptional({ type: QuotaSlotValuesDto })
  @IsOptional()
  @ValidateNested()
  @Type(() => QuotaSlotValuesDto)
  urban?: QuotaSlotValuesDto;

  @ApiPropertyOptional({ type: QuotaSlotValuesDto })
  @IsOptional()
  @ValidateNested()
  @Type(() => QuotaSlotValuesDto)
  nature?: QuotaSlotValuesDto;

  @ApiPropertyOptional({ type: QuotaSlotValuesDto })
  @IsOptional()
  @ValidateNested()
  @Type(() => QuotaSlotValuesDto)
  beach?: QuotaSlotValuesDto;

  @ApiPropertyOptional({ type: QuotaSlotValuesDto })
  @IsOptional()
  @ValidateNested()
  @Type(() => QuotaSlotValuesDto)
  culture?: QuotaSlotValuesDto;
}

export class UpdateTwoTowerSettingsDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsNumber()
  defaultTopK?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsNumber()
  maxTopK?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsNumber()
  maxIntents?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsNumber()
  fetchBufferMultiplier?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  enableAttractionTravelTypeFilter?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  enableDiversityBudget?: boolean;

  @ApiPropertyOptional({ type: QuotaValuesDto })
  @IsOptional()
  @IsObject()
  @ValidateNested()
  @Type(() => QuotaValuesDto)
  quotas?: QuotaValuesDto;
}
