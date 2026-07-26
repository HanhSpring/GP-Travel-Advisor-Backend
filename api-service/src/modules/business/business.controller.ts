import {
  Controller,
  Delete,
  Get,
  Post,
  Put,
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
import { UpdateOrderStatusDto } from './dto/update-order-status.dto';
import {
  DashboardDto,
  PlaceItemDto,
  OrderItemDto,
} from './dto/business-response.dto';
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

  @Get('vendor-places')
  @ApiOperation({ summary: 'Get places managed by vendor (legacy)' })
  @ApiResponse({ type: [PlaceItemDto] })
  getVendorPlaces(@Query() query: VendorDto) {
    return this.businessService.getVendorPlaces(query.vendorId);
  }

  @Get('place-detail')
  getPlaceDetail(@Query() query: PlaceDto, @Req() req: any) {
    return this.businessService.getPlaceDetail(query.placeId, req.user.userId);
  }

  @Put('place-detail')
  updatePlaceDetail(@Body() body: any, @Req() req: any) {
    return this.businessService.updatePlaceDetail(
      body.placeId || body.id,
      req.user.userId,
      body,
    );
  }

  @Delete('place-detail')
  deletePlaceDetail(@Body() body: any, @Query() query: any) {
    return this.businessService.deletePlaceDetail(
      body.placeId || body.id || query.placeId || query.id,
      body.vendorId || body.vendor_id || query.vendorId || query.vendor_id,
    );
  }

  @Get('orders')
  @ApiResponse({ type: [OrderItemDto] })
  getOrders(@Query() query: PlaceDto) {
    return this.businessService.getOrdersByPlace(query.placeId);
  }

  @Get('order-detail')
  getOrderDetail(@Query() query: OrderDto, @Req() req: any) {
    return this.businessService.getOrderDetail(query.orderId, req.user.userId);
  }

  @Get('place-services')
  getPlaceServices(@Query() query: PlaceDto) {
    return this.businessService.getPlaceServices(query.placeId);
  }

  @Get('place-services-by-type')
  @ApiOperation({
    summary: 'Lấy dịch vụ của địa điểm theo loại (miễn phí/trả phí)',
  })
  getPlaceServicesByType(@Query() query: PlaceDto, @Req() req: any) {
    return this.businessService.getPlaceServicesByType(query.placeId, req.user.userId);
  }

  @Get('dashboard')
  @ApiResponse({ type: DashboardDto })
  getDashboard(@Query() query: VendorDto, @Req() req: any) {
    return this.businessService.getDashboard(query.vendorId || req.user.userId);
  }

  @Post('add-new-place')
  @ApiOperation({ summary: 'Tạo địa điểm + services + menu Excel' })
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    type: CreateFullPlaceDto,
  })
  @UseInterceptors(FileInterceptor('file'))
  async createFull(
    @Body() body: any,
    @UploadedFile() file?: Express.Multer.File,
  ) {
    // Support both old format (name, address, etc) and new format (p_name, p_address, etc)
    const name = body.p_name || body.name;
    const address = body.p_address || body.address;
    const city = body.p_city || body.city;
    const latitude = body.p_lat !== undefined ? body.p_lat : body.latitude;
    const longitude = body.p_lng !== undefined ? body.p_lng : body.longitude;

    const dto = {
      name,
      address,
      city,
      latitude: Number(latitude),
      longitude: Number(longitude),
      vendorId: body.p_vendor_id || body.vendorId || '',
      email: body.p_email || body.email || '',
      phone: body.p_phone || body.phone || '',
      typeId: body.p_type_id || body.typeId || '',
      typeName: body.p_type_name || body.typeName || '',
      categories: this.parseFlexible(body.p_categories || body.categories),
      services: this.parseFlexible(body.p_services || body.services),
      menu: this.parseFlexible(body.p_food_items || body.p_menu || body.menu),
      rooms: this.parseFlexible(body.p_rooms || body.rooms),
      p_catalog_mode: body.p_catalog_mode || body.catalogMode,
      p_estimated_preparation_time:
        body.p_estimated_preparation_time ?? body.estimated_preparation_time,

      // 👉 BỔ SUNG CÁC DÒNG DƯỚI ĐÂY ĐỂ TRUYỀN DỮ LIỆU SANG SERVICE
      p_open_time: body.p_open_time || body.openTime,
      p_close_time: body.p_close_time || body.closeTime,
      p_open_hour_compressed:
        body.p_open_hour_compressed ||
        body.openHourCompressed ||
        body.open_hour_compressed,
      p_description: body.p_description || body.description,
      p_images: this.parseFlexible(body.p_images || body.images),
    };

    return this.businessService.createFullPlace(dto, file);
  }
  private parseFlexible(value: any) {
    if (!value) return [];

    // 👉 nếu là array rồi
    if (Array.isArray(value)) return value;

    // 👉 nếu là JSON string
    if (typeof value === 'string') {
      try {
        const parsed = JSON.parse(value);
        return Array.isArray(parsed) ? parsed : [parsed];
      } catch {
        // 👉 nếu chỉ là string đơn (Restaurant)
        return [value];
      }
    }

    return [value];
  }
  @Get('profile/me')
  @ApiOperation({ summary: 'Lấy thông tin hồ sơ đối tác' })
  async getMyProfile(@Req() req: any, @GetToken() token: string) {
    return this.businessService.getBusinessProfile(req.user.userId, token);
  }

  @Patch('profile/me')
  @Roles(Role.BUSINESS)
  @ApiBearerAuth('access-token')
  @ApiOperation({ summary: 'Cập nhật thông tin hồ sơ đối tác' })
  async updateMyProfile(
    @Req() req: any,
    @GetToken() token: string,
    @Body() updateDto: BusinessProfileDto,
  ) {
    const userId = req.user.userId;
    return this.businessService.updateProfile(userId, token, updateDto);
  }

  @Get('food-performance')
  @ApiOperation({ summary: 'Hiệu suất món ăn theo vendor' })
  getFoodPerformance(@Query() query: VendorDto, @Req() req: any) {
    return this.businessService.getFoodPerformance(
      query.vendorId || req.user.userId,
    );
  }

  @Put('update-order-status')
  @ApiOperation({ summary: 'Cập nhật trạng thái đơn hàng' })
  updateOrderStatus(@Body() dto: UpdateOrderStatusDto) {
    return this.businessService.updateOrderStatus(dto.orderId, dto.status);
  }

  @Get('orders/filter')
  @ApiResponse({ type: [OrderItemDto] })
  getFilteredOrders(@Query() query: GetOrdersDto, @Req() req: any) {
    return this.businessService.getFilteredOrdersForVendor(
      query,
      req.user.userId,
    );
  }

  // ── Menu item CRUD ──────────────────────────────────────────────────────────

  @Post('menu-item')
  @ApiOperation({ summary: 'Thêm dịch vụ (menu item) cho địa điểm' })
  addMenuItem(@Body() body: any, @Req() req: any) {
    return this.businessService.addSingleMenuItem(
      body.placeId,
      body.name,
      body.description ?? null,
      Number(body.price ?? 0),
      req.user.userId,
    );
  }

  @Put('menu-item')
  @ApiOperation({ summary: 'Cập nhật dịch vụ (menu item)' })
  updateMenuItem(@Body() body: any, @Req() req: any) {
    return this.businessService.updateSingleMenuItem(
      body.itemId ?? body.id,
      body.placeId,
      body.name,
      body.description ?? null,
      Number(body.price ?? 0),
      req.user.userId,
    );
  }

  @Delete('menu-item')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Xóa dịch vụ (menu item)' })
  deleteMenuItem(@Body() body: any, @Req() req: any) {
    return this.businessService.deleteSingleMenuItem(
      body.itemId ?? body.id,
      body.placeId,
      req.user.userId,
    );
  }

  // ── Free service CRUD ───────────────────────────────────────────────────────

  @Post('hotel-room')
  @ApiOperation({ summary: 'Them phong cho dia diem luu tru' })
  addHotelRoom(@Body() body: any, @Req() req: any) {
    return this.businessService.addSingleHotelRoom(
      body.placeId,
      body.name,
      Number(body.price ?? 0),
      Number(body.quantity ?? body.max_occupancy ?? 0),
      req.user.userId,
    );
  }

  @Put('hotel-room')
  @ApiOperation({ summary: 'Cap nhat phong luu tru' })
  updateHotelRoom(@Body() body: any, @Req() req: any) {
    return this.businessService.updateSingleHotelRoom(
      body.roomId ?? body.id,
      body.placeId,
      body.name,
      Number(body.price ?? 0),
      Number(body.quantity ?? body.max_occupancy ?? 0),
      req.user.userId,
    );
  }

  @Delete('hotel-room')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Xoa phong luu tru' })
  deleteHotelRoom(@Body() body: any, @Req() req: any) {
    return this.businessService.deleteSingleHotelRoom(
      body.roomId ?? body.id,
      body.placeId,
      req.user.userId,
    );
  }

  @Post('free-service')
  @ApiOperation({ summary: 'Thêm tiện ích miễn phí cho địa điểm' })
  addFreeService(@Body() body: any, @Req() req: any) {
    return this.businessService.addSingleFreeService(body.placeId, body.name, req.user.userId);
  }

  @Put('free-service')
  @ApiOperation({ summary: 'Cập nhật tiện ích miễn phí' })
  updateFreeService(@Body() body: any, @Req() req: any) {
    return this.businessService.updateSingleFreeService(
      body.placeId,
      body.serviceId ?? body.id,
      body.name,
      req.user.userId,
    );
  }

  @Delete('free-service')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Xóa tiện ích miễn phí' })
  deleteFreeService(@Body() body: any, @Req() req: any) {
    return this.businessService.deleteSingleFreeService(
      body.placeId,
      body.serviceId ?? body.id,
      req.user.userId,
    );
  }
}
