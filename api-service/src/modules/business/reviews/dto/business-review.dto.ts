import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsString, MaxLength } from 'class-validator';

export class BusinessReviewDto {
  @ApiProperty()
  id: string;

  @ApiProperty()
  user_name: string;

  @ApiProperty()
  rating: number;

  @ApiProperty()
  content: string;

  @ApiProperty({ nullable: true, required: false })
  main_topic?: string | null;

  @ApiProperty({ type: [String] })
  images: string[];

  @ApiProperty()
  created_at: string;

  @ApiProperty({ nullable: true, required: false })
  reply?: string | null;

  @ApiProperty({ nullable: true, required: false })
  replied_at?: string | null;
}

export class ReplyToReviewDto {
  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  @MaxLength(2000)
  content: string;
}

export class ReplyToReviewResponseDto {
  @ApiProperty()
  id: string;

  @ApiProperty()
  reply: string;

  @ApiProperty()
  replied_at: string;
}

export class BusinessReviewBreakdownItemDto {
  @ApiProperty()
  count: number;

  @ApiProperty()
  percent: number;
}

export class BusinessReviewBreakdownDto {
  @ApiProperty({ type: BusinessReviewBreakdownItemDto })
  5: BusinessReviewBreakdownItemDto;

  @ApiProperty({ type: BusinessReviewBreakdownItemDto })
  4: BusinessReviewBreakdownItemDto;

  @ApiProperty({ type: BusinessReviewBreakdownItemDto })
  3: BusinessReviewBreakdownItemDto;

  @ApiProperty({ type: BusinessReviewBreakdownItemDto })
  2: BusinessReviewBreakdownItemDto;

  @ApiProperty({ type: BusinessReviewBreakdownItemDto })
  1: BusinessReviewBreakdownItemDto;
}

export class BusinessReviewStatsSectionDto {
  @ApiProperty()
  average_rating: number;

  @ApiProperty()
  total_reviews: number;

  @ApiProperty({ type: BusinessReviewBreakdownDto })
  breakdown: BusinessReviewBreakdownDto;
}

export class BusinessReviewPlaceSectionDto {
  @ApiProperty()
  id: string;

  @ApiProperty()
  name: string;

  @ApiProperty()
  status: string;

  @ApiProperty()
  is_active: boolean;
}

export class BusinessReviewFiltersSectionDto {
  @ApiProperty({ type: [String] })
  available_topics: string[];
}

export class BusinessReviewPaginationDto {
  @ApiProperty()
  page: number;

  @ApiProperty()
  limit: number;

  @ApiProperty()
  total: number;

  @ApiProperty()
  pages: number;
}

export class BusinessReviewsResponseDto {
  @ApiProperty({ type: BusinessReviewPlaceSectionDto })
  place: BusinessReviewPlaceSectionDto;

  @ApiProperty({ type: BusinessReviewStatsSectionDto })
  stats: BusinessReviewStatsSectionDto;

  @ApiProperty()
  ai_insight: string;

  @ApiProperty({ type: BusinessReviewFiltersSectionDto })
  filters: BusinessReviewFiltersSectionDto;

  @ApiProperty({ type: [BusinessReviewDto] })
  reviews: BusinessReviewDto[];

  @ApiProperty({ type: BusinessReviewPaginationDto })
  pagination: BusinessReviewPaginationDto;
}
