import { ApiProperty } from '@nestjs/swagger';
import {
  IsEmail,
  IsNotEmpty,
  MinLength,
  IsBoolean,
  Equals,
  IsString,
  Matches,
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
    description: 'Số điện thoại liên hệ (10 chữ số, bắt đầu bằng 0)',
  })
  @IsNotEmpty({ message: 'Vui lòng nhập số điện thoại' })
  @IsString()
  @Matches(/^0[0-9]{9}$/, { message: 'Số điện thoại phải có đúng 10 chữ số và bắt đầu bằng 0' })
  phone: string;

  @ApiProperty({
    example: 'nva@gmail.com',
    description: 'Địa chỉ email dùng để đăng nhập và nhận thông báo',
  })
  @IsEmail({}, { message: 'Email không đúng định dạng' })
  @IsNotEmpty({ message: 'Vui lòng nhập email' })
  email: string;

  @ApiProperty({
    example: 'Password@123',
    description: 'Mật khẩu: tối thiểu 8 ký tự, có chữ hoa, chữ thường, chữ số và ký tự đặc biệt (@$!%*?&.#)',
  })
  @IsNotEmpty({ message: 'Vui lòng nhập mật khẩu' })
  @MinLength(8, { message: 'Mật khẩu phải có ít nhất 8 ký tự' })
  @Matches(/^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[@$!%*?&.#])[A-Za-z\d@$!%*?&.#]{8,}$/, {
    message: 'Mật khẩu phải chứa ít nhất 1 chữ hoa, 1 chữ thường, 1 chữ số và 1 ký tự đặc biệt (@$!%*?&.#)',
  })
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
