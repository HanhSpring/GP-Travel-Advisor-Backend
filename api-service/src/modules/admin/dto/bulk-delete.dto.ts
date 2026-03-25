import { ApiProperty } from '@nestjs/swagger';
import { IsArray, IsString, IsNotEmpty } from 'class-validator';

export class BulkDeleteUsersDto {
  @ApiProperty({
    example: ['uuid-user-1', 'uuid-user-2'],
    description: 'Mảng chứa danh sách ID của các người dùng cần xóa',
    isArray: true,
  })
  @IsArray()
  @IsString({ each: true })
  @IsNotEmpty()
  userIds: string[];
}
