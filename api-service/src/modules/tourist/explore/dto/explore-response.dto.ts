import { ApiProperty } from '@nestjs/swagger';

export class ExploreActionLinksDto {
  @ApiProperty()
  more_info_target: string;

  @ApiProperty()
  notifications_target: string;
}

export class CurrentItineraryDto {
  @ApiProperty()
  id: string;

  @ApiProperty()
  title: string;

  @ApiProperty()
  date_range: string;

  @ApiProperty()
  time_range: string;

  @ApiProperty()
  participant_count: number;

  @ApiProperty({ nullable: true })
  status: string | null;

  @ApiProperty()
  can_start: boolean;

  @ApiProperty({ nullable: true })
  start_target: string | null;
}

export class FeaturedItineraryDto {
  @ApiProperty()
  id: string;

  @ApiProperty()
  title: string;

  @ApiProperty()
  location: string;

  @ApiProperty({ nullable: true })
  description: string | null;

  @ApiProperty({ nullable: true })
  start_date: string | null;

  @ApiProperty({ nullable: true })
  end_date: string | null;

  @ApiProperty()
  days: number;

  @ApiProperty({ nullable: true })
  participant_count: number | null;

  @ApiProperty()
  image: string;

  @ApiProperty({ type: [String] })
  image_gallery: string[];

  @ApiProperty()
  trip_intent: string;
}

export class ExplorePlaceDto {
  @ApiProperty()
  id: string;

  @ApiProperty()
  name: string;

  @ApiProperty()
  image: string;

  @ApiProperty()
  rating: number;

  @ApiProperty()
  review_count: number;

  @ApiProperty({ nullable: true })
  city: string | null;

  @ApiProperty({ nullable: true })
  category: string | null;
}

export class ExplorePaginationDto {
  @ApiProperty()
  page: number;

  @ApiProperty()
  limit: number;

  @ApiProperty()
  total: number;

  @ApiProperty()
  pages: number;
}

export class ExplorePublicItinerariesResponseDto {
  @ApiProperty({ type: [FeaturedItineraryDto] })
  data: FeaturedItineraryDto[];

  @ApiProperty({ type: ExplorePaginationDto })
  pagination: ExplorePaginationDto;
}

export class ExplorePlacesResponseDto {
  @ApiProperty({ nullable: true })
  category: string | null;

  @ApiProperty({ type: [ExplorePlaceDto] })
  data: ExplorePlaceDto[];

  @ApiProperty({ type: ExplorePaginationDto })
  pagination: ExplorePaginationDto;
}

export class StartItineraryResponseDto {
  @ApiProperty()
  success: boolean;

  @ApiProperty()
  itinerary_id: string;

  @ApiProperty()
  status: string;

  @ApiProperty()
  message: string;
}

export class ExploreViewAllTargetsDto {
  @ApiProperty()
  suggestion_itineraries: string;

  @ApiProperty()
  featured_places: string;

  @ApiProperty()
  restaurants: string;

  @ApiProperty()
  hotels: string;
}

export class ExploreResponseDto {
  @ApiProperty({ type: ExploreActionLinksDto })
  actions: ExploreActionLinksDto;

  @ApiProperty()
  current_location: string;

  @ApiProperty({ type: CurrentItineraryDto, nullable: true })
  current_itinerary: CurrentItineraryDto | null;

  @ApiProperty({ type: [FeaturedItineraryDto] })
  suggestion_itineraries: FeaturedItineraryDto[];

  @ApiProperty({ type: [ExplorePlaceDto] })
  featured_places: ExplorePlaceDto[];

  @ApiProperty({ type: [ExplorePlaceDto] })
  restaurants: ExplorePlaceDto[];

  @ApiProperty({ type: [ExplorePlaceDto] })
  hotels: ExploreHotelDto[];

  @ApiProperty({ type: ExploreViewAllTargetsDto })
  view_all_targets: ExploreViewAllTargetsDto;
}

export class ExploreHotelDto extends ExplorePlaceDto {}
