import { ApiProperty } from '@nestjs/swagger';
import { IsOptional, IsString, MaxLength } from 'class-validator';

export class AdminPlaceRejectRequestDto {
  @ApiProperty({
    required: false,
    example: 'Thiếu giấy phép kinh doanh',
    description: 'Feedback/note for rejection (temporary, not persisted yet)',
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
    description: 'Temporary reject note from request body (not saved)',
  })
  note?: string | null;

  @ApiProperty({
    required: false,
    description: 'Whether note is persisted into DB',
    example: false,
  })
  note_saved?: boolean;
}
