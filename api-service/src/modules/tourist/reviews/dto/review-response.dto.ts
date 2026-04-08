import { ApiProperty } from '@nestjs/swagger';

export class ReviewResponseDto {
  @ApiProperty()
  id: string;

  @ApiProperty()
  tourist_id: string;

  @ApiProperty()
  place_id: string;

  @ApiProperty({ required: false, nullable: true })
  itinerary_id?: string | null;

  @ApiProperty()
  rating: number;

  @ApiProperty()
  created_at: string;

  @ApiProperty({ required: false, nullable: true })
  content?: string | null;

  @ApiProperty({ type: [String], required: false, nullable: true })
  tags?: string[] | null;

  @ApiProperty({ type: [String], required: false, nullable: true })
  images?: string[] | null;
}
