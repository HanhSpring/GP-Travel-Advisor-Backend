import { ApiProperty } from '@nestjs/swagger';
import {
  IsEmail,
  IsNotEmpty,
  IsString,
  MinLength,
  IsEnum,
} from 'class-validator';

// Enum cho phần Dropdown "Chọn giới tính"
export enum Gender {
  MALE = 'MALE',
  FEMALE = 'FEMALE',
  OTHER = 'OTHER',
}

export class RegisterTouristDto {
  @ApiProperty({
    example: 'Nguyễn Văn B',
    description: 'Họ và tên của khách du lịch',
  })
  @IsNotEmpty({ message: 'Vui lòng nhập họ và tên' })
  @IsString()
  fullName: string;

  @ApiProperty({
    enum: Gender,
    example: Gender.MALE,
    description: 'Giới tính (Chọn từ dropdown)',
  })
  @IsNotEmpty({ message: 'Vui lòng chọn giới tính' })
  @IsEnum(Gender, { message: 'Giới tính không hợp lệ' })
  gender: Gender;

  @ApiProperty({
    example: 'tourist@gmail.com',
    description: 'Email đăng nhập',
  })
  @IsNotEmpty({ message: 'Vui lòng nhập email' })
  @IsEmail({}, { message: 'Email không đúng định dạng' })
  email: string;

  @ApiProperty({
    example: '0987654321',
    description: 'Số điện thoại',
  })
  @IsNotEmpty({ message: 'Vui lòng nhập số điện thoại' })
  @IsString()
  phoneNumber: string;

  @ApiProperty({
    example: 'password123',
    description: 'Mật khẩu (Đã được FE đối chiếu với ô Xác nhận mật khẩu)',
  })
  @IsNotEmpty({ message: 'Vui lòng nhập mật khẩu' })
  @MinLength(6, { message: 'Mật khẩu phải có ít nhất 6 ký tự' })
  password: string;
}
