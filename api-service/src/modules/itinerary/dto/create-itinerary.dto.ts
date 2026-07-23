import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
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
  MaxLength,
  IsBoolean,
  ValidateNested,
} from 'class-validator';

// Kết quả wizard phân bổ vùng (region-allocation) — mỗi vùng người dùng
// xác nhận kèm số ngày họ chọn dành cho vùng đó.
export class RegionAllocationDto {
  @ApiProperty({ example: ['place-uuid-1', 'place-uuid-2'] })
  @IsArray()
  @IsString({ each: true })
  placeIds!: string[];

  @ApiProperty({ example: 2, description: 'Số ngày người dùng chọn cho vùng này' })
  @IsInt()
  @Min(0)
  days!: number;
}

// Định nghĩa các hằng số lựa chọn
export enum TripType {
  ROUND_TRIP = 'ROUND_TRIP', // Khứ hồi
  ONE_WAY = 'ONE_WAY', // Một chiều
}

export enum TransportMode {
  AIRPLANE = 'AIRPLANE', // Máy bay
  ROAD = 'ROAD', // Đường bộ
  WATERWAY = 'WATERWAY', // Đường thủy
  CAR = 'CAR',
  MOTORBIKE = 'MOTORBIKE',
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
    example: TransportMode.CAR,
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

  // 1b. XÁC NHẬN TIẾP TỤC DÙ VƯỢT NGÂN SÁCH ĐỀ XUẤT
  // Gửi lại true sau khi client đã hiển thị cảnh báo BUDGET_CONFIRMATION_REQUIRED
  // và người dùng chọn "Tiếp tục với ngân sách hiện tại" thay vì tăng ngân sách.
  @ApiPropertyOptional({
    example: false,
    description:
      'Xác nhận tiếp tục dù lịch trình vượt ngân sách đề xuất (sau khi đã nhận cảnh báo BUDGET_CONFIRMATION_REQUIRED)',
  })
  @IsOptional()
  @IsBoolean({ message: 'proceedWithOverBudget phải là true/false' })
  proceedWithOverBudget?: boolean;

  // 1b-2. TOKEN XÁC NHẬN NGÂN SÁCH (từ lỗi BUDGET_CONFIRMATION_REQUIRED)
  // Gửi lại đúng token nhận được ở response 422 trước đó — nếu hợp lệ,
  // backend dùng thẳng plan đã tính sẵn (cache tạm), bỏ qua chạy lại toàn
  // bộ thuật toán lập lịch trình.
  @ApiPropertyOptional({
    example: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
    description:
      'Token nhận từ lỗi BUDGET_CONFIRMATION_REQUIRED — nếu gửi kèm, backend dùng thẳng plan đã tính sẵn, bỏ qua chạy lại thuật toán.',
  })
  @IsOptional()
  @IsString()
  confirmToken?: string;

  // 1c. KẾT QUẢ WIZARD PHÂN BỔ VÙNG (REGION_ALLOCATION_REQUIRED)
  // Gửi lại sau khi client đã hiển thị màn hình phân bổ vùng và người dùng
  // đã chốt số ngày cho từng vùng qua stepper. Vùng có days=0 (hoặc không
  // có trong mảng này) sẽ bị loại khỏi lịch trình. Không có trường này ở
  // lần gọi đầu tiên — backend sẽ luôn trả về REGION_ALLOCATION_REQUIRED.
  @ApiPropertyOptional({
    type: [RegionAllocationDto],
    description:
      'Số ngày người dùng chọn cho từng vùng địa lý đã phát hiện (sau khi nhận REGION_ALLOCATION_REQUIRED)',
  })
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => RegionAllocationDto)
  regionAllocations?: RegionAllocationDto[];

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

  // ════════════════════════════════════════════════════════════════
  // [TRIP_NAME_INPUT] Tên chuyến đi do user nhập ở Bước 3
  // Lưu vào cột `description` trong travel.itineraries
  // ════════════════════════════════════════════════════════════════
  @ApiPropertyOptional({
    example: 'Khám phá Đà Nẵng • 10–13/06',
    description:
      'Tên chuyến đi (tùy chọn). Nếu không truyền, cột description sẽ là null.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  description?: string;

}
