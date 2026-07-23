import {
  Body,
  Controller,
  Get,
  ParseIntPipe,
  Patch,
  Post,
  Query,
  Request,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiQuery,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { Roles } from 'src/common/decorators/roles.decorator';
import { Role } from 'src/common/enum/role.enum';
import { RolesGuard } from 'src/common/guards/roles.guard';
import { JwtAuthGuard } from '../../auth/jwt-auth.guard';
import { AdminAlgorithmSettingsService } from './admin-algorithm-settings.service';
import {
  AlgorithmLogDto,
  TwoTowerSettingsDto,
} from './dto/two-tower-settings.dto';
import { ReviewFilterSettingsDto } from './dto/review-filter-settings.dto';
import { UpdateTwoTowerSettingsDto } from './dto/update-two-tower-settings.dto';
import { UpdateReviewFilterSettingsDto } from './dto/update-review-filter-settings.dto';

@ApiTags('Admin - Algorithm Settings')
@ApiBearerAuth('access-token')
@Controller('admin/algorithm-settings')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(Role.ADMIN)
export class AdminAlgorithmSettingsController {
  constructor(private readonly service: AdminAlgorithmSettingsService) {}

  @Get('statuses')
  @ApiOperation({ summary: 'Get algorithm active statuses' })
  getAlgorithmStatuses(): Promise<Record<string, boolean>> {
    return this.service.getAlgorithmStatuses();
  }

  @Get('review-filter')
  @ApiOperation({ summary: 'Get review filtering pipeline settings' })
  @ApiResponse({ status: 200, type: ReviewFilterSettingsDto })
  getReviewFilterSettings(): Promise<ReviewFilterSettingsDto> {
    return this.service.getReviewFilterSettings();
  }

  @Patch('review-filter')
  @ApiOperation({ summary: 'Update review filtering pipeline settings' })
  @ApiResponse({ status: 200, type: ReviewFilterSettingsDto })
  updateReviewFilterSettings(
    @Body() dto: UpdateReviewFilterSettingsDto,
    @Request() req: any,
  ): Promise<ReviewFilterSettingsDto> {
    return this.service.updateReviewFilterSettings(dto, req.user?.userId ?? null);
  }

  @Post('review-filter/reset')
  @ApiOperation({
    summary: 'Reset review filtering pipeline settings to defaults',
  })
  @ApiResponse({ status: 200, type: ReviewFilterSettingsDto })
  resetReviewFilterSettings(@Request() req: any): Promise<ReviewFilterSettingsDto> {
    return this.service.resetReviewFilterSettings(req.user?.userId ?? null);
  }

  @Get('two-tower')
  @ApiOperation({ summary: 'Get Two Tower retrieval settings' })
  @ApiResponse({ status: 200, type: TwoTowerSettingsDto })
  getTwoTowerSettings(): Promise<TwoTowerSettingsDto> {
    return this.service.getTwoTowerSettings();
  }

  @Patch('two-tower')
  @ApiOperation({ summary: 'Update Two Tower retrieval settings' })
  @ApiResponse({ status: 200, type: TwoTowerSettingsDto })
  updateTwoTowerSettings(
    @Body() dto: UpdateTwoTowerSettingsDto,
    @Request() req: any,
  ): Promise<TwoTowerSettingsDto> {
    return this.service.updateTwoTowerSettings(dto, req.user?.userId ?? null);
  }

  @Post('two-tower/reset')
  @ApiOperation({ summary: 'Reset Two Tower retrieval settings to defaults' })
  @ApiResponse({ status: 200, type: TwoTowerSettingsDto })
  resetTwoTowerSettings(@Request() req: any): Promise<TwoTowerSettingsDto> {
    return this.service.resetTwoTowerSettings(req.user?.userId ?? null);
  }

  @Get('two-tower/logs')
  @ApiOperation({ summary: 'Get Two Tower settings change logs' })
  @ApiQuery({ name: 'limit', required: false, example: 20 })
  @ApiResponse({ status: 200, type: [AlgorithmLogDto] })
  getTwoTowerLogs(
    @Query('limit', new ParseIntPipe({ optional: true })) limit = 20,
  ): Promise<AlgorithmLogDto[]> {
    return this.service.getTwoTowerLogs(limit);
  }
}
