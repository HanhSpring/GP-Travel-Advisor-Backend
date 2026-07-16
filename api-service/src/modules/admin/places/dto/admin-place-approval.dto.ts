import { ApiProperty } from '@nestjs/swagger';
import { IsOptional, IsString, MaxLength } from 'class-validator';

export class AdminPlaceRejectRequestDto {
  @ApiProperty({
    required: false,
    example: 'Thiếu giấy phép kinh doanh',
    description: 'Reason for rejection, persisted to places.rejection_reason',
  })
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  note?: string;
}

export class AdminPlaceApprovalResponseDto {
  @ApiProperty({ description: 'Place ID' })
  id: string;

  @ApiProperty({ description: 'Place name' })
  name: string;

  @ApiProperty({ description: 'New status (approved/rejected)' })
  status: string;

  @ApiProperty({ description: 'Success message' })
  message: string;

  @ApiProperty({
    required: false,
    nullable: true,
    description: 'Rejection reason, persisted into places.rejection_reason',
  })
  note?: string | null;
}
