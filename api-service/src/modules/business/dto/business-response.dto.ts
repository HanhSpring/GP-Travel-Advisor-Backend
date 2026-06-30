import { ApiProperty } from '@nestjs/swagger';

export class PlaceItemDto {
  @ApiProperty() place_id: string;
  @ApiProperty() place_name: string;
  @ApiProperty() address: string;
  @ApiProperty() city: string;
  @ApiProperty() category: string;
  @ApiProperty() status: string;
  @ApiProperty() rating: number;

  // Những trường này cực kỳ quan trọng, phải có thì NestJS mới cho đi qua
  @ApiProperty({ required: false }) p_services?: any[];
  @ApiProperty({ required: false }) p_menu?: any[];
  @ApiProperty({ required: false }) p_images?: string[];

  @ApiProperty() p_open_time: string;
  @ApiProperty() p_close_time: string;
  @ApiProperty() p_description: string;
}

export class OrderItemDto {
  @ApiProperty() order_id: string;
  @ApiProperty() customer_name: string;
  @ApiProperty() total_amount: number;
  @ApiProperty() status: string;
}

export class DashboardDto {
  @ApiProperty() total_places: number;
  @ApiProperty() total_orders: number;
  @ApiProperty() pending_orders: number;
  @ApiProperty() total_food_items: number;
  @ApiProperty() average_rating: number;
}
