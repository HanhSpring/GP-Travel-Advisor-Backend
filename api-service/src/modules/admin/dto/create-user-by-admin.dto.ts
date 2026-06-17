import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsEmail,
  IsEnum,
  IsNotEmpty,
  IsOptional,
  IsString,
  MinLength,
} from 'class-validator';
import { UserRole, UserActiveStatus } from './get-users-query.dto';

export class CreateUserByAdminDto {
  @ApiProperty({ example: 'Nguyễn Văn A', description: 'Họ và tên' })
  @IsNotEmpty({ message: 'Họ tên không được để trống' })
  @IsString()
  fullName: string;

  @ApiProperty({
    example: 'example@domain.com',
    description: 'Email đăng nhập',
  })
  @IsNotEmpty({ message: 'Email không được để trống' })
  @IsEmail({}, { message: 'Email không đúng định dạng' })
  email: string;

  @ApiProperty({ example: '0901234567', description: 'Số điện thoại' })
  @IsOptional()
  @IsString()
  phoneNumber?: string;

  @ApiProperty({ example: 'password123', description: 'Mật khẩu' })
  @IsNotEmpty({ message: 'Mật khẩu không được để trống' })
  @MinLength(6, { message: 'Mật khẩu phải có ít nhất 6 ký tự' })
  password: string;

  @ApiProperty({ enum: UserRole, description: 'Vai trò người dùng' })
  @IsNotEmpty()
  @IsEnum(UserRole)
  role: UserRole;

  @ApiProperty({ enum: UserActiveStatus, description: 'Trạng thái hoạt động' })
  @IsOptional()
  @IsEnum(UserActiveStatus)
  status?: UserActiveStatus = UserActiveStatus.ACTIVE;

  @ApiPropertyOptional({
    description: 'Link ảnh đại diện (Đã upload lên storage)',
  })
  @IsOptional()
  @IsString()
  avatarUrl?: string;
}
