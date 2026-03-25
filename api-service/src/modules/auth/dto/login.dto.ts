import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, MinLength } from 'class-validator';

export class LoginDto {
  @ApiProperty({
    example: 'han@gmail.com',
    description: 'Người dùng có thể nhập Email hoặc Số điện thoại',
  })
  @IsNotEmpty({ message: 'Vui lòng nhập email hoặc số điện thoại' })
  emailOrPhone: string;

  @ApiProperty({
    example: '123456',
    description: 'Mật khẩu đăng nhập',
  })
  @IsNotEmpty({ message: 'Mật khẩu không được để trống' })
  @MinLength(6, { message: 'Mật khẩu phải có ít nhất 6 ký tự' })
  password: string;
}
