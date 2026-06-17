import { AppConfig } from '../../config/app.config';
import {
  Injectable,
  UnauthorizedException,
  InternalServerErrorException,
  BadRequestException,
} from '@nestjs/common';

import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { RegisterTouristDto } from './dto/register-tourist.dto';
import { LoginDto } from './dto/login.dto';
import { RegisterBusinessDto } from './dto/register-business.dto';
import { supabase } from 'src/config/supabase';
import { UpdatePasswordDto } from './dto/reset-password.dto';
import { ChangePasswordDto } from './dto/changePassword.dto';
import axios from 'axios';

@Injectable()
export class AuthService {
  private supabase: SupabaseClient;
  private supabaseAdmin: SupabaseClient;

  constructor() {
    const supabaseUrl = AppConfig.SUPABASE_URL.trim();
    const supabaseKey = AppConfig.SUPABASE_KEY.trim();

    if (!supabaseUrl || !supabaseKey) {
      const missing: string[] = [];
      if (!supabaseUrl) {
        missing.push('SUPABASE_URL');
      }
      if (!supabaseKey) {
        missing.push('SUPABASE_KEY');
      }
      throw new Error(`Missing Supabase env: ${missing.join(', ')}`);
    }

    this.supabase = createClient(supabaseUrl, supabaseKey, {
      auth: {
        autoRefreshToken: false,
        persistSession: false,
      },
    });

    this.supabaseAdmin = createClient(supabaseUrl, supabaseKey, {
      auth: {
        autoRefreshToken: false,
        persistSession: false,
      },
    });
  }

  async updatePassword(updateDto: UpdatePasswordDto) {
    const { accessToken, newPassword } = updateDto;

    const supabaseUrl = AppConfig.SUPABASE_URL.trim();
    const supabaseAnonKey = AppConfig.SUPABASE_KEY.trim();

    if (!supabaseUrl || !supabaseAnonKey) {
      throw new InternalServerErrorException(
        'Chưa cấu hình biến môi trường Supabase URL/KEY',
      );
    }

    try {
      const response = await axios.put(
        `${supabaseUrl}/auth/v1/user`,
        {
          password: newPassword,
        },
        {
          headers: {
            Authorization: `Bearer ${accessToken}`,
            apikey: supabaseAnonKey,
            'Content-Type': 'application/json',
          },
        },
      );

      return {
        success: true,
        message: 'Đổi mật khẩu thành công. Vui lòng đăng nhập lại.',
      };
    } catch (error: any) {
      console.error('Lỗi API Supabase:', error.response?.data || error.message);

      const errorMessage =
        error.response?.data?.msg ||
        'Mã xác thực không hợp lệ hoặc đã hết hạn.';
      throw new BadRequestException(`Đổi mật khẩu thất bại: ${errorMessage}`);
    }
  }
  async registerTourist(registerDto: RegisterTouristDto) {
    const { email, password, fullName, gender, phoneNumber } = registerDto;

    const { data, error } = await this.supabase.auth.signUp({
      email: email,
      password: password,
      options: {
        data: {
          full_name: fullName,
          gender: gender,
          phone_number: phoneNumber,
          role: 'TOURIST',
        },
      },
    });

    if (error) {
      throw new BadRequestException(`Đăng ký thất bại: ${error.message}`);
    }

    return {
      message: 'Đăng ký tài khoản du khách thành công',
      user: {
        id: data.user?.id,
        email: data.user?.email,
      },
    };
  }

  async login(loginDto: LoginDto) {
    const { emailOrPhone, password } = loginDto;

    const isEmail = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(emailOrPhone);
    let finalEmail = emailOrPhone;

    if (!isEmail) {
      const { data: userData, error: dbError } = await this.supabaseAdmin
        .from('users')
        .select('email')
        .eq('phone_number', emailOrPhone)
        .single();

      if (dbError || !userData) {
        throw new UnauthorizedException(
          'Không tìm thấy tài khoản với số điện thoại này',
        );
      }

      finalEmail = userData.email;
    }
    const credentials = {
      email: finalEmail,
      password: password,
    };

    console.log('Xác thực với credentials:', credentials);

    const { data, error } =
      await this.supabase.auth.signInWithPassword(credentials);

    if (error) {
      throw new UnauthorizedException(`Đăng nhập thất bại: ${error.message}`);
    }

    if (!data.session) {
      throw new InternalServerErrorException(
        'Không thể khởi tạo phiên đăng nhập.',
      );
    }

    return {
      message: 'Đăng nhập thành công',
      accessToken: data.session.access_token,
      refreshToken: data.session.refresh_token,
      user: {
        id: data.user.id,
        email: data.user.email,
        role: data.user.user_metadata?.role || 'TOURIST',
        phone: data.user.phone || data.user.user_metadata?.phone_number || '',
        fullName: data.user.user_metadata?.full_name || '',
        gender: data.user.user_metadata?.gender || '',
        avatar_url: data.user.user_metadata?.avatar_url || '',
      },
    };
  }

  async registerBusiness(registerDto: RegisterBusinessDto) {
    const { email, password, fullName, phone, agreeToTerms } = registerDto;

    if (!agreeToTerms) {
      throw new BadRequestException(
        'Bạn phải đồng ý với các điều khoản dịch vụ',
      );
    }

    const { data, error } = await supabase.auth.signUp({
      email: email,
      password: password,
      options: {
        data: {
          full_name: fullName,
          phone_number: phone,
          role: 'BUSINESS',
        },
      },
    });

    if (error) {
      throw new BadRequestException(
        `Đăng ký đối tác thất bại: ${error.message}`,
      );
    }

    return {
      message: 'Đăng ký tài khoản đối tác thành công. Đang chờ duyệt hồ sơ.',
      user: {
        id: data.user?.id,
        email: data.user?.email,
      },
    };
  }

  async forgotPassword(email: string, returnUrl?: string) {
    const redirectTo = returnUrl || 'http://localhost:5173/reset-password';
    const { data, error } = await supabase.auth.resetPasswordForEmail(email, {
      redirectTo: redirectTo,
    });

    if (error) {
      throw new BadRequestException(
        `Không thể gửi email khôi phục: ${error.message}`,
      );
    }

    return {
      message: 'Vui lòng kiểm tra hộp thư email để nhận liên kết khôi phục.',
    };
  }

  async updateUserMetadata(userId: string, metadata: any) {
    const { data, error } = await this.supabaseAdmin.auth.admin.updateUserById(
      userId,
      { user_metadata: metadata },
    );

    if (error) {
      throw new InternalServerErrorException(
        `Không thể cập nhật metadata: ${error.message}`,
      );
    }
    return data;
  }

  async syncOAuthData(
    userId: string,
    email: string,
    fullName: string,
    role: string,
  ) {
    await this.updateUserMetadata(userId, { role });
    const finalFullName = fullName || 'Người dùng Google';

    await this.updateUserMetadata(userId, {
      role,
      full_name: finalFullName,
    });

    const { error: userError } = await this.supabaseAdmin.from('users').upsert(
      {
        id: userId,
        email: email,
        full_name: finalFullName,
        role: role,
      },
      { onConflict: 'id' },
    );

    if (userError) {
      throw new InternalServerErrorException(
        'Lỗi đồng bộ users: ' + userError.message,
      );
    }

    if (role === 'BUSINESS') {
      await this.supabaseAdmin.from('tourists').delete().eq('id', userId);
      const { error: businessError } = await this.supabaseAdmin
        .from('businesses')
        .upsert(
          {
            id: userId,
            is_approved: false,
          },
          { onConflict: 'id' },
        );

      if (businessError) {
        console.error('Lỗi tạo hồ sơ Business:', businessError);
        throw new InternalServerErrorException(
          'Lỗi tạo hồ sơ Business trong DB',
        );
      }
    } else if (role === 'TOURIST') {
      await this.supabaseAdmin.from('businesses').delete().eq('id', userId);

      await this.supabaseAdmin
        .from('tourists')
        .upsert({ id: userId }, { onConflict: 'id' });
    }
  }

  async changePassword(
    accessToken: string,
    changePasswordDto: ChangePasswordDto,
  ) {
    const { currentPassword, newPassword } = changePasswordDto;

    const {
      data: { user },
      error: userError,
    } = await this.supabase.auth.getUser(accessToken);

    if (userError || !user) {
      throw new UnauthorizedException(
        'Mã xác thực không hợp lệ hoặc đã hết hạn.',
      );
    }

    if (!user.email) {
      throw new BadRequestException('Tài khoản không có email để xác thực.');
    }

    const { error: signInError } = await this.supabase.auth.signInWithPassword({
      email: user.email,
      password: currentPassword,
    });

    if (signInError) {
      throw new BadRequestException('Mật khẩu hiện tại không chính xác.');
    }

    const { error: updateError } =
      await this.supabaseAdmin.auth.admin.updateUserById(user.id, {
        password: newPassword,
      });

    if (updateError) {
      throw new InternalServerErrorException(
        `Lỗi hệ thống khi cập nhật mật khẩu: ${updateError.message}`,
      );
    }

    return {
      success: true,
      message: 'Cập nhật mật khẩu thành công.',
    };
  }
}
