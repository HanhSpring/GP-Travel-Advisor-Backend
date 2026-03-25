import { ApiProperty } from '@nestjs/swagger';
import { IsEmail, IsNotEmpty, MinLength } from 'class-validator';

export class ResetPasswordDto {
  @ApiProperty({
    example: 'tourist@example.com',
    description: 'Email của tài khoản',
  })
  @IsEmail()
  @IsNotEmpty()
  email: string;

  @ApiProperty({
    example: '123456',
    description: 'Mã OTP 6 số nhận được từ Email',
  })
  @IsNotEmpty({ message: 'Vui lòng nhập mã xác nhận' })
  otp: string;

  @ApiProperty({
    example: 'newPassword123!',
    description: 'Mật khẩu mới (ít nhất 6 ký tự)',
  })
  @MinLength(6, { message: 'Mật khẩu phải có ít nhất 6 ký tự' })
  newPassword: string;
}
