import { ApiProperty } from '@nestjs/swagger';

export class PlaceType {
  @ApiProperty({ example: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890' })
  id: string;

  @ApiProperty({ example: 'Quán ăn' })
  name: string;

  @ApiProperty({ example: 'cat-uuid', required: false, nullable: true })
  category_id: string | null;

  @ApiProperty({ example: 'Ẩm thực', required: false, nullable: true })
  category_name: string | null;

  @ApiProperty({ enum: ['food', 'accommodation', 'service'] })
  data_mode: 'food' | 'accommodation' | 'service';
}
