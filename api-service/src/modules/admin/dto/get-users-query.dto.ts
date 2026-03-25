import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, IsEnum, IsInt, Min } from 'class-validator';
import { Type } from 'class-transformer';

export enum UserRole {
  ADMIN = 'ADMIN',
  BUSINESS = 'BUSINESS',
  TOURIST = 'TOURIST',
}

export enum UserStatus {
  ACTIVE = 'ACTIVE', // Hoạt động
  LOCKED = 'LOCKED', // Đã khóa
}

export class GetUsersQueryDto {
  @ApiPropertyOptional({
    example: 1,
    description: 'Trang hiện tại (Mặc định: 1)',
  })
  @IsOptional()
  @Type(() => Number) // Tự động ép kiểu chuỗi trên URL thành số
  @IsInt()
  @Min(1)
  page?: number = 1;

  @ApiPropertyOptional({
    example: 10,
    description: 'Số lượng kết quả trên mỗi trang (Mặc định: 10)',
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  limit?: number = 10;

  @ApiPropertyOptional({
    example: 'nguyen',
    description: 'Tìm kiếm theo tên hoặc email',
  })
  @IsOptional()
  @IsString()
  search?: string;

  @ApiPropertyOptional({
    enum: UserRole,
    description: 'Lọc theo vai trò người dùng',
  })
  @IsOptional()
  @IsEnum(UserRole)
  role?: UserRole;

  @ApiPropertyOptional({
    enum: UserStatus,
    description: 'Lọc theo trạng thái tài khoản',
  })
  @IsOptional()
  @IsEnum(UserStatus)
  status?: UserStatus;
}
