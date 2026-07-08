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

  @ApiProperty()
  review_type: string;

  @ApiProperty({ nullable: true, type: String })
  main_topic: string | null;

  @ApiProperty({ nullable: true, type: String })
  time_label: string | null;

  @ApiProperty({ nullable: true, type: String })
  review_content: string | null;

  @ApiProperty({ type: [AdminReviewImageDto] })
  images: AdminReviewImageDto[];

  @ApiProperty({ enum: ['pending', 'approved', 'violation', 'hidden'] })
  status: 'pending' | 'approved' | 'violation' | 'hidden';

  @ApiProperty({ nullable: true, type: String })
  violation_reason: string | null;

  @ApiProperty()
  created_at: string;
}
