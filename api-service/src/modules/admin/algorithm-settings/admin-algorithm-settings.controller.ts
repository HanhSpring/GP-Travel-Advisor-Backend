import {
  Body,
  Controller,
  Get,
  ParseIntPipe,
  Patch,
  Post,
  Query,
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
import { UpdateTwoTowerSettingsDto } from './dto/update-two-tower-settings.dto';

@ApiTags('Admin - Algorithm Settings')
@ApiBearerAuth('access-token')
@Controller('admin/algorithm-settings')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(Role.ADMIN)
export class AdminAlgorithmSettingsController {
  constructor(private readonly service: AdminAlgorithmSettingsService) {}

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
  ): Promise<TwoTowerSettingsDto> {
    return this.service.updateTwoTowerSettings(dto);
  }

  @Post('two-tower/reset')
  @ApiOperation({ summary: 'Reset Two Tower retrieval settings to defaults' })
  @ApiResponse({ status: 200, type: TwoTowerSettingsDto })
  resetTwoTowerSettings(): Promise<TwoTowerSettingsDto> {
    return this.service.resetTwoTowerSettings();
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
