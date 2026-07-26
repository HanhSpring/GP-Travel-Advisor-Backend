import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsArray,
  IsInt,
  IsNotEmpty,
  IsString,
  Min,
  ValidateNested,
} from 'class-validator';

export class ChildAssignmentEntryDto {
  @ApiProperty({ description: 'ID thành viên (tourist_id)' })
  @IsString()
  @IsNotEmpty()
  touristId: string;

  @ApiProperty({ description: 'Số trẻ em người này phụ trách (> 0)' })
  @IsInt()
  @Min(1)
  childCount: number;
}

/** Gán lại TOÀN BỘ danh sách "ai phụ trách bao nhiêu trẻ em" — thay thế
 * hoàn toàn bảng gán cũ, không phải patch từng dòng (xem
 * IncurredCostsService.setChildAssignments()). Chỉ chủ lịch trình được gọi.
 * Trẻ chưa được gán (childCount lịch trình trừ tổng đã gán) mặc định vẫn
 * thuộc về chủ lịch trình. */
export class UpdateChildAssignmentsDto {
  @ApiProperty({
    description: 'ID người gọi (phải là chủ lịch trình)',
    example: '00000000-0000-0000-0000-000000000000',
  })
  @IsString()
  @IsNotEmpty()
  userId: string;

  @ApiProperty({
    type: [ChildAssignmentEntryDto],
    description:
      'Danh sách gán mới, thay thế hoàn toàn danh sách cũ. Rỗng = bỏ hết, toàn bộ trẻ em dồn về chủ lịch trình.',
  })
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => ChildAssignmentEntryDto)
  assignments: ChildAssignmentEntryDto[];
}
