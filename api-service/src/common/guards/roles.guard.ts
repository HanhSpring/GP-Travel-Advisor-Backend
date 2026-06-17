import { AppConfig } from '../../config/app.config';
import {
  Injectable,
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { createClient } from '@supabase/supabase-js';

@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private reflector: Reflector) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const requiredRoles = this.reflector.getAllAndOverride<string[]>('roles', [
      context.getHandler(),
      context.getClass(),
    ]);

    if (!requiredRoles) {
      return true;
    }

    const { user } = context.switchToHttp().getRequest();

    if (!user || !user.userId) {
      throw new UnauthorizedException(
        'Không tìm thấy thông tin xác thực người dùng',
      );
    }

    const supabaseAdmin = createClient(
      AppConfig.SUPABASE_URL,
      AppConfig.SUPABASE_KEY,
    );

    const { data: dbUser, error } = await supabaseAdmin
      .from('users')
      .select('role, is_active, is_deleted')
      .eq('id', user.userId)
      .single();

    if (error || !dbUser || dbUser.is_deleted === '1') {
      throw new ForbiddenException(
        'Tài khoản không tồn tại hoặc đã bị xóa khỏi hệ thống',
      );
    }

    if (dbUser.is_active === '0') {
      throw new ForbiddenException(
        'Tài khoản của bạn hiện đang bị khóa. Vui lòng liên hệ Admin.',
      );
    }

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

    user.role = dbUser.role;

    return true;
  }
}
