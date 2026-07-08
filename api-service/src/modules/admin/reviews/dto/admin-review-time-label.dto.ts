import { ApiProperty } from '@nestjs/swagger';
import { IsEnum } from 'class-validator';

export class AdminReviewTimeLabelDto {
  @ApiProperty({
    enum: ['short-term', 'long-term'],
    description: 'New time label for the review content',
  })
  @IsEnum(['short-term', 'long-term'])
  time_label: 'short-term' | 'long-term';
}
