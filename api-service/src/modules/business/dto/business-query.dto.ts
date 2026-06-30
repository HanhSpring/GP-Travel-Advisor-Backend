import { IsUUID } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class VendorDto {
  @ApiProperty()
  @IsUUID()
  vendorId: string;
}

export class PlaceDto {
  @ApiProperty()
  @IsUUID()
  placeId: string;
}

export class OrderDto {
  @ApiProperty()
  @IsUUID()
  orderId: string;
}
