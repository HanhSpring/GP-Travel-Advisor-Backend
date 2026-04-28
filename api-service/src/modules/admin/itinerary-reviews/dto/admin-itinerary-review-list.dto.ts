import { ApiProperty } from '@nestjs/swagger';

export class AdminItineraryReviewListItemDto {
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
  itinerary_id: string;

  @ApiProperty()
  itinerary_name: string;

  @ApiProperty({ required: false, nullable: true, type: String })
  itinerary_start_date: string | null;

  @ApiProperty({ required: false, nullable: true, type: String })
  itinerary_end_date: string | null;

  @ApiProperty()
  rating: number;

  @ApiProperty({ nullable: true, type: String })
  review_content: string | null;

  @ApiProperty({ enum: ['pending', 'approved', 'violation'] })
  status: 'pending' | 'approved' | 'violation';

  @ApiProperty()
  created_at: string;

  @ApiProperty()
  has_images: boolean;
}

export class AdminItineraryReviewListResponseDto {
  @ApiProperty({ type: [AdminItineraryReviewListItemDto] })
  data: AdminItineraryReviewListItemDto[];

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