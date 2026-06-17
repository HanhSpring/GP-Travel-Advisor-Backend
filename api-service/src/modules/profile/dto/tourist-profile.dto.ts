import { ApiProperty } from '@nestjs/swagger';
import {
  IsString,
  IsOptional,
  IsEmail,
  IsEnum,
  IsArray,
} from 'class-validator';

export enum Gender {
  MALE = 'MALE',
  FEMALE = 'FEMALE',
}

export enum TravelPreference {
  BEACH = 'BEACH',
  MOUNTAIN = 'MOUNTAIN',
  FOOD = 'FOOD',
  CULTURE = 'CULTURE',
  CITY = 'CITY',
  SHOPPING = 'SHOPPING',
  RELAX = 'RELAX',
  SPORTS = 'SPORTS',
}

export class TouristProfileDto {
  @ApiProperty({
    example: 'Nguyễn Văn A',
    description: 'Tên hiển thị',
    required: false,
  })
  @IsOptional()
  @IsString()
  displayName?: string;

  @ApiProperty({
    enum: Gender,
    example: Gender.MALE,
    description: 'Giới tính',
    required: false,
  })
  @IsOptional()
  @IsEnum(Gender)
  gender?: Gender;

  @ApiProperty({
    example: '0973973267',
    description: 'Số điện thoại',
    required: false,
  })
  @IsOptional()
  @IsString()
  phoneNumber?: string;

  @ApiProperty({
    example: 'nguyenvan.a@gmail.com',
    description: 'Email liên hệ',
    required: false,
  })
  @IsOptional()
  @IsEmail({}, { message: 'Email không hợp lệ' })
  email?: string;

  @ApiProperty({
    enum: TravelPreference,
    isArray: true,
    example: [TravelPreference.BEACH, TravelPreference.FOOD],
    description: 'Danh sách các sở thích du lịch để phục vụ gợi ý lịch trình',
    required: false,
  })
  @IsOptional()
  @IsArray()
  @IsEnum(TravelPreference, { each: true, message: 'Sở thích không hợp lệ' })
  travelPreferences?: TravelPreference[];
}
