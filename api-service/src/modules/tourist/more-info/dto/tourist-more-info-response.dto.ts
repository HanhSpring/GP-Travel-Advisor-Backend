import { ApiProperty } from '@nestjs/swagger';

class TouristBasicInfoDto {
  @ApiProperty()
  id: string;

  @ApiProperty()
  full_name: string;

  @ApiProperty()
  membership_label: string;

  @ApiProperty({ nullable: true })
  avatar_url: string | null;
}

class ReviewedPlaceDto {
  @ApiProperty()
  place_id: string;

  @ApiProperty()
  place_name: string;

  @ApiProperty()
  rating: number;

  @ApiProperty()
  reviewed_at: string;
}

class PendingReviewDto {
  @ApiProperty()
  place_id: string;

  @ApiProperty()
  place_name: string;

  @ApiProperty()
  reason: string;
}

class PlaceReviewSectionDto {
  @ApiProperty({ type: [ReviewedPlaceDto] })
  reviewed: ReviewedPlaceDto[];

  @ApiProperty()
  pending_count: number;

  @ApiProperty({ type: [PendingReviewDto] })
  pending: PendingReviewDto[];

  @ApiProperty()
  view_all_target: string;
}

class TouristOrderSummaryDto {
  @ApiProperty()
  order_id: string;

  @ApiProperty()
  order_code: string;

  @ApiProperty()
  restaurant_name: string;

  @ApiProperty()
  status: string;

  @ApiProperty()
  status_label: string;

  @ApiProperty({ nullable: true })
  ordered_at: string | null;

  @ApiProperty()
  total_amount: number;
}

class OrderSectionDto {
  @ApiProperty({ type: [TouristOrderSummaryDto] })
  recent_orders: TouristOrderSummaryDto[];

  @ApiProperty({ nullable: true })
  fallback_message: string | null;

  @ApiProperty()
  view_all_target: string;
}

class MoreInfoActionsDto {
  @ApiProperty()
  account_settings_target: string;

  @ApiProperty()
  logout_target: string;
}

export class TouristMoreInfoResponseDto {
  @ApiProperty({ type: TouristBasicInfoDto })
  user: TouristBasicInfoDto;

  @ApiProperty({ type: PlaceReviewSectionDto })
  place_reviews: PlaceReviewSectionDto;

  @ApiProperty({ type: OrderSectionDto })
  food_orders: OrderSectionDto;

  @ApiProperty({ type: MoreInfoActionsDto })
  actions: MoreInfoActionsDto;
}

class TouristOrderItemDto {
  @ApiProperty()
  id: string;

  @ApiProperty()
  food_item_id: string;

  @ApiProperty()
  name: string;

  @ApiProperty()
  quantity: number;

  @ApiProperty()
  unit_price: number;

  @ApiProperty()
  total_price: number;
}

export class TouristOrdersResponseDto {
  @ApiProperty({ type: [TouristOrderSummaryDto] })
  orders: TouristOrderSummaryDto[];
}

export class TouristOrderDetailResponseDto {
  @ApiProperty({ type: TouristOrderSummaryDto })
  order: TouristOrderSummaryDto;

  @ApiProperty({ type: [TouristOrderItemDto] })
  items: TouristOrderItemDto[];
}
