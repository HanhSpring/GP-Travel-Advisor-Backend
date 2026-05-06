import { Body, Controller, HttpCode, Post } from '@nestjs/common';
import { ApiBody, ApiOperation, ApiTags } from '@nestjs/swagger';
import { ActivityService } from './activity.service';
import { TrackActivityDto } from './dto/track-activity.dto';

@ApiTags('Activity')
@Controller('activity')
export class ActivityController {
  constructor(private readonly activityService: ActivityService) {}

  @Post('track')
  @HttpCode(204)
  @ApiOperation({
    summary: 'Track a frontend user action',
    description:
      'Frontend gọi endpoint này để log các hành động: view_place (sau 2s dwell), search_click, save_place, unsave_place.',
  })
  @ApiBody({ type: TrackActivityDto })
  async track(@Body() dto: TrackActivityDto): Promise<void> {
    await this.activityService.log({
      tourist_id: dto.tourist_id,
      action_type: dto.action_type,
      place_id: dto.place_id ?? null,
    });
  }
}
