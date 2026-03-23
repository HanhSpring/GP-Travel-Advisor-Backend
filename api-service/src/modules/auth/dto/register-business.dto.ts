import { ApiProperty } from '@nestjs/swagger';
import {
  IsEmail,
  IsNotEmpty,
  MinLength,
  IsBoolean,
  Equals,
  IsString,
} from 'class-validator';

export class RegisterBusinessDto {
  @ApiProperty({
    example: 'Nguyễn Văn A',
    description: 'Họ và tên của người đại diện đối tác',
  })
  @IsNotEmpty({ message: 'Vui lòng nhập họ và tên' })
  @IsString()
  fullName: string;

  @ApiProperty({
    example: '0912345678',
    description: 'Số điện thoại liên hệ',
  })
  @IsNotEmpty({ message: 'Vui lòng nhập số điện thoại' })
  @IsString()
  phone: string;

  @ApiProperty({
    example: 'nva@gmail.com',
    description: 'Địa chỉ email dùng để đăng nhập và nhận thông báo',
  })
  @IsEmail({}, { message: 'Email không đúng định dạng' })
  @IsNotEmpty({ message: 'Vui lòng nhập email' })
  email: string;

  @ApiProperty({
    example: '123456',
    description: 'Mật khẩu bảo mật',
  })
  @IsNotEmpty({ message: 'Vui lòng nhập mật khẩu' })
  @MinLength(6, { message: 'Mật khẩu phải có ít nhất 6 ký tự' })
  password: string;

  @ApiProperty({
    example: true,
    description: 'Đồng ý với các điều khoản dịch vụ',
  })
  @IsBoolean()
  @IsNotEmpty({ message: 'Vui lòng đồng ý với các điều khoản dịch vụ' })
  @Equals(true, { message: 'Bạn phải đồng ý với các điều khoản dịch vụ' })
  agreeToTerms: boolean;
}
