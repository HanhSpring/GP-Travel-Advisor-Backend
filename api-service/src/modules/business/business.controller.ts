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
import { DashboardDto, PlaceItemDto, OrderItemDto } from './dto/business-response.dto';
import { CreateFullPlaceDto } from './dto/create-full-place.dto';
import { FileInterceptor } from '@nestjs/platform-express';
import { GetOrdersDto } from './dto/get-orders.dto';


@ApiTags('Business')
@Controller('business')
@ApiBearerAuth('access-token')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(Role.BUSINESS)
export class BusinessController {
  constructor(private readonly businessService: BusinessService) {}

  @Get('places')
  @ApiOperation({ summary: 'Get places managed by vendor' })
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

  @Get('place-services-by-type')
  @ApiOperation({ summary: 'Lấy dịch vụ của địa điểm theo loại (miễn phí/trả phí)' })
  getPlaceServicesByType(@Query() query: PlaceDto) {
    return this.businessService.getPlaceServicesByType(query.placeId)
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
    type: CreateFullPlaceDto
  })
  @UseInterceptors(FileInterceptor('file'))
  async createFull(
    @Body() body: any,
    @UploadedFile() file?: Express.Multer.File
  ) {
    // Support both old format (name, address, etc) and new format (p_name, p_address, etc)
    const name = body.p_name || body.name
    const address = body.p_address || body.address
    const city = body.p_city || body.city
    const latitude = body.p_lat !== undefined ? body.p_lat : body.latitude
    const longitude = body.p_lng !== undefined ? body.p_lng : body.longitude
    
    const dto = {
      name,
      address,
      city,
      latitude: Number(latitude),
      longitude: Number(longitude),
      categories: this.parseFlexible(body.p_categories || body.categories),
      services: this.parseFlexible(body.p_services || body.services),
      menu: this.parseFlexible(body.p_menu || body.menu)
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

  @Get('orders/filter')
  @ApiResponse({ type: [OrderItemDto] })
  getFilteredOrders(@Query() query: GetOrdersDto) {
    return this.businessService.getFilteredOrders(query);
  }
}
