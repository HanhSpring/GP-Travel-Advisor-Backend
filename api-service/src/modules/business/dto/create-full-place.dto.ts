import { ApiProperty } from '@nestjs/swagger'

export class CreateFullPlaceDto {

  @ApiProperty({ example: 'Nhà hàng Test' })
  name?: string

  @ApiProperty({ example: '123 Nguyễn Huệ' })
  address?: string

  @ApiProperty({ example: 'Hồ Chí Minh' })
  city?: string

  @ApiProperty({ example: 10.77 })
  latitude?: number

  @ApiProperty({ example: 106.7 })
  longitude?: number

  @ApiProperty({
    example: '["Restaurant"]',
    description: 'JSON string or array'
  })
  categories?: string | string[]

  @ApiProperty({
    example: '[{"name":"Wifi","description":"free"}]',
    description: 'JSON string or array'
  })
  services?: string | Array<{ name: string; description?: string }>

  @ApiProperty({
    example: '[{"name":"Cơm Gà","price":50000}]',
    description: 'JSON string or array',
    required: false
  })
  menu?: string | Array<{ name: string; description?: string; price: number }>

  // New format from frontend (p_ prefix)
  @ApiProperty({ example: 'Nhà hàng Test', required: false })
  p_name?: string

  @ApiProperty({ example: '123 Nguyễn Huệ', required: false })
  p_address?: string

  @ApiProperty({ example: 'Hồ Chí Minh', required: false })
  p_city?: string

  @ApiProperty({ example: 10.77, required: false })
  p_lat?: number

  @ApiProperty({ example: 106.7, required: false })
  p_lng?: number

  @ApiProperty({ required: false })
  p_categories?: string[]

  @ApiProperty({ example: 'partner@example.com', required: false })
  p_email?: string

  @ApiProperty({ example: '0987654321', required: false })
  p_phone?: string

  @ApiProperty({ required: false })
  p_type_id?: string

  @ApiProperty({ required: false })
  p_type_name?: string

  @ApiProperty({ required: false })
  p_services?: Array<{ name: string; description?: string }>
  @ApiProperty({ example: '10:00', required: false })
  p_open_time?: string;

  @ApiProperty({ example: '22:00', required: false })
  p_close_time?: string;

  @ApiProperty({ example: 'Mô tả địa điểm...', required: false })
  p_description?: string;

  @ApiProperty({ required: false })
  p_images?: string[];

  @ApiProperty({ required: false })
  p_menu?: Array<{ name: string; description?: string; price: number }>

  @ApiProperty({
    type: 'string',
    format: 'binary',
    required: false
  })
  file?: any
}
