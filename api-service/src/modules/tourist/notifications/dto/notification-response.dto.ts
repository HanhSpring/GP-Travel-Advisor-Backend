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
