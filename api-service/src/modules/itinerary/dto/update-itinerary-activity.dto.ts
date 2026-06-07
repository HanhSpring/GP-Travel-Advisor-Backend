import { ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsBoolean,
  IsNumber,
  IsOptional,
  IsString,
  Matches,
  Min,
} from 'class-validator';

export class UpdateItineraryActivityDto {
  @ApiPropertyOptional({ example: '08:30', description: 'Giờ đến (HH:mm)' })
  @IsOptional()
  @Matches(/^([0-1]?[0-9]|2[0-3]):[0-5][0-9]$/, { message: 'arrivalTime phải theo định dạng HH:mm' })
  arrivalTime?: string;

  @ApiPropertyOptional({ example: '10:00', description: 'Giờ rời (HH:mm)' })
  @IsOptional()
  @Matches(/^([0-1]?[0-9]|2[0-3]):[0-5][0-9]$/, { message: 'departureTime phải theo định dạng HH:mm' })
  departureTime?: string;

  @ApiPropertyOptional({ example: 120000, description: 'Chi phí thực tế (VND)' })
  @IsOptional()
  @IsNumber()
  @Min(0)
  actualCost?: number;

  @ApiPropertyOptional({ example: 'Cần đến sớm hơn', description: 'Ghi chú cá nhân' })
  @IsOptional()
  @IsString()
  userNotes?: string;

  @ApiPropertyOptional({ example: false, description: 'Khóa hoạt động' })
  @IsOptional()
  @IsBoolean()
  isLocked?: boolean;

  @ApiPropertyOptional({ example: '08:30', description: 'Giờ đến bị khóa (HH:mm)' })
  @IsOptional()
  @Matches(/^([0-1]?[0-9]|2[0-3]):[0-5][0-9]$/, { message: 'lockedArriveTime phải theo định dạng HH:mm' })
  lockedArriveTime?: string;
}
