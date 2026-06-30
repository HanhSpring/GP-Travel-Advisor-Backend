import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsString, MinLength, Matches } from 'class-validator';

export class UpdatePasswordDto {
  @ApiProperty({ description: 'Token lấy từ URL khi click vào link email' })
  @IsNotEmpty({ message: 'Thiếu mã xác thực (Token)' })
  @IsString()
  accessToken: string;

  @ApiProperty({
    description:
      'Mật khẩu mới: tối thiểu 8 ký tự, có chữ hoa, chữ thường, chữ số và ký tự đặc biệt',
  })
  @IsNotEmpty({ message: 'Mật khẩu mới không được để trống' })
  @MinLength(8, { message: 'Mật khẩu mới phải có ít nhất 8 ký tự' })
  @Matches(
    /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[@$!%*?&.#])[A-Za-z\d@$!%*?&.#]{8,}$/,
    {
      message:
        'Mật khẩu mới phải chứa ít nhất 1 chữ hoa, 1 chữ thường, 1 chữ số và 1 ký tự đặc biệt (@$!%*?&.#)',
    },
  )
  @IsString()
  newPassword: string;
}
