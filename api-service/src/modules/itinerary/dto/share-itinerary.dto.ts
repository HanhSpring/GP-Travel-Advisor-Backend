import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsString } from 'class-validator';

export class ShareItineraryDto {
  @ApiProperty({
    description: 'ID người gửi lời mời chia sẻ lịch trình',
    example: '00000000-0000-0000-0000-000000000000',
  })
  @IsString()
  @IsNotEmpty()
  senderUserId: string;

  @ApiProperty({
    description: 'Email hoặc số điện thoại của người nhận',
    example: 'friend@example.com',
  })
  @IsString()
  @IsNotEmpty()
  recipient: string;
}
