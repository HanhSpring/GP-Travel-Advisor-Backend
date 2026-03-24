import { ApiProperty } from '@nestjs/swagger';

export class BusinessReviewStatsDto {
  @ApiProperty()
  average_rating: number;

  @ApiProperty()
  total_reviews: number;

  @ApiProperty()
  five_star: number;

  @ApiProperty()
  four_star: number;

  @ApiProperty()
  three_star: number;

  @ApiProperty()
  two_star: number;

  @ApiProperty()
  one_star: number;
}
