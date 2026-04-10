import { IsUUID, IsIn } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class UpdateOrderStatusDto {
  @ApiProperty({ example: 'uuid-của-đơn' })
  @IsUUID()
  orderId: string;

  @ApiProperty({ enum: ['pending', 'processing', 'completed'] })
  @IsIn(['pending', 'processing', 'completed'])
  status: string;
}
