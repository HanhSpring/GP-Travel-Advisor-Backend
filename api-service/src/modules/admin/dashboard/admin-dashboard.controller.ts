import {
  Controller,
  Get,
  Header,
  ParseIntPipe,
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

  @Get('popular-places')
  @Header('Cache-Control', 'private, max-age=600')
  @ApiOperation({ summary: 'Lấy thống kê Top địa điểm phổ biến' })
  async getPopularPlaces(
    @Query('limit', new ParseIntPipe({ optional: true })) limit?: number,
  ) {
    const stats = await this.dashboardService.getPopularPlacesChart(limit);

    return {
      statusCode: 200,
      message: 'Lấy thống kê Top địa điểm thành công',
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
}
