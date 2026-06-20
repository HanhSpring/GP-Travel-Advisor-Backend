import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsOptional, IsUUID } from 'class-validator';

export const FRONTEND_ACTIONS = [
  'click',
  'view',
  'save',
  'unsave',
  'search',
  'visited',
  'review',
  'rating',
] as const;

export type FrontendActionType = (typeof FRONTEND_ACTIONS)[number];

export class TrackActivityDto {
  @ApiPropertyOptional({
    description:
      'Deprecated: tourist ID is derived from the bearer token and this value is ignored',
    deprecated: true,
  })
  @IsOptional()
  @IsUUID()
  tourist_id?: string;

  @ApiProperty({
    enum: FRONTEND_ACTIONS,
    description: 'Loại hành động người dùng thực hiện',
  })
  @IsIn(FRONTEND_ACTIONS)
  action_type!: FrontendActionType;

  @ApiPropertyOptional({ description: 'ID địa điểm liên quan (nếu có)' })
  @IsOptional()
  @IsUUID()
  place_id?: string;
}
