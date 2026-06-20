/* eslint-disable @typescript-eslint/no-unsafe-call */
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsUUID,
  IsNumber,
  IsString,
  IsOptional,
  IsArray,
  Min,
  Max,
} from 'class-validator';

export class CreateReviewDto {
  @ApiPropertyOptional({
    example: '2c2caf9e-1fc9-4065-a280-45d8508458c7',
    description:
      'Deprecated: tourist ID is derived from the bearer token and this value is ignored',
    deprecated: true,
  })
  @IsOptional()
  @IsUUID('4')
  tourist_id?: string;

  @ApiProperty({
    example: '16579947-051d-47ec-856c-a8f5159ab7ba',
    description: 'UUID of the place being reviewed',
  })
  @IsUUID('4')
  place_id: string;

  @ApiProperty({
    example: '0f3d38ec-ef35-4f83-9e3a-d0cf6b1f3d1d',
    description: 'UUID of the itinerary being reviewed',
    required: false,
    nullable: true,
  })
  @IsOptional()
  @IsUUID('4')
  itinerary_id?: string | null;

  @ApiProperty({
    example: 5,
    description: 'Rating between 1 and 5 stars',
  })
  @IsNumber()
  @Min(1)
  @Max(5)
  rating: number;

  @ApiProperty({
    example: 'Great place! Clean and beautiful views.',
    description: 'Written review content (optional)',
    required: false,
  })
  @IsOptional()
  @IsString()
  content?: string | null;

  @ApiProperty({
    example: ['Sạch sẽ', 'Check-in đẹp', 'Phí hợp lý'],
    description: 'Tags for the review (optional)',
    required: false,
  })
  @IsOptional()
  @IsArray()
  tags?: string[] | null;

  @ApiProperty({
    example: [
      'https://example.com/image1.jpg',
      'https://example.com/image2.jpg',
    ],
    description: 'Image URLs for the review (optional)',
    required: false,
  })
  @IsOptional()
  @IsArray()
  images?: string[] | null;
}
