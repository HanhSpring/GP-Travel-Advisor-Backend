import {
  Injectable,
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  InternalServerErrorException,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { supabase } from '../../config/supabase';

@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private reflector: Reflector) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    // 1. Lấy danh sách Roles yêu cầu từ Decorator @Roles()
    const requiredRoles = this.reflector.getAllAndOverride<string[]>('roles', [
      context.getHandler(),
      context.getClass(),
    ]);

    // Nếu API không yêu cầu Role cụ thể, cho phép truy cập (chỉ cần JwtAuthGuard bảo vệ trước đó)
    if (!requiredRoles) {
      return true;
    }

    // 2. Lấy đối tượng User từ Request (được điền bởi JwtAuthGuard)
    const { user } = context.switchToHttp().getRequest();

    if (!user || !user.userId) {
      throw new UnauthorizedException(
        'Không tìm thấy thông tin xác thực người dùng',
      );
    }

    // 3. KẾT NỐI DATABASE ĐỂ KIỂM TRA THỜI GIAN THỰC (Real-time Security Check)
    // Việc này giúp xử lý lỗi thiếu Role ở Token Google và kiểm tra trạng thái Khóa/Xóa
    const { data: dbUser, error } = await supabase
      .from('users')
      .select('role, is_active')
      .eq('id', user.userId)
      .single();

    // 4. KIỂM TRA TÀI KHOẢN CÓ TỒN TẠI HOẶC BỊ XÓA KHÔNG
    if (error) {
      throw new InternalServerErrorException(
        `Khong the kiem tra quyen nguoi dung: ${error.message}`,
      );
    }

    if (!dbUser) {
      throw new ForbiddenException(
        'Tài khoản không tồn tại hoặc đã bị xóa khỏi hệ thống',
      );
    }

    // 5. KIỂM TRA TÀI KHOẢN CÓ ĐANG BỊ KHÓA KHÔNG
    const isActive =
      String(dbUser.is_active) === '1' || dbUser.is_active === true;
    if (!isActive) {
      throw new ForbiddenException(
        'Tài khoản của bạn hiện đang bị khóa. Vui lòng liên hệ Admin.',
      );
    }

    // 6. KIỂM TRA QUYỀN TRUY CẬP (ROLE)
    // Sử dụng dữ liệu từ Database (dbUser.role) thay vì Token để đảm bảo chính xác tuyệt đối
    const hasRole = requiredRoles.some(
      (role) => role.toUpperCase() === dbUser.role.toUpperCase(),
    );

    if (!hasRole) {
      console.warn(
        `Access Denied: User ID [${user.userId}] với Role [${dbUser.role}] cố gắng truy cập API yêu cầu [${requiredRoles}]`,
      );
      throw new ForbiddenException(
        'Bạn không có quyền thực hiện hành động này',
      );
    }

    // Cập nhật lại role vào đối tượng user trong request để các hàm service phía sau có thể dùng ngay
    user.role = dbUser.role;

    return true;
  }
}
