import {
  Controller,
  Get,
  Patch,
  Body,
  HttpCode,
  HttpStatus,
  UseGuards,
  Req,
  UnauthorizedException,
} from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiBearerAuth,
} from '@nestjs/swagger';
import { AuthGuard } from '@nestjs/passport';
import { TouristProfileDto } from './dto/tourist-profile.dto';
import { ProfileService } from './profile.service';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { GetToken } from 'src/common/decorators/get-token.decorator';
import { RolesGuard } from 'src/common/guards/roles.guard';
import { Roles } from 'src/common/decorators/roles.decorator';
import { Role } from 'src/common/enum/role.enum';

@ApiTags('Profile')
@Controller('profile')
@ApiBearerAuth('access-token')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(Role.TOURIST)
export class ProfileController {
  constructor(private readonly profileService: ProfileService) {}

  @Get('tourist/me')
  async getMe(@Req() req: any, @GetToken() token: string) {
    return this.profileService.getTouristProfile(req.user.userId, token);
  }

  @Patch('tourist/me')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Cập nhật thông tin hồ sơ và sở thích du lịch' })
  async updateProfile(
    @Req() req: any,
    @GetToken() token: string,
    @Body() updateDto: TouristProfileDto,
  ) {
    const userId = req.user.userId;
    return this.profileService.updateTouristProfile(userId, token, updateDto);
  }
}
