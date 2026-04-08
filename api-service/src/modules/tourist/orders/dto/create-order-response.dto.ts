import { ApiProperty } from '@nestjs/swagger';

class CreatedOrderItemDto {
  @ApiProperty()
  food_item_id: string;

  @ApiProperty()
  quantity: number;

  @ApiProperty()
  unit_price: number;

  @ApiProperty()
  total_price: number;
}

export class CreateOrderResponseDto {
  @ApiProperty()
  success: boolean;

  @ApiProperty()
  order_id: string;

  @ApiProperty()
  total_amount: number;

  @ApiProperty({ type: [CreatedOrderItemDto] })
  items: CreatedOrderItemDto[];

  @ApiProperty()
  message: string;
}
