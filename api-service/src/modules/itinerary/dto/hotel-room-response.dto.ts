import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class HotelRoomResponseDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ format: 'uuid' })
  placeId!: string;

  @ApiProperty()
  roomName!: string;

  @ApiPropertyOptional({
    description:
      'Loại phòng. order_sys.hotel_rooms hiện không có cột room_type.',
    nullable: true,
  })
  roomType!: string | null;

  @ApiProperty({
    description:
      'Sức chứa của một phòng, lấy từ cột quantity trong order_sys.hotel_rooms.',
  })
  quantity!: number;

  @ApiProperty({
    description: 'Giá chính xác của một phòng cho một đêm, đơn vị VND.',
  })
  price!: number;
}
