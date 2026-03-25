import { ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsOptional,
  IsString,
  IsEmail,
  IsEnum,
  Matches,
} from 'class-validator';
import { UserRole } from './get-users-query.dto'; // Import lại Enum Role đã tạo lúc nãy

export class UpdateUserByAdminDto {
  @ApiPropertyOptional({ example: 'Nguyen Admin', description: 'Họ và tên' })
  @IsOptional()
  @IsString()
  fullName?: string;

  @ApiPropertyOptional({
    example: 'admin@system.com',
    description: 'Email đăng nhập',
  })
  @IsOptional()
  @IsEmail({}, { message: 'Email không đúng định dạng' })
  email?: string;

  @ApiPropertyOptional({ example: '0987654321', description: 'Số điện thoại' })
  @IsOptional()
  @IsString()
  phoneNumber?: string;

  @ApiPropertyOptional({
    example: '1990-01-01',
    description: 'Ngày sinh (YYYY-MM-DD)',
  })
  @IsOptional()
  @IsString()
  dateOfBirth?: string;

  @ApiPropertyOptional({
    example: '123 Đường Nguyễn Huệ...',
    description: 'Địa chỉ',
  })
  @IsOptional()
  @IsString()
  address?: string;

  @ApiPropertyOptional({ enum: UserRole, description: 'Vai trò hệ thống' })
  @IsOptional()
  @IsEnum(UserRole, { message: 'Vai trò không hợp lệ' })
  role?: UserRole;
}
