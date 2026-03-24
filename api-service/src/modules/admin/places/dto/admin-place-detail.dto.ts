import { ApiProperty } from '@nestjs/swagger';

export class VendorInfoDto {
  @ApiProperty()
  id: string;

  @ApiProperty()
  name: string;

  @ApiProperty()
  email: string;

  @ApiProperty()
  phone: string;

  @ApiProperty()
  total_places: number;
}

export class AdminPlaceDetailDto {
  @ApiProperty({ description: 'Place ID' })
  id: string;

  @ApiProperty({ description: 'Place name (read-only)' })
  name: string;

  @ApiProperty({ description: 'Place description (read-only)' })
  description: string;

  @ApiProperty({ description: 'Full address (read-only)' })
  address: string;

  @ApiProperty({ description: 'City (read-only)' })
  city: string;

  @ApiProperty({ description: 'Latitude (read-only)' })
  latitude: number;

  @ApiProperty({ description: 'Longitude (read-only)' })
  longitude: number;

  @ApiProperty({ description: 'Contact phone (read-only)' })
  contact_phone: string;

  @ApiProperty({ description: 'Contact email (read-only)' })
  contact_email: string;

  @ApiProperty({
    description: 'Image gallery (read-only)',
    type: [String],
    required: false,
  })
  images?: string[];

  @ApiProperty({ description: 'Place category (read-only)' })
  category: string;

  @ApiProperty({ description: 'Registered date' })
  registered_date: string;

  @ApiProperty({ description: 'Approval status (approved/pending)' })
  status: string;

  @ApiProperty({ type: VendorInfoDto, description: 'Vendor information' })
  vendor: VendorInfoDto | null;
}
