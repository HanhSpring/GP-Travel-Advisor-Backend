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

  @ApiProperty()
  description: string;

  @ApiProperty()
  open_time: string;

  @ApiProperty()
  close_time: string;

  @ApiProperty({ required: false, nullable: true })
  is_open_now?: boolean | null;

  @ApiProperty({ required: false, nullable: true })
  phone?: string | null;

  @ApiProperty()
  reviews: {
    average: number;
    total: number;
    breakdown: Record<number, number>;
    list: ReviewItemDto[];
  };

  @ApiProperty({ type: [RelatedPlaceDto] })
  related_places: RelatedPlaceDto[];
}
