import { ApiProperty } from '@nestjs/swagger';
import { IsString, IsOptional, MinLength, Matches } from 'class-validator';

export class BusinessProfileDto {
  // --- NHÓM 1: THÔNG TIN CƠ BẢN ---
  @ApiProperty({
    example: 'Nguyễn Văn A',
    description: 'Họ và tên người đại diện',
    required: false,
  })
  @IsOptional()
  @IsString()
  fullName?: string;

  @ApiProperty({
    example: '0901234567',
    description: 'Số điện thoại liên hệ',
    required: false,
  })
  @IsOptional()
  @IsString()
  phone?: string;

  @ApiProperty({
    example: '1995-01-01',
    description: 'Ngày sinh (YYYY-MM-DD)',
    required: false,
  })
  @IsOptional()
  @IsString()
  dob?: string;

  @ApiProperty({
    example: '012345678901',
    description: 'Căn cước công dân (12 số)',
    required: false,
  })
  @IsOptional()
  @IsString()
  @Matches(/^[0-9]{12}$/, { message: 'CCCD phải bao gồm đúng 12 chữ số' }) // Validate chặt chẽ
  identityCard?: string;

  @ApiProperty({
    example: '123 Đường Lê Lợi, Quận 1, TP. HCM',
    description: 'Địa chỉ kinh doanh/thường trú',
    required: false,
  })
  @IsOptional()
  @IsString()
  address?: string;

  // --- NHÓM 2: ĐỔI MẬT KHẨU (Gửi kèm khi user bật Toggle) ---
  @ApiProperty({
    example: '123456',
    description: 'Mật khẩu hiện tại (Chỉ bắt buộc nếu muốn đổi mật khẩu)',
    required: false,
  })
  @IsOptional()
  @IsString()
  oldPassword?: string;

  @ApiProperty({
    example: '1234567',
    description: 'Mật khẩu mới',
    required: false,
  })
  @IsOptional()
  @MinLength(6, { message: 'Mật khẩu mới phải có ít nhất 6 ký tự' })
  newPassword?: string;
}
