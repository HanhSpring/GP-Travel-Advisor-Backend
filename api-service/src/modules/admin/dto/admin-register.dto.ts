import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsEmail,
  IsNotEmpty,
  IsOptional,
  IsString,
  MinLength,
  IsDateString,
  IsUrl,
} from 'class-validator';

export class CreateAdminDto {
  @ApiProperty({
    example: 'admin.travelsystem@gmail.com',
    description: 'Email đăng nhập của Admin',
  })
  @IsEmail({}, { message: 'Email không đúng định dạng' })
  @IsNotEmpty()
  email: string;

  @ApiProperty({
    example: 'Admin@123456',
    description: 'Mật khẩu (ít nhất 6 ký tự)',
  })
  @IsString()
  @MinLength(6, { message: 'Mật khẩu phải có ít nhất 6 ký tự' })
  password: string;

  @ApiProperty({ example: 'Trần Quản Trị' })
  @IsString()
  @IsNotEmpty()
  full_name: string;

  @ApiPropertyOptional({ example: '0901234567' })
  @IsString()
  @IsOptional()
  phone_number?: string;

  @ApiPropertyOptional({ example: '1995-08-15' })
  @IsDateString({}, { message: 'Ngày sinh phải theo định dạng YYYY-MM-DD' })
  @IsOptional()
  date_of_birth?: string;

  @ApiPropertyOptional({
    example: 'https://api.dicebear.com/7.x/avataaars/svg?seed=Admin',
  })
  @IsUrl({}, { message: 'Avatar phải là một URL hợp lệ' })
  @IsOptional()
  avatar_url?: string;
}
