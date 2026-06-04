import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsNotEmpty,
  IsEnum,
  IsString,
  IsDateString,
  IsInt,
  Min,
  Matches,
  IsOptional,
  IsNumber,
  IsArray,
} from 'class-validator';

// Định nghĩa các hằng số lựa chọn
export enum TripType {
  ROUND_TRIP = 'ROUND_TRIP', // Khứ hồi
  ONE_WAY = 'ONE_WAY', // Một chiều
}

export enum TransportMode {
  AIRPLANE = 'AIRPLANE', // Máy bay
  ROAD = 'ROAD', // Đường bộ
  WATERWAY = 'WATERWAY', // Đường thủy
}

// tripTheme enum giữ lại để không break import cũ (nếu có)
export enum TripTheme {
  EXPLORE = 'EXPLORE',
  RELAX = 'RELAX',
  FAMILY = 'FAMILY',
  CULTURE = 'CULTURE',
}

// Các giá trị hợp lệ cho tripIntent — phải khớp vocab model AI
export const TRIP_INTENT_OPTIONS = [
  'Khám phá tổng hợp',
  'Ẩm thực & Bản địa',
  'Đô thị & Vui chơi',
  'Khám phá & Sinh thái',
  'Nghỉ dưỡng & Biển',
  'Văn hóa & Lịch sử',
] as const;

// Định nghĩa Enum cho Ẩm thực (Khớp với các nút màu xanh/trắng)
export enum FoodPreference {
  LOCAL = 'LOCAL', // Đặc sản địa phương
  SEAFOOD = 'SEAFOOD', // Hải sản
  VEGETARIAN = 'VEGETARIAN', // Món chay
  STREET = 'STREET', // Đường phố
  FINE_DINING = 'FINE_DINING', // Nhà hàng cao cấp
}

export class CreateItineraryDto {
  @ApiProperty({ example: 'user-uuid', description: 'Supabase user ID' })
  @IsNotEmpty({ message: 'Vui lòng cung cấp userId' })
  @IsString()
  userId!: string;

  // --- DỮ LIỆU TỪ BƯỚC 1 ---

  @ApiProperty({
    enum: TripType,
    example: TripType.ROUND_TRIP,
    description: 'Loại chuyến đi',
  })
  @IsNotEmpty({ message: 'Vui lòng chọn loại chuyến đi' })
  @IsEnum(TripType)
  tripType!: TripType;

  @ApiProperty({
    example: 'SGN',
    description: 'Mã địa điểm khởi hành (VD: ID của TP.HCM)',
  })
  @IsNotEmpty({ message: 'Vui lòng chọn điểm khởi hành' })
  @IsString()
  departureLocationId!: string;

  @ApiProperty({
    example: 'HAN',
    description: 'Mã địa điểm đến (VD: ID của Hà Nội)',
  })
  @IsNotEmpty({ message: 'Vui lòng chọn điểm đến' })
  @IsString()
  destinationLocationId!: string;

  @ApiProperty({
    enum: TransportMode,
    example: TransportMode.AIRPLANE,
    description: 'Phương tiện di chuyển chính',
  })
  @IsNotEmpty({ message: 'Vui lòng chọn phương tiện di chuyển' })
  @IsEnum(TransportMode)
  transportMode!: TransportMode;

  // ==========================================
  // --- DỮ LIỆU TỪ BƯỚC 2 (Bổ sung mới) ---
  // ==========================================

  // 1. THỜI GIAN CHUYẾN ĐI
  @ApiProperty({
    example: '2024-06-15',
    description: 'Ngày bắt đầu (YYYY-MM-DD)',
  })
  @IsNotEmpty({ message: 'Vui lòng chọn ngày bắt đầu' })
  @IsDateString({}, { message: 'Định dạng ngày bắt đầu không hợp lệ' })
  startDate!: string;

  @ApiProperty({
    example: '2024-06-20',
    description: 'Ngày kết thúc (YYYY-MM-DD)',
  })
  @IsNotEmpty({ message: 'Vui lòng chọn ngày kết thúc' })
  @IsDateString({}, { message: 'Định dạng ngày kết thúc không hợp lệ' })
  endDate!: string;

  // 2. THỜI GIAN HOẠT ĐỘNG TRONG NGÀY
  // Lưu ý: FE đang hiển thị 07:00 AM, nhưng khi gửi xuống BE nên chuẩn hóa thành hệ 24h (07:00 và 23:00) để AI dễ tính toán.
  @ApiProperty({
    example: '07:00',
    description: 'Giờ bắt đầu hoạt động mỗi ngày (Hệ 24h: HH:mm)',
  })
  @IsNotEmpty({ message: 'Vui lòng chọn giờ bắt đầu' })
  @Matches(/^([0-1]?[0-9]|2[0-3]):[0-5][0-9]$/, {
    message: 'Giờ bắt đầu phải theo định dạng HH:mm',
  })
  dailyStartTime!: string;

  @ApiProperty({
    example: '23:00',
    description: 'Giờ kết thúc hoạt động mỗi ngày (Hệ 24h: HH:mm)',
  })
  @IsNotEmpty({ message: 'Vui lòng chọn giờ kết thúc' })
  @Matches(/^([0-1]?[0-9]|2[0-3]):[0-5][0-9]$/, {
    message: 'Giờ kết thúc phải theo định dạng HH:mm',
  })
  dailyEndTime!: string;

  // 3. MỤC ĐÍCH CHUYẾN ĐI (khớp vocab model AI)
  @ApiProperty({
    example: 'Khám phá tổng hợp',
    description: 'Mục đích chuyến đi — phải khớp vocab model AI',
    enum: TRIP_INTENT_OPTIONS,
  })
  @IsNotEmpty({ message: 'Vui lòng chọn mục đích chuyến đi' })
  @IsString()
  tripIntent!: string;

  // 4. SỐ LƯỢNG THÀNH VIÊN
  @ApiProperty({ example: 2, description: 'Số lượng người lớn (Tối thiểu 1)' })
  @IsNotEmpty()
  @IsInt()
  @Min(1, { message: 'Chuyến đi phải có ít nhất 1 người lớn' })
  adultCount!: number;

  @ApiProperty({ example: 1, description: 'Số lượng trẻ em (Có thể bằng 0)' })
  @IsOptional() // Dùng IsOptional vì có chuyến đi không có trẻ em
  @IsInt()
  @Min(0, { message: 'Số lượng trẻ em không được âm' })
  childCount!: number;

  // ==========================================
  // --- BƯỚC 3: SỞ THÍCH & NGÂN SÁCH (MỚI) ---
  // ==========================================

  // 1. NGÂN SÁCH
  @ApiProperty({
    example: 7500000,
    description: 'Mức ngân sách tối đa dự kiến (VND)',
  })
  @IsNotEmpty({ message: 'Vui lòng xác định mức ngân sách' })
  @IsNumber({}, { message: 'Ngân sách phải là một số' })
  @Min(0, { message: 'Ngân sách không hợp lệ' })
  budget!: number;

  // 2. SỞ THÍCH ẨM THỰC (Cố định)
  @ApiProperty({
    enum: FoodPreference,
    isArray: true,
    example: [FoodPreference.LOCAL, FoodPreference.VEGETARIAN],
    description: 'Các thẻ sở thích ẩm thực có sẵn do hệ thống cung cấp',
  })
  @IsOptional()
  @IsArray()
  @IsEnum(FoodPreference, {
    each: true,
    message: 'Sở thích ẩm thực không hợp lệ',
  })
  foodPreferences?: FoodPreference[];

  // 3. SỞ THÍCH ẨM THỰC (Tự nhập - Nút "Thêm mới")
  @ApiPropertyOptional({
    example: ['Không ăn cay', 'Thích đồ ngọt'],
    description: 'Người dùng tự nhập thêm các yêu cầu đặc biệt về ăn uống',
  })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  customFoodPreferences?: string[];
}
