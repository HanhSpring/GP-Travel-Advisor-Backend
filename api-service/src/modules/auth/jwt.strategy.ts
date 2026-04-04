import { Injectable } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { passportJwtSecret } from 'jwks-rsa';

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor() {
    super({
      // 1. Trích xuất Token từ Header
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,

      // 2. Cấu hình tự động lấy khóa từ Supabase (JWKS)
      secretOrKeyProvider: passportJwtSecret({
        cache: true,
        rateLimit: true,
        jwksRequestsPerMinute: 5,
        jwksUri: `https://marqtgjhtospwriwndar.supabase.co/auth/v1/.well-known/jwks.json`,
      }),
      algorithms: ['ES256'],
      audience: 'authenticated',
      issuer: `https://marqtgjhtospwriwndar.supabase.co/auth/v1`,
    });
  }

  async validate(payload: any) {
    return {
      userId: payload.sub,
      email: payload.email,
      role: payload.user_metadata?.role,
      user_metadata: payload.user_metadata,
      fullName:
        payload.user_metadata?.full_name || payload.user_metadata?.name || '',
    };
  }
}
