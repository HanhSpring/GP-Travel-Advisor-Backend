import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsString } from 'class-validator';

export class CreateItineraryShareLinkDto {
  @ApiProperty({
    description: 'ID người tạo link chia sẻ lịch trình',
    example: '00000000-0000-0000-0000-000000000000',
  })
  @IsString()
  @IsNotEmpty()
  senderUserId: string;
}
