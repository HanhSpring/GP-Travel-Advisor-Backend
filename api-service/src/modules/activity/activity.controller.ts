import {
  Body,
  Controller,
  Get,
  HttpCode,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiBody, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Roles } from '../../common/decorators/roles.decorator';
import { Role } from '../../common/enum/role.enum';
import { RolesGuard } from '../../common/guards/roles.guard';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { ActivityService, RecentSearchPlace } from './activity.service';
import { TrackActivityDto } from './dto/track-activity.dto';

@ApiTags('Activity')
@Controller('activity')
@ApiBearerAuth('access-token')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(Role.TOURIST)
export class ActivityController {
  constructor(private readonly activityService: ActivityService) {}

  @Post('track')
  @HttpCode(204)
  @ApiOperation({
    summary: 'Track a frontend user action',
    description:
      'Tracks tourist activity. A view is recorded only after the same tourist clicked the same place at least 2 seconds earlier. The first click after a successful search is attached to that search before the click log is inserted.',
  })
  @ApiBody({ type: TrackActivityDto })
  async track(@Req() req: any, @Body() dto: TrackActivityDto): Promise<void> {
    await this.activityService.log({
      tourist_id: req.user.userId,
      action_type: dto.action_type,
      place_id: dto.place_id ?? null,
    });
  }

  @Get('recent-searches')
  @ApiOperation({
    summary: 'Lấy danh sách địa điểm đã tìm kiếm gần đây của tourist',
  })
  async recentSearches(@Req() req: any): Promise<RecentSearchPlace[]> {
    return this.activityService.getRecentSearchPlaces(req.user.userId);
  }
}
