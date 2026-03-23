import {
  Controller,
  Get,
  Patch,
  Body,
  HttpCode,
  HttpStatus,
  UseGuards,
  Req,
  Query,
} from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiBearerAuth,
} from '@nestjs/swagger';
import { AuthGuard } from '@nestjs/passport';

import { BusinessProfileDto } from '../business/dto/business-profile.dto';
import { BusinessService } from './business.service';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { Roles } from '../../common/decorators/roles.decorator';
import { Role } from '../../common/enum/role.enum';
import { GetToken } from 'src/common/decorators/get-token.decorator';

@ApiTags('Business')
@Controller('business')
@ApiBearerAuth('access-token')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(Role.BUSINESS)
export class BusinessController {
  constructor(private readonly businessService: BusinessService) {}

  @Get('profile/me')
  @ApiOperation({ summary: 'Lấy thông tin hồ sơ đối tác' })
  async getMyProfile(@Req() req: any, @GetToken() token: string) {
    return this.businessService.getBusinessProfile(req.user.userId, token);
  }

  // src/modules/business/business.controller.ts

  @Patch('profile/me')
  @Roles(Role.BUSINESS)
  @ApiBearerAuth('bearer') // Đảm bảo khớp với ID trong main.ts của bạn
  @ApiOperation({ summary: 'Cập nhật thông tin hồ sơ đối tác' })
  async updateMyProfile(
    @Req() req: any,
    @GetToken() token: string,
    @Body() updateDto: BusinessProfileDto,
  ) {
    const userId = req.user.userId;
    return this.businessService.updateProfile(userId, token, updateDto);
  }
}
