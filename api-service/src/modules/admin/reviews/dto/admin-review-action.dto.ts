import { ApiProperty } from '@nestjs/swagger';
import { IsEnum, IsOptional, IsString } from 'class-validator';

export class AdminReviewActionDto {
  @ApiProperty({
    enum: ['approved', 'violation'],
    description: 'New status for the review',
  })
  @IsEnum(['approved', 'violation'])
  status: 'approved' | 'violation';

  @ApiProperty({
    required: false,
    description: 'Reason for violation (required if status is violation)',
  })
  @IsOptional()
  @IsString()
  reason?: string;
}
