import { ApiProperty } from '@nestjs/swagger';

export class BusinessPlaceDto {
  @ApiProperty()
  id: string;

  @ApiProperty({
    required: false,
    nullable: true,
  })
  image_url?: string | null;

  @ApiProperty()
  name: string;

  @ApiProperty({ type: [String] })
  categories: string[];

  @ApiProperty()
  address: string;

  @ApiProperty()
  rating: number;

  @ApiProperty()
  review_count: number;

  @ApiProperty()
  status: string;

  @ApiProperty()
  registered_date: string;
}

export class BusinessPlacePaginationDto {
  @ApiProperty()
  page: number;

  @ApiProperty()
  limit: number;

  @ApiProperty()
  total: number;

  @ApiProperty()
  pages: number;
}

export class BusinessPlaceListResponseDto {
  @ApiProperty({ type: [BusinessPlaceDto] })
  data: BusinessPlaceDto[];

  @ApiProperty({ type: BusinessPlacePaginationDto })
  pagination: BusinessPlacePaginationDto;
}
