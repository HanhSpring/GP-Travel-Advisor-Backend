import { ApiProperty } from '@nestjs/swagger';

export class AdminReviewListItemDto {
  @ApiProperty()
  id: string;

  @ApiProperty()
  reviewer_id: string;

  @ApiProperty()
  reviewer_name: string;

  @ApiProperty()
  reviewer_review_count: number;

  @ApiProperty()
  reviewer_report_count: number;

  @ApiProperty()
  place_id: string;

  @ApiProperty()
  place_name: string;

  @ApiProperty()
  place_address: string;

  @ApiProperty()
  rating: number;

  @ApiProperty()
  review_type: string;

  @ApiProperty({ nullable: true, type: String })
  review_content: string | null;

  @ApiProperty({ nullable: true, type: String })
  main_topic: string | null;

  @ApiProperty({ nullable: true, type: String })
  time_label: string | null;

  @ApiProperty({ enum: ['pending', 'approved', 'violation', 'hidden'] })
  status: 'pending' | 'approved' | 'violation' | 'hidden';

  @ApiProperty()
  created_at: string;

  @ApiProperty()
  has_images: boolean;
}

export class AdminReviewListResponseDto {
  @ApiProperty({ type: [AdminReviewListItemDto] })
  data: AdminReviewListItemDto[];

  @ApiProperty({ type: Object })
  pagination: {
    total: number;
    page: number;
    limit: number;
    total_pages: number;
  };

  @ApiProperty({ type: Object })
  summary: {
    total_reviews: number;
    pending_count: number;
    approved_count: number;
    violation_count: number;
  };
}
