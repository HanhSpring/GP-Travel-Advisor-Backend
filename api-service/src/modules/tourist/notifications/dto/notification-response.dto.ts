import { ApiProperty } from '@nestjs/swagger';

export class TouristNotificationItemDto {
  @ApiProperty()
  id: string;

  @ApiProperty()
  title: string;

  @ApiProperty()
  content: string;

  @ApiProperty({ nullable: true })
  notification_type: string | null;

  @ApiProperty({ nullable: true })
  status: string | null;

  @ApiProperty({ nullable: true })
  is_global?: boolean | null;

  @ApiProperty({ nullable: true })
  read_at?: string | null;

  @ApiProperty()
  sent_at: string;

  @ApiProperty()
  time_label: string;

  @ApiProperty({
    description: 'UI icon key, for example: map, star, food, info',
  })
  icon_key: string;

  @ApiProperty({
    description: 'Whether this notification should show unread dot',
  })
  is_unread: boolean;

  @ApiProperty({ nullable: true, required: false })
  action_type?: string | null;

  @ApiProperty({ nullable: true, required: false })
  action_label?: string | null;

  @ApiProperty({ nullable: true, required: false })
  target_type?: string | null;

  @ApiProperty({ nullable: true, required: false })
  place_id?: string | null;

  @ApiProperty({ nullable: true, required: false })
  itinerary_id?: string | null;

  @ApiProperty({ nullable: true, required: false })
  itinerary_detail_id?: string | null;

  @ApiProperty({
    required: false,
    description: 'Whether the tourist already wrote a review for this place',
  })
  has_place_review?: boolean;

  @ApiProperty({
    required: false,
    description:
      'Whether the tourist already wrote a review for this itinerary',
  })
  has_itinerary_review?: boolean;

  @ApiProperty({
    nullable: true,
    required: false,
    description:
      'Flexible action payload, for example place_id or itinerary_id',
  })
  metadata?: Record<string, unknown> | null;
}

export class TouristNotificationsResponseDto {
  @ApiProperty()
  tourist_id: string;

  @ApiProperty()
  total: number;

  @ApiProperty()
  unread_count: number;

  @ApiProperty({ type: [TouristNotificationItemDto] })
  notifications: TouristNotificationItemDto[];
}

export class TouristNotificationDetailDto extends TouristNotificationItemDto {}
