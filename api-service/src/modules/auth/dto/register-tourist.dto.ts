import { ApiProperty } from '@nestjs/swagger';
import {
  IsEmail,
  IsNotEmpty,
  IsString,
  MinLength,
  IsEnum,
  Matches,
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
    description: 'Số điện thoại (10 chữ số, bắt đầu bằng 0)',
  })
  @IsNotEmpty({ message: 'Vui lòng nhập số điện thoại' })
  @IsString()
  @Matches(/^0[0-9]{9}$/, {
    message: 'Số điện thoại phải có đúng 10 chữ số và bắt đầu bằng 0',
  })
  phoneNumber: string;

  @ApiProperty({
    example: 'Password@123',
    description:
      'Mật khẩu: tối thiểu 8 ký tự, có chữ hoa, chữ thường, chữ số và ký tự đặc biệt (@$!%*?&.#)',
  })
  @IsNotEmpty({ message: 'Vui lòng nhập mật khẩu' })
  @MinLength(8, { message: 'Mật khẩu phải có ít nhất 8 ký tự' })
  @Matches(
    /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[@$!%*?&.#])[A-Za-z\d@$!%*?&.#]{8,}$/,
    {
      message:
        'Mật khẩu phải chứa ít nhất 1 chữ hoa, 1 chữ thường, 1 chữ số và 1 ký tự đặc biệt (@$!%*?&.#)',
    },
  )
  password: string;
}
