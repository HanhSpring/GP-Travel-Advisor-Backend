import { ApiProperty } from '@nestjs/swagger';

class OrderScreenPlaceDto {
  @ApiProperty()
  id: string;

  @ApiProperty()
  name: string;
}

class OrderFilterOptionDto {
  @ApiProperty()
  value: string;

  @ApiProperty()
  label: string;
}

class OrderFoodFiltersDto {
  @ApiProperty({ type: [OrderFilterOptionDto] })
  categories: OrderFilterOptionDto[];
}

class OrderFoodItemDto {
  @ApiProperty()
  id: string;

  @ApiProperty()
  name: string;

  @ApiProperty()
  description: string;

  @ApiProperty()
  price: number;

  @ApiProperty()
  category: string;

  @ApiProperty()
  image_url: string;
}

class OrderFoodSummaryDto {
  @ApiProperty()
  total_items: number;

  @ApiProperty()
  min_price: number;

  @ApiProperty()
  max_price: number;
}

class OrderFoodPaginationDto {
  @ApiProperty()
  page: number;

  @ApiProperty()
  limit: number;

  @ApiProperty()
  total: number;

  @ApiProperty()
  pages: number;
}

export class OrderFoodItemsResponseDto {
  @ApiProperty({ type: OrderScreenPlaceDto })
  place: OrderScreenPlaceDto;

  @ApiProperty({ type: OrderFoodFiltersDto })
  filters: OrderFoodFiltersDto;

  @ApiProperty({ type: [OrderFoodItemDto] })
  items: OrderFoodItemDto[];

  @ApiProperty({ type: OrderFoodSummaryDto })
  summary: OrderFoodSummaryDto;

  @ApiProperty({ type: OrderFoodPaginationDto })
  pagination: OrderFoodPaginationDto;
}
