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

@Injectable()
export class AuthService {
  // Logic kết nối Supabase sẽ viết ở đây sau
  private supabase: SupabaseClient;

  constructor() {
    const supabaseUrl = process.env.SUPABASE_URL;
    const supabaseKey = process.env.SUPABASE_KEY;
    if (!supabaseUrl || !supabaseKey) {
      throw new Error('Missing Supabase URL or Anon Key');
    }
    this.supabase = createClient(supabaseUrl, supabaseKey);
  }

  async registerTourist(registerDto: RegisterTouristDto) {
    const { email, password, fullName, gender, phoneNumber } = registerDto;

    // Gọi API của Supabase để tạo user
    const { data, error } = await this.supabase.auth.signUp({
      email: email,
      password: password,
      options: {
        // Dữ liệu trong 'data' sẽ được lưu vào cột raw_user_meta_data ở bảng auth.users
        data: {
          full_name: fullName,
          gender: gender,
          phone_number: phoneNumber,
          role: 'TOURIST', // Đánh dấu role để Trigger nhận diện và insert đúng bảng
        },
      },
    });

    // Xử lý nếu Supabase báo lỗi (ví dụ: email đã tồn tại, mật khẩu quá yếu...)
    if (error) {
      throw new BadRequestException(`Đăng ký thất bại: ${error.message}`);
    }

    // Nếu tạo thành công
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

    // 1. Kiểm tra xem input là Email hay Số điện thoại bằng Regex cơ bản
    const isEmail = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(emailOrPhone);

    // 2. Tạo object chứa thông tin đăng nhập phù hợp với Supabase
    const credentials = isEmail
      ? { email: emailOrPhone, password }
      : { phone: emailOrPhone, password };

    console.log(credentials);

    // 3. Gọi hàm xác thực có sẵn của Supabase
    const { data, error } =
      await this.supabase.auth.signInWithPassword(credentials);

    // 4. Xử lý kết quả trả về
    if (error) {
      // Supabase sẽ tự động báo lỗi nếu sai mật khẩu hoặc user không tồn tại
      throw new UnauthorizedException(`Đăng nhập thất bại: ${error.message}`);
    }

    if (!data.session) {
      throw new InternalServerErrorException(
        'Không thể khởi tạo phiên đăng nhập.',
      );
    }

    // 5. Trả về Access Token (JWT) do Supabase tự động sinh ra và thông tin User
    return {
      message: 'Đăng nhập thành công',
      accessToken: data.session.access_token,
      refreshToken: data.session.refresh_token,
      user: {
        id: data.user.id,
        email: data.user.email,

        // Role có thể được lấy từ user_metadata nếu bạn lưu role lúc đăng ký
        role: data.user.user_metadata?.role || 'TOURIST',
        phone: data.user.phone || data.user.user_metadata?.phone_number || '',
        fullName: data.user.user_metadata?.full_name || '',
        gender: data.user.user_metadata?.gender || '',
      },
    };
  }

  async registerBusiness(registerDto: RegisterBusinessDto) {
    const { email, password, fullName, phone, agreeToTerms } = registerDto;

    // Kiểm tra xem user có đồng ý điều khoản không (Dù FE đã chặn nhưng BE vẫn nên check lại)
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
}
