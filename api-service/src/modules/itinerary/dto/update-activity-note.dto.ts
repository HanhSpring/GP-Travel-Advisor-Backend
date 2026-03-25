import { ApiProperty } from '@nestjs/swagger';
import { IsString, IsNotEmpty, IsOptional } from 'class-validator';

export class UpdateActivityNoteDto {
  @ApiProperty({
    example:
      'Mua quà lưu niệm cho gia đình ở đây. Nhớ mặc cả giá xuống 30-50%.',
    description: 'Nội dung ghi chú cá nhân',
  })
  @IsString()

  // Có thể dùng @IsOptional() nếu cho phép user xóa trắng ghi chú,
  // nhưng ở đây dùng @IsString() đã bao hàm cả chuỗi rỗng ''
  personalNote: string;
}
