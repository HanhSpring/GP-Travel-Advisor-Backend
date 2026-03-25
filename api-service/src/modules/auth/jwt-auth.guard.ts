import { Injectable, UnauthorizedException } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';

@Injectable()
export class JwtAuthGuard extends AuthGuard('jwt') {
  // Ghi đè hàm handleRequest để tùy chỉnh lỗi nếu cần
  handleRequest(err: any, user: any, info: any) {
    if (err || !user) {
      // Nếu có lỗi hoặc không giải mã được user từ token
      throw (
        err || new UnauthorizedException('Token không hợp lệ hoặc đã hết hạn')
      );
    }
    return user;
  }
}
