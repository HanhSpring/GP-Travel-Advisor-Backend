import { ApiProperty } from '@nestjs/swagger'

export class CreateFullPlaceDto {

  @ApiProperty({ example: 'Nhà hàng Test' })
  name: string

  @ApiProperty({ example: '123 Nguyễn Huệ' })
  address: string

  @ApiProperty({ example: 'Hồ Chí Minh' })
  city: string

  @ApiProperty({ example: 10.77 })
  latitude: number

  @ApiProperty({ example: 106.7 })
  longitude: number

  @ApiProperty({
    example: '["Restaurant"]',
    description: 'JSON string'
  })
  categories: string

  @ApiProperty({
    example: '[{"name":"Wifi","description":"free"}]',
    description: 'JSON string'
  })
  services: string

  @ApiProperty({
    type: 'string',
    format: 'binary',
    required: false
  })
  file?: any
}