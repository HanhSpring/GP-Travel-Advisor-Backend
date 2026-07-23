import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsString, MaxLength } from 'class-validator';

export class AdminReviewHideDto {
  @ApiProperty({
    description: 'Reason entered by the admin for hiding the review',
    example: 'Nội dung không còn phù hợp với thông tin hiện tại.',
    maxLength: 500,
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(500)
  reason: string;
}
