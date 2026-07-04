import { ApiProperty } from '@nestjs/swagger';
import { IsIn, IsNotEmpty, IsString } from 'class-validator';

export class RespondItineraryShareLinkDto {
  @ApiProperty({
    description: 'ID người đang đăng nhập và phản hồi lời mời từ link',
    example: '00000000-0000-0000-0000-000000000000',
  })
  @IsString()
  @IsNotEmpty()
  userId: string;

  @ApiProperty({
    description: 'Token trong link chia sẻ',
    example: '00000000-0000-0000-0000-000000000000',
  })
  @IsString()
  @IsNotEmpty()
  token: string;

  @ApiProperty({ enum: ['accept', 'reject'] })
  @IsString()
  @IsIn(['accept', 'reject'])
  action: 'accept' | 'reject';
}
