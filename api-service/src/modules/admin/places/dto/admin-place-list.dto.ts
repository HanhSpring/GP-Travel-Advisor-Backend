import { ApiProperty } from '@nestjs/swagger';

export class AdminPlaceListItemDto {
  @ApiProperty({ description: 'Place ID' })
  id: string;

  @ApiProperty({ description: 'Place name' })
  name: string;

  @ApiProperty({
    description: 'Place category (Nhà hàng, Khách sạn, Cafe, etc)',
  })
  category: string;

  @ApiProperty({ description: 'Vendor/Vendor name' })
  vendor_name: string;

  @ApiProperty({ description: 'Place status (approved/pending)' })
  status: string;

  @ApiProperty({ description: 'Place address', required: false })
  address?: string;

  @ApiProperty({ description: 'Registered date' })
  registered_date: string;
}

export class PaginationDto {
  @ApiProperty({ description: 'Current page' })
  page: number;

  @ApiProperty({ description: 'Items per page' })
  limit: number;

  @ApiProperty({ description: 'Total items' })
  total: number;

  @ApiProperty({ description: 'Total pages' })
  pages: number;
}

export class AdminPlaceListDto {
  @ApiProperty({ type: [AdminPlaceListItemDto] })
  data: AdminPlaceListItemDto[];

  @ApiProperty()
  pagination: PaginationDto;
}
