import { ApiProperty } from '@nestjs/swagger';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  Min,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';

export class SubmitReviewMediaDto {
  @ApiProperty({
    example:
      'reviews/itineraries/11111111-1111-4111-a111-111111111111/images/photo.webp',
    description: 'Final R2 object key returned by the presigned upload API',
  })
  @IsString()
  object_key: string;

  @ApiProperty({ enum: ['image', 'video'] })
  @IsIn(['image', 'video'])
  media_type: 'image' | 'video';

  @ApiProperty({ required: false, minimum: 0 })
  @IsOptional()
  @IsInt()
  @Min(0)
  sort_order?: number;
}

export class SubmitItineraryPlaceReviewDto {
  @ApiProperty({
    description: 'ID of itinerary detail row being reviewed',
    example: '0b6f38ec-ef35-4f83-9e3a-d0cf6b1f3d1d',
  })
  @IsUUID('4')
  itinerary_detail_id: string;

  @ApiProperty({ example: 4, minimum: 1, maximum: 5 })
  @IsInt()
  @Min(1)
  @Max(5)
  rating: number;

  @ApiProperty({ required: false, nullable: true })
  @IsOptional()
  @IsString()
  content?: string | null;

  @ApiProperty({
    type: [String],
    required: false,
    description: 'Quick tags selected by the user',
  })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  tags?: string[] | null;

  @ApiProperty({ type: [SubmitReviewMediaDto], required: false })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(6)
  @ValidateNested({ each: true })
  @Type(() => SubmitReviewMediaDto)
  media?: SubmitReviewMediaDto[];
}

export class SubmitItineraryReviewDto {
  @ApiProperty({
    example: '2c2caf9e-1fc9-4065-a280-45d8508458c7',
    description: 'Tourist user id',
  })
  @IsUUID('4')
  tourist_id: string;

  @ApiProperty({ required: false, nullable: true, minimum: 1, maximum: 5 })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(5)
  overall_rating?: number | null;

  @ApiProperty({ required: false, nullable: true })
  @IsOptional()
  @IsString()
  overall_content?: string | null;

  @ApiProperty({
    type: [String],
    required: false,
    description: 'Quick tags selected for the overall itinerary review',
  })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  tags?: string[] | null;

  @ApiProperty({ required: false, default: false })
  @IsOptional()
  @IsBoolean()
  apply_all_places?: boolean;

  @ApiProperty({ type: [SubmitItineraryPlaceReviewDto], required: false })
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => SubmitItineraryPlaceReviewDto)
  place_reviews?: SubmitItineraryPlaceReviewDto[];

  @ApiProperty({ type: [SubmitReviewMediaDto], required: false })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(6)
  @ValidateNested({ each: true })
  @Type(() => SubmitReviewMediaDto)
  media?: SubmitReviewMediaDto[];

  @ApiProperty({
    type: [String],
    required: false,
    description: 'Image/video urls for general itinerary feedback',
  })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  media_urls?: string[];
}
