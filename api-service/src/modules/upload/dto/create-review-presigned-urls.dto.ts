import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Min,
  ValidateNested,
} from 'class-validator';

export class ReviewPresignFileDto {
  @IsString()
  file_name: string;

  @IsString()
  content_type: string;

  @IsInt()
  @Min(1)
  size: number;

  @IsOptional()
  @IsInt()
  sort_order?: number;
}

export class CreateReviewPresignedUrlsDto {
  @IsIn(['itinerary', 'place'])
  scope: 'itinerary' | 'place';

  @IsUUID()
  itinerary_id: string;

  @IsOptional()
  @IsUUID()
  itinerary_detail_id?: string;

  @IsArray()
  @ArrayMaxSize(30)
  @ValidateNested({ each: true })
  @Type(() => ReviewPresignFileDto)
  files: ReviewPresignFileDto[];
}
