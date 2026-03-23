import { createParamDecorator, ExecutionContext } from '@nestjs/common';

export const GetToken = createParamDecorator(
  (data: unknown, ctx: ExecutionContext) => {
    const request = ctx.switchToHttp().getRequest();
    const authHeader = request.headers.authorization;
    // Trích xuất chuỗi sau chữ "Bearer "
    return authHeader ? authHeader.split(' ')[1] : null;
  },
);
