import { ApiProperty } from '@nestjs/swagger';
import { IsBoolean, IsNotEmpty } from 'class-validator';

export class ToggleVisibilityDto {
  @ApiProperty({
    example: true,
    description: 'Trạng thái: true (Công khai), false (Riêng tư)',
  })
  @IsNotEmpty()
  @IsBoolean()
  isPublic: boolean;
}
