import { ApiProperty } from '@nestjs/swagger';
import { IsString, IsNotEmpty, IsOptional } from 'class-validator';

export class UpdateActivityNoteDto {
  @ApiProperty({
    example:
      'Mua quà lưu niệm cho gia đình ở đây. Nhớ mặc cả giá xuống 30-50%.',
    description: 'Nội dung ghi chú cá nhân',
  })
  @IsString()

  personalNote: string;
}
