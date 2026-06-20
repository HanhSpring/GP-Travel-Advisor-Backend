import { ApiProperty } from '@nestjs/swagger';

export class ItineraryReviewPopupResponseDto {
  @ApiProperty()
  show_popup: boolean;

  @ApiProperty()
  reason: string;

  @ApiProperty({ type: Object })
  itinerary: {
    id: string;
    title: string;
    start_date: string;
    end_date: string;
    cover_image: string | null;
  };

  @ApiProperty({ type: Object })
  draft: {
    overall_rating: number | null;
    overall_content: string | null;
    apply_all_places: boolean;
    status: 'draft' | 'submitted';
  };

  @ApiProperty({ type: Object })
  actions: {
    detail_target: string;
    submit_target: string;
    dismiss_target: string;
  };
}

export class ItineraryReviewDetailPlaceItemDto {
  @ApiProperty()
  itinerary_detail_id: string;

  @ApiProperty()
  day_label: string;

  @ApiProperty()
  visit_date: string;

  @ApiProperty()
  place_id: string;

  @ApiProperty()
  place_name: string;

  @ApiProperty({ nullable: true, type: String })
  place_image_url: string | null;

  @ApiProperty({ nullable: true, type: Number })
  rating: number | null;

  @ApiProperty({ nullable: true, type: String })
  content: string | null;
}

export class SubmittedPlaceReviewDto {
  @ApiProperty()
  itinerary_detail_id: string;

  @ApiProperty()
  day_label: string;

  @ApiProperty()
  place_name: string;

  @ApiProperty({ nullable: true, type: String })
  place_image_url: string | null;

  @ApiProperty({ nullable: true, type: Number })
  rating: number | null;

  @ApiProperty({ nullable: true, type: String })
  content: string | null;

  @ApiProperty({ type: [String] })
  media_urls: string[];
}

export class ItinerarySubmittedReviewResponseDto {
  @ApiProperty({ type: Object })
  itinerary: {
    id: string;
    title: string;
    start_date: string;
    end_date: string;
    cover_image: string | null;
  };

  @ApiProperty({ type: Object })
  overall: {
    rating: number | null;
    content: string | null;
    media_urls: string[];
  };

  @ApiProperty({ type: [SubmittedPlaceReviewDto] })
  places: SubmittedPlaceReviewDto[];
}

export class ItineraryReviewSummaryResponseDto {
  @ApiProperty()
  has_review: boolean;

  @ApiProperty({ nullable: true, type: Number })
  rating: number | null;

  @ApiProperty({ nullable: true, type: String })
  content: string | null;
}

export class ItineraryReviewDetailResponseDto {
  @ApiProperty({ type: Object })
  itinerary: {
    id: string;
    title: string;
    start_date: string;
    end_date: string;
    status: string | null;
    cover_image: string | null;
    total_places: number;
  };

  @ApiProperty({ type: Object })
  general_review: {
    overall_rating: number | null;
    overall_content: string | null;
    apply_all_places: boolean;
  };

  @ApiProperty({ type: [Object] })
  day_filters: Array<{ value: string; label: string }>;

  @ApiProperty({ type: [ItineraryReviewDetailPlaceItemDto] })
  places: ItineraryReviewDetailPlaceItemDto[];

  @ApiProperty({ type: [String] })
  media_urls: string[];

  @ApiProperty({ type: Object })
  actions: {
    submit_target: string;
  };
}
