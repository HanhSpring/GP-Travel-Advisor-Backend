import { Injectable } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { ActivityService } from './activity.service';
import type { ActivityLogPayload } from './activity.service';

export const ACTIVITY_LOG_EVENT = 'activity.log';

@Injectable()
export class ActivityListener {
  constructor(private readonly activityService: ActivityService) {}

  @OnEvent(ACTIVITY_LOG_EVENT, { async: true })
  async handleActivityLog(payload: ActivityLogPayload): Promise<void> {
    await this.activityService.log(payload);
  }
}
