import {
  Controller,
  Get,
  Post,
  Patch,
  Body,
  HttpCode,
  HttpStatus,
  UseGuards,
  Req,
  Query,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiBearerAuth,
  ApiConsumes,
  ApiBody,
} from '@nestjs/swagger';
import { AuthGuard } from '@nestjs/passport';
import { BusinessProfileDto } from '../business/dto/business-profile.dto';
import { BusinessService } from './business.service';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { Roles } from '../../common/decorators/roles.decorator';
import { Role } from '../../common/enum/role.enum';
import { GetToken } from 'src/common/decorators/get-token.decorator';
import { VendorDto, PlaceDto, OrderDto } from './dto/business-query.dto';
import {
  DashboardDto,
  PlaceItemDto,
  OrderItemDto,
} from './dto/business-response.dto';
import { CreateFullPlaceDto } from './dto/create-full-place.dto';
import { FileInterceptor } from '@nestjs/platform-express';

@ApiTags('Business')
@Controller('business')
@ApiBearerAuth('access-token')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(Role.BUSINESS)
export class BusinessController {
  constructor(private readonly businessService: BusinessService) {}

  @Get('vendor-places')
  @ApiOperation({ summary: 'Get places managed by vendor (legacy)' })
  @ApiResponse({ type: [PlaceItemDto] })
  getVendorPlaces(@Query() query: VendorDto) {
    return this.businessService.getVendorPlaces(query.vendorId)
  }

  @Get('place-detail')
  getPlaceDetail(@Query() query: PlaceDto) {
    return this.businessService.getPlaceDetail(query.placeId)
  }

  @Get('orders')
  @ApiResponse({ type: [OrderItemDto] })
  getOrders(@Query() query: PlaceDto) {
    return this.businessService.getOrdersByPlace(query.placeId)
  }

  @Get('order-detail')
  getOrderDetail(@Query() query: OrderDto) {
    return this.businessService.getOrderDetail(query.orderId)
  }

  @Get('place-services')
  getPlaceServices(@Query() query: PlaceDto) {
    return this.businessService.getPlaceServices(query.placeId)
  }

  @Get('dashboard')
  @ApiResponse({ type: DashboardDto })
  getDashboard(@Query() query: VendorDto) {
    return this.businessService.getDashboard(query.vendorId)
  }

  @Post('add-new-place')
  @ApiOperation({ summary: 'Tạo địa điểm + services + menu Excel' })
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    type: CreateFullPlaceDto,
  })
  @UseInterceptors(FileInterceptor('file'))
  createFull(
    @Body() body: any,
    @UploadedFile() file: Express.Multer.File
  ) {

    const dto = {
      name: body.name,
      address: body.address,
      city: body.city,
      latitude: Number(body.latitude),
      longitude: Number(body.longitude),
      categories: this.parseFlexible(body.categories),
      services: this.parseFlexible(body.services)
    }

    return this.businessService.createFullPlace(dto, file)
  }

private parseFlexible(value: any) {
  if (!value) return []

  // 👉 nếu là array rồi
  if (Array.isArray(value)) return value

  // 👉 nếu là JSON string
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value)
      return Array.isArray(parsed) ? parsed : [parsed]
    } catch {
      // 👉 nếu chỉ là string đơn (Restaurant)
      return [value]
    }
  }

  return [value]
}
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
