import { ApiProperty } from '@nestjs/swagger';

export class FavoriteItineraryCardDto {
  @ApiProperty({
    description: 'Itinerary ID',
    example: '550e8400-e29b-41d4-a716-446655440000',
  })
  id: string;

  @ApiProperty({
    description: 'Itinerary title/destination',
    example: 'Sài Gòn - Nha Trang',
  })
  title: string;

  @ApiProperty({
    description: 'Destination location',
    example: 'Nha Trang',
  })
  location: string;

  @ApiProperty({
    description: 'Number of days in itinerary',
    example: 3,
  })
  days: number;

  @ApiProperty({
    description: 'Number of participants',
    example: 2,
  })
  participant_count: number;

  @ApiProperty({
    description: 'Itinerary status',
    enum: ['pending', 'ongoing', 'uncompleted', 'completed'],
    example: 'pending',
  })
  status: string;
}

export class FavoritePlaceCardDto {
  @ApiProperty({
    description: 'Place ID',
    example: '550e8400-e29b-41d4-a716-446655440000',
  })
  id: string;

  @ApiProperty({
    description: 'Place name',
    example: 'Hạ Long Bay',
  })
  name: string;

  @ApiProperty({
    description: 'City location',
    example: 'Quảng Ninh',
  })
  city: string;

  @ApiProperty({
    description: 'Place image URL',
    example:
      'https://images.unsplash.com/photo-1511632765486-a01980e01a18?w=1080&h=720',
  })
  image: string;

  @ApiProperty({
    description: 'Average rating',
    example: 4.5,
  })
  rating: number;

  @ApiProperty({
    description: 'Total number of reviews',
    example: 128,
  })
  review_count: number;
}

export class PaginationDto {
  @ApiProperty({
    description: 'Current page number',
    example: 1,
  })
  page: number;

  @ApiProperty({
    description: 'Items per page',
    example: 5,
  })
  limit: number;

  @ApiProperty({
    description: 'Total number of items',
    example: 25,
  })
  total: number;

  @ApiProperty({
    description: 'Total number of pages',
    example: 5,
  })
  pages: number;
}

export class ViewAllTargetsDto {
  @ApiProperty({
    description: 'URL for viewing all favorite itineraries',
    example: '/collections/itineraries?page=1&limit=50',
  })
  favorite_itineraries: string;

  @ApiProperty({
    description: 'URL for viewing all favorite places',
    example: '/collections/places?page=1&limit=50',
  })
  favorite_places: string;
}

export class CollectionsHomeResponseDto {
  @ApiProperty({
    description: 'List of favorite itineraries (max 5)',
    type: [FavoriteItineraryCardDto],
  })
  favorite_itineraries: FavoriteItineraryCardDto[];

  @ApiProperty({
    description: 'List of favorite places (max 5)',
    type: [FavoritePlaceCardDto],
  })
  favorite_places: FavoritePlaceCardDto[];

  @ApiProperty({
    description: 'URLs for viewing all collections',
    type: ViewAllTargetsDto,
  })
  view_all_targets: ViewAllTargetsDto;
}

export class FavoriteItinerariesResponseDto {
  @ApiProperty({
    description: 'List of favorite itineraries',
    type: [FavoriteItineraryCardDto],
  })
  data: FavoriteItineraryCardDto[];

  @ApiProperty({
    description: 'Pagination information',
    type: PaginationDto,
  })
  pagination: PaginationDto;
}

export class FavoritePlacesResponseDto {
  @ApiProperty({
    description: 'List of favorite places',
    type: [FavoritePlaceCardDto],
  })
  data: FavoritePlaceCardDto[];

  @ApiProperty({
    description: 'Pagination information',
    type: PaginationDto,
  })
  pagination: PaginationDto;
}

// Legacy DTOs (kept for backward compatibility if needed)
export class CollectionPlaceDto {
  @ApiProperty()
  id: string;

  @ApiProperty()
  name: string;

  @ApiProperty()
  image: string;
}

export class CollectionResponseDto {
  @ApiProperty()
  id: string;

  @ApiProperty()
  title: string;

  @ApiProperty()
  days: number;

  @ApiProperty()
  place_count: number;

  @ApiProperty()
  likes: number;

  @ApiProperty({ type: [CollectionPlaceDto] })
  places: CollectionPlaceDto[];
}
