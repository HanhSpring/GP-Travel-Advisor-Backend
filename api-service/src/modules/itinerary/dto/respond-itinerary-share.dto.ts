import { ApiProperty } from '@nestjs/swagger';
import { IsIn, IsNotEmpty, IsString } from 'class-validator';

export class RespondItineraryShareDto {
  @ApiProperty({
    description: 'ID người nhận lời mời',
    example: '00000000-0000-0000-0000-000000000000',
  })
  @IsString()
  @IsNotEmpty()
  userId: string;

  @ApiProperty({
    description: 'ID notification lời mời chia sẻ',
    example: '00000000-0000-0000-0000-000000000000',
  })
  @IsString()
  @IsNotEmpty()
  notificationId: string;

  @ApiProperty({ enum: ['accept', 'reject'] })
  @IsString()
  @IsIn(['accept', 'reject'])
  action: 'accept' | 'reject';
}
