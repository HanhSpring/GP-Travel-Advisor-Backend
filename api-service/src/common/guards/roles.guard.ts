import {
  Injectable,
  CanActivate,
  ExecutionContext,
  ForbiddenException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';

@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    // 1. Lấy danh sách Roles yêu cầu từ Decorator @Roles()
    const requiredRoles = this.reflector.getAllAndOverride<string[]>('roles', [
      context.getHandler(),
      context.getClass(),
    ]);

    // Nếu API không yêu cầu Role cụ thể nào, cho phép truy cập (Public API hoặc chỉ cần Login)
    if (!requiredRoles) {
      return true;
    }

    // 2. Lấy User từ Request (đã được JwtAuthGuard điền vào trước đó)
    const { user } = context.switchToHttp().getRequest();

    // 3. Kiểm tra logic phân quyền
    if (!user || !user.role) {
      throw new ForbiddenException(
        'Bạn không có quyền truy cập tính năng này (Thiếu Role)',
      );
    }

    const hasRole = requiredRoles.some(
      (role) => role.toLowerCase() === user.role.toLowerCase(),
    );

    if (!hasRole) {
      console.log(
        `Access Denied: User Role [${user.role}] không nằm trong [${requiredRoles}]`,
      );
      throw new ForbiddenException(
        'Bạn không có quyền thực hiện hành động này',
      );
    }

    return true;
  }
}
