import { ApiProperty } from '@nestjs/swagger';

export class ReviewItemDto {
  @ApiProperty()
  id: string;

  @ApiProperty()
  user_name: string;

  @ApiProperty()
  rating: number;

  @ApiProperty()
  content: string;

  @ApiProperty()
  created_at: string;

  @ApiProperty({ required: false, nullable: true })
  provider?: string | null;

  @ApiProperty()
  status: string;

  @ApiProperty({ required: false, nullable: true })
  time_ago?: string | null;
}

export class PlaceFoodItemDto {
  @ApiProperty()
  id: string;

  @ApiProperty()
  name: string;

  @ApiProperty({ required: false, nullable: true })
  description?: string | null;

  @ApiProperty()
  price: number;

  @ApiProperty({ required: false, nullable: true })
  image_url?: string | null;

  @ApiProperty({ required: false, nullable: true })
  category?: string | null;
}

export class PaginationDto {
  @ApiProperty()
  page: number;

  @ApiProperty()
  limit: number;

  @ApiProperty()
  total: number;

  @ApiProperty()
  pages: number;
}

export class PlaceReviewListDto {
  @ApiProperty()
  average: number;

  @ApiProperty()
  total: number;

  @ApiProperty({ type: Object })
  breakdown: Record<number, number>;

  @ApiProperty({ type: [ReviewItemDto] })
  list: ReviewItemDto[];

  @ApiProperty({ required: false, nullable: true, type: PaginationDto })
  pagination?: PaginationDto;
}

export class PlaceSummaryDto {
  @ApiProperty()
  id: string;

  @ApiProperty()
  name: string;
}

export class PlaceFoodItemsResponseDto {
  @ApiProperty({ type: PlaceSummaryDto })
  place: PlaceSummaryDto;

  @ApiProperty({ type: [PlaceFoodItemDto] })
  items: PlaceFoodItemDto[];

  @ApiProperty({ type: PaginationDto })
  pagination: PaginationDto;
}

export class PlaceReviewsResponseDto {
  @ApiProperty({ type: PlaceSummaryDto })
  place: PlaceSummaryDto;

  @ApiProperty({ type: PlaceReviewListDto })
  reviews: PlaceReviewListDto;
}

export class RelatedPlaceDto {
  @ApiProperty()
  id: string;

  @ApiProperty()
  name: string;

  @ApiProperty({ required: false, nullable: true })
  city?: string | null;

  @ApiProperty()
  rating: number;

  @ApiProperty()
  review_count: number;

  @ApiProperty()
  image: string;

  @ApiProperty({ type: [String] })
  tags: string[];
}

export class PlaceDetailResponseDto {
  @ApiProperty()
  id: string;

  @ApiProperty()
  name: string;

  @ApiProperty()
  address: string;

  @ApiProperty()
  city: string;

  @ApiProperty({ required: false, nullable: true })
  district?: string | null;

  @ApiProperty()
  rating: number;

  @ApiProperty()
  review_count: number;

  @ApiProperty({ required: false, nullable: true })
  type_name?: string | null;

  @ApiProperty()
  is_favorite: boolean;

  @ApiProperty({ required: false, nullable: true })
  image_url?: string | null;

  @ApiProperty({ type: [String] })
  categories: string[];

  @ApiProperty({ type: [String] })
  tags: string[];

  @ApiProperty({ type: [String] })
  images: string[];

  @ApiProperty({ required: false, nullable: true })
  description?: string | null;

  @ApiProperty()
  open_time: string;

  @ApiProperty()
  close_time: string;

  @ApiProperty({ required: false, nullable: true })
  open_hour_compressed?: string | null;

  @ApiProperty({ required: false, nullable: true })
  is_open_now?: boolean | null;

  @ApiProperty({ required: false, nullable: true })
  phone?: string | null;

  @ApiProperty({ type: [PlaceFoodItemDto] })
  food_items: PlaceFoodItemDto[];

  @ApiProperty()
  reviews: PlaceReviewListDto;

  @ApiProperty({ type: [RelatedPlaceDto] })
  related_places: RelatedPlaceDto[];

  @ApiProperty({ required: false, nullable: true })
  latitude?: number | null;

  @ApiProperty({ required: false, nullable: true })
  longitude?: number | null;
}
