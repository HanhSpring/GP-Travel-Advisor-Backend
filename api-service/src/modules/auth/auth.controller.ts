import {
  Controller,
  Post,
  Get,
  Body,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse } from '@nestjs/swagger';
import { AuthService } from './auth.service';
import { LoginDto } from './dto/login.dto';
import { ForgotPasswordDto } from './dto/forgot-password.dto';
import { ResetPasswordDto } from './dto/reset-password.dto';
import { RegisterBusinessDto } from './dto/register-business.dto';
import { RegisterTouristDto } from './dto/register-tourist.dto';
// @ApiTags giúp gom tất cả API trong file này vào một thẻ tên là "Auth" trên Swagger
@ApiTags('Auth')
@Controller('auth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  // Login
  @Post('login')
  @HttpCode(HttpStatus.OK) // Mặc định NestJS trả về 201 cho POST, đổi thành 200 cho logic Login
  @ApiOperation({ summary: 'Đăng nhập hệ thống (Dùng chung cho cả 3 Role)' })
  @ApiResponse({
    status: 200,
    description: 'Đăng nhập thành công, trả về Access Token và Role',
  })
  @ApiResponse({ status: 401, description: 'Sai email hoặc mật khẩu' })
  async login(@Body() loginDto: LoginDto) {
    // Trả thẳng kết quả từ Service ra ngoài
    return await this.authService.login(loginDto);
  }

  // 2. API Đăng nhập bằng Google
  @Get('google') // Thường dùng phương thức GET cho luồng OAuth
  @ApiOperation({ summary: 'Chuyển hướng xác thực qua Google' })
  async loginGoogle() {
    return { message: 'Sẽ chuyển hướng sang màn hình đăng nhập Google' };
  }

  // 3. API Đăng nhập bằng Facebook
  @Get('facebook')
  @ApiOperation({ summary: 'Chuyển hướng xác thực qua Facebook' })
  async loginFacebook() {
    return { message: 'Sẽ chuyển hướng sang màn hình đăng nhập Facebook' };
  }

  @Post('forgot-password')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Yêu cầu khôi phục mật khẩu (Gửi mã OTP về email)' })
  @ApiResponse({
    status: 200,
    description: 'Đã gửi mã xác nhận đến email nếu tài khoản tồn tại',
  })
  forgotPassword(@Body() body: ForgotPasswordDto) {
    // Chỉ return giả định cho Frontend thấy response mẫu
    return {
      message: 'Nếu email tồn tại trong hệ thống, một mã OTP đã được gửi đi.',
      success: true,
    };
  }

  @Post('reset-password')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Cập nhật mật khẩu mới bằng mã OTP' })
  @ApiResponse({ status: 200, description: 'Đổi mật khẩu thành công' })
  @ApiResponse({ status: 400, description: 'Mã OTP sai hoặc đã hết hạn' })
  resetPassword(@Body() body: ResetPasswordDto) {
    return {
      message: 'Mật khẩu đã được cập nhật thành công.',
      success: true,
    };
  }

  @Post('register/tourist')
  @HttpCode(HttpStatus.CREATED) // Status 201 cho việc tạo resource thành công
  @ApiOperation({ summary: 'Đăng ký tài khoản dành cho Du khách' })
  @ApiResponse({
    status: 201,
    description: 'Đăng ký thành công, tự động lưu thông tin vào bảng tourists',
  })
  @ApiResponse({
    status: 400,
    description: 'Dữ liệu không hợp lệ hoặc Email đã tồn tại',
  })
  async registerTourist(@Body() registerDto: RegisterTouristDto) {
    return await this.authService.registerTourist(registerDto);
  }

  @Post('register/business')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Đăng ký tài khoản Đối tác dịch vụ (Business)' })
  @ApiResponse({
    status: 201,
    description:
      'Đăng ký thành công. Đang chờ xác thực email hoặc duyệt hồ sơ.',
  })
  @ApiResponse({
    status: 400,
    description: 'Dữ liệu đầu vào không hợp lệ (lỗi validate)',
  })
  @ApiResponse({
    status: 409,
    description: 'Email hoặc Số điện thoại đã tồn tại trong hệ thống',
  })
  async registerBusiness(@Body() registerDto: RegisterBusinessDto) {
    // Gọi xuống Service để xử lý thực tế
    return await this.authService.registerBusiness(registerDto);
  }
}
