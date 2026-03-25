import { ApiProperty } from '@nestjs/swagger'

export class PlaceItemDto {
  @ApiProperty() place_id: string
  @ApiProperty() place_name: string
  @ApiProperty() address: string
  @ApiProperty() city: string
  @ApiProperty() category: string
  @ApiProperty() status: string
  @ApiProperty() rating: number
}

export class OrderItemDto {
  @ApiProperty() order_id: string
  @ApiProperty() customer_name: string
  @ApiProperty() total_amount: number
  @ApiProperty() status: string
}

export class DashboardDto {
  @ApiProperty() total_places: number
  @ApiProperty() total_orders: number
  @ApiProperty() total_food_items: number
  @ApiProperty() average_rating: number
}