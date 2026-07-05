import {
  Controller,
  Get,
  Header,
  HttpCode,
  ParseIntPipe,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { DashboardService } from './admin-dashboard.service';
import { JwtAuthGuard } from '../../auth/jwt-auth.guard';
import { RolesGuard } from 'src/common/guards/roles.guard';
import { Roles } from 'src/common/decorators/roles.decorator';
import { Role } from 'src/common/enum/role.enum';

@ApiTags('Admin - Dashboard')
@Controller('admin/dashboard')
@ApiBearerAuth('access-token')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(Role.ADMIN)
export class DashboardController {
  constructor(private readonly dashboardService: DashboardService) {}

  @Get('stats')
  @Header('Cache-Control', 'private, max-age=120')
  @ApiOperation({
    summary:
      'Lấy tổng hợp thống kê dashboard (1 call thay cho 4 calls riêng lẻ)',
  })
  async getDashboardStats() {
    const data = await this.dashboardService.getDashboardStats();
    return {
      statusCode: 200,
      message: 'Lấy thống kê dashboard thành công',
      data,
    };
  }

  @Get('popular-places')
  @Header('Cache-Control', 'private, max-age=3600')
  @ApiOperation({ summary: 'Lấy thống kê Top/Flop địa điểm phổ biến' })
  async getPopularPlaces(
    @Query('limit', new ParseIntPipe({ optional: true })) limit?: number,
    @Query('mode') mode?: string,
    @Query('categoryName') categoryName?: string,
  ) {
    const validMode: 'top' | 'flop' = mode === 'flop' ? 'flop' : 'top';
    const stats = await this.dashboardService.getPopularPlacesChart(
      limit ?? 20,
      validMode,
      categoryName?.trim() || undefined,
    );

    return {
      statusCode: 200,
      message: 'Lấy thống kê địa điểm thành công',
      data: stats,
    };
  }

  @Get('chart')
  @Header('Cache-Control', 'private, max-age=300')
  @ApiOperation({ summary: 'Lấy dữ liệu biểu đồ người dùng hoạt động' })
  async getChartData(
    @Query('month', new ParseIntPipe({ optional: true })) month?: number,
    @Query('week', new ParseIntPipe({ optional: true })) week?: number,
  ) {
    const activityData = await this.dashboardService.getActiveUsersChart(
      month,
      week,
    );

    return {
      statusCode: 200,
      message: 'Lấy dữ liệu biểu đồ thành công',
      data: activityData,
    };
  }

  @Get('interactions')
  @Header('Cache-Control', 'private, max-age=300')
  @ApiOperation({
    summary: 'Lấy dữ liệu tính tương tác giữa lịch trình và user',
  })
  async getIteractions() {
    const data = await this.dashboardService.getUserInteractions();
    return {
      statusCode: 200,
      message: 'Lấy dữ liệu thánh công',
      data: data,
    };
  }

  @Post('refresh-cache')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Xóa toàn bộ cache dashboard để lấy dữ liệu mới nhất ngay lập tức',
    description:
      'Dùng khi cần đảm bảo dữ liệu mới nhất (vd: trước buổi demo), tránh phải chờ TTL cache hoặc restart backend',
  })
  refreshCache() {
    this.dashboardService.clearCache();
    return {
      statusCode: 200,
      message: 'Đã xóa cache dashboard, dữ liệu sẽ được tải mới ở lần gọi tiếp theo',
    };
  }
}
