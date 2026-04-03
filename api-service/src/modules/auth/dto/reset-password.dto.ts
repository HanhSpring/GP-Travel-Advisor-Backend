import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsString, MinLength } from 'class-validator';

export class UpdatePasswordDto {
  @ApiProperty({ description: 'Token lấy từ URL khi click vào link email' })
  @IsNotEmpty({ message: 'Thiếu mã xác thực (Token)' })
  @IsString()
  accessToken: string;

  @ApiProperty({ description: 'Mật khẩu mới người dùng nhập' })
  @IsNotEmpty({ message: 'Mật khẩu mới không được để trống' })
  @MinLength(6, { message: 'Mật khẩu mới phải có ít nhất 6 ký tự' })
  @IsString()
  newPassword: string;
}
