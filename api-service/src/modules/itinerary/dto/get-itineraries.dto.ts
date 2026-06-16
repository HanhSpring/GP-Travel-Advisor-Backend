import { IsOptional, IsString, IsUUID, MaxLength } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class GetItinerariesDto {
  @ApiProperty({
    example: 'b3c8f5c1-1234-4c9a-9abc-123456789abc',
  })
  @IsUUID()
  userId: string;

  @ApiPropertyOptional({
    example: 'Da Nang',
    description:
      'Search keyword for itinerary names. The current DB contract stores the trip name in `description`, so the service forwards this as RPC `p_query`.',
    maxLength: 255,
  })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  q?: string;
}
