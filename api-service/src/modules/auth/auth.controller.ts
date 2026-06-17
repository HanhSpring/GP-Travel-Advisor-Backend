import {
  Controller,
  Post,
  Get,
  Body,
  HttpCode,
  HttpStatus,
  BadRequestException,
  Request,
  UseGuards,
  Headers,
  Put,
  UnauthorizedException,
} from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiBearerAuth,
} from '@nestjs/swagger';
import { AuthService } from './auth.service';
import { LoginDto } from './dto/login.dto';
import { UpdatePasswordDto } from './dto/reset-password.dto';
import { RegisterBusinessDto } from './dto/register-business.dto';
import { RegisterTouristDto } from './dto/register-tourist.dto';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RolesGuard } from 'src/common/guards/roles.guard';
import { ChangePasswordDto } from './dto/changePassword.dto';
@ApiTags('Auth')
@Controller('auth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  // Login
  @Post('login')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Đăng nhập hệ thống (Dùng chung cho cả 3 Role)' })
  @ApiResponse({
    status: 200,
    description: 'Đăng nhập thành công, trả về Access Token và Role',
  })
  @ApiResponse({ status: 401, description: 'Sai email hoặc mật khẩu' })
  async login(@Body() loginDto: LoginDto) {
    return await this.authService.login(loginDto);
  }

  @UseGuards(JwtAuthGuard)
  @Post('sync-oauth')
  @ApiOperation({
    summary: 'Đồng bộ data cho user đăng nhập qua OAuth lần đầu',
  })
  async syncOAuthUser(
    @Request() req,
    @Body('requestedRole') requestedRole: string,
  ) {
    const user = req.user;
    const fullNameFromMeta =
      user.user_metadata?.full_name || user.fullName || 'Người dùng Google';
    let targetRole = requestedRole || 'TOURIST';
    if (targetRole === 'ADMIN') {
      targetRole = 'TOURIST';
    }

    if (!user.role) {
      await this.authService.syncOAuthData(
        user.userId,
        user.email,
        fullNameFromMeta,
        targetRole,
      );

      return {
        message: `Khởi tạo tài khoản với quyền ${targetRole} thành công`,
        isNewUser: true,
        role: targetRole,
      };
    }

    return {
      message: 'User đã có đầy đủ thông tin',
      isNewUser: false,
      role: user.role,
    };
  }

  @Post('forgot-password')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Yêu cầu khôi phục mật khẩu (Gửi link về email)' })
  async forgotPassword(
    @Body('email') email: string,
    @Body('returnUrl') returnUrl?: string,
  ) {
    if (!email) {
      throw new BadRequestException('Vui lòng cung cấp địa chỉ email');
    }
    return this.authService.forgotPassword(email, returnUrl);
  }

  @Post('update-password')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Cập nhật mật khẩu mới (Sử dụng token từ email)' })
  async updatePassword(@Body() updatePasswordDto: UpdatePasswordDto) {
    return this.authService.updatePassword(updatePasswordDto);
  }

  @Post('register/tourist')
  @HttpCode(HttpStatus.CREATED)
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
    return await this.authService.registerBusiness(registerDto);
  }

  @Put('change-password')
  @ApiOperation({ summary: 'Đổi mật khẩu trong App (Cần mật khẩu hiện tại)' })
  @ApiBearerAuth()
  async changePassword(
    @Headers('Authorization') authHeader: string,
    @Body() changePasswordDto: ChangePasswordDto,
  ) {
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      throw new UnauthorizedException('Thiếu hoặc sai định dạng Access Token');
    }

    const accessToken = authHeader.split(' ')[1];

    return this.authService.changePassword(accessToken, changePasswordDto);
  }
}
