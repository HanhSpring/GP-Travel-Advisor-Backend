import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { ApiOperation, ApiParam, ApiQuery, ApiTags } from '@nestjs/swagger';
import { IncurredCostsService } from './incurred-costs.service';
import { CreateIncurredCostDto } from './dto/create-incurred-cost.dto';
import { UpdateIncurredCostDto } from './dto/update-incurred-cost.dto';

@ApiTags('Itinerary — Chi phí phát sinh')
@Controller('itinerary/:id/incurred-costs')
export class IncurredCostsController {
  constructor(private readonly service: IncurredCostsService) {}

  @Get()
  @ApiOperation({ summary: 'Danh sách chi phí phát sinh của lịch trình' })
  @ApiParam({ name: 'id', description: 'ID lịch trình' })
  @ApiQuery({ name: 'user_id', required: true })
  @ApiQuery({ name: 'place_id', required: false })
  @ApiQuery({ name: 'filter_user_id', required: false })
  list(
    @Param('id') itineraryId: string,
    @Query('user_id') userId: string,
    @Query('place_id') placeId?: string,
    @Query('filter_user_id') filterUserId?: string,
  ) {
    return this.service.listIncurredCosts(itineraryId, userId, {
      placeId,
      userId: filterUserId,
    });
  }

  @Get('eligible-places')
  @ApiOperation({
    summary:
      'Danh sách địa điểm đã đi (visited) trong lịch trình — dùng cho combobox chọn địa điểm',
  })
  @ApiParam({ name: 'id', description: 'ID lịch trình' })
  @ApiQuery({ name: 'user_id', required: true })
  getEligiblePlaces(
    @Param('id') itineraryId: string,
    @Query('user_id') userId: string,
  ) {
    return this.service.getEligiblePlaces(itineraryId, userId);
  }

  @Get('breakdown')
  @ApiOperation({
    summary: 'Tổng hợp "mỗi người phải trả tổng bao nhiêu" (mục 1.7)',
  })
  @ApiParam({ name: 'id', description: 'ID lịch trình' })
  getBreakdown(@Param('id') itineraryId: string) {
    return this.service.computeCostBreakdown(itineraryId);
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Ghi nhận 1 khoản chi phí phát sinh' })
  @ApiParam({ name: 'id', description: 'ID lịch trình' })
  create(
    @Param('id') itineraryId: string,
    @Body() dto: CreateIncurredCostDto,
  ) {
    return this.service.createIncurredCost(itineraryId, dto);
  }

  @Patch(':costId')
  @ApiOperation({ summary: 'Sửa 1 khoản chi phí phát sinh' })
  @ApiParam({ name: 'id', description: 'ID lịch trình' })
  @ApiParam({ name: 'costId', description: 'ID khoản chi phí' })
  update(
    @Param('id') itineraryId: string,
    @Param('costId') costId: string,
    @Body() dto: UpdateIncurredCostDto,
  ) {
    return this.service.updateIncurredCost(itineraryId, costId, dto);
  }

  @Delete(':costId')
  @ApiOperation({ summary: 'Xoá 1 khoản chi phí phát sinh' })
  @ApiParam({ name: 'id', description: 'ID lịch trình' })
  @ApiParam({ name: 'costId', description: 'ID khoản chi phí' })
  @ApiQuery({ name: 'user_id', required: true })
  remove(
    @Param('id') itineraryId: string,
    @Param('costId') costId: string,
    @Query('user_id') userId: string,
  ) {
    return this.service.deleteIncurredCost(itineraryId, costId, userId);
  }
}
