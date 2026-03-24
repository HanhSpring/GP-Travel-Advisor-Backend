import { ApiProperty } from '@nestjs/swagger';

export class AdminReviewImageDto {
  @ApiProperty()
  url: string;
}

export class AdminReviewDetailUserDto {
  @ApiProperty()
  id: string;

  @ApiProperty()
  name: string;

  @ApiProperty()
  review_count: number;

  @ApiProperty()
  report_count: number;
}

export class AdminReviewDetailPlaceDto {
  @ApiProperty()
  id: string;

  @ApiProperty()
  name: string;

  @ApiProperty()
  address: string;
}

export class AdminReviewDetailDto {
  @ApiProperty()
  id: string;

  @ApiProperty({ type: AdminReviewDetailUserDto })
  user: AdminReviewDetailUserDto;

  @ApiProperty({ type: AdminReviewDetailPlaceDto })
  place: AdminReviewDetailPlaceDto;

  @ApiProperty()
  rating: number;

  @ApiProperty({ nullable: true, type: String })
  main_topic: string | null;

  @ApiProperty({ nullable: true, type: String })
  review_content: string | null;

  @ApiProperty({ type: [AdminReviewImageDto] })
  images: AdminReviewImageDto[];

  @ApiProperty({ enum: ['pending', 'approved', 'violation'] })
  status: 'pending' | 'approved' | 'violation';

  @ApiProperty()
  created_at: string;
}
