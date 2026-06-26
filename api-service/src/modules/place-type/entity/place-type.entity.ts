import { ApiProperty } from '@nestjs/swagger';

export class PlaceType {
  @ApiProperty({ example: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890' })
  id: string;

  @ApiProperty({ example: 'Khách sạn' })
  name: string;
}
