import { ApiProperty } from '@nestjs/swagger';

class ItineraryOrderPlaceDto {
  @ApiProperty()
  order: number;

  @ApiProperty()
  itinerary_detail_id: string;

  @ApiProperty()
  place_id: string;

  @ApiProperty()
  place_name: string;

  @ApiProperty({ nullable: true })
  arrival_time: string | null;

  @ApiProperty({ nullable: true })
  visit_date: string | null;

  @ApiProperty({ type: [String] })
  categories: string[];
}

export class ItineraryOrderPlacesResponseDto {
  @ApiProperty()
  itinerary_id: string;

  @ApiProperty({ type: [ItineraryOrderPlaceDto] })
  places: ItineraryOrderPlaceDto[];
}
