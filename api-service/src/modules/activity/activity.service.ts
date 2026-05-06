import { Injectable } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { supabase } from '../../config/supabase';

export interface ActivityLogPayload {
  tourist_id: string;
  action_type: string;
  place_id?: string | null;
}

@Injectable()
export class ActivityService {
  async log(payload: ActivityLogPayload): Promise<void> {
    const { error } = await supabase
      .schema('travel')
      .from('activity_logs')
      .insert({
        id: randomUUID(),
        tourist_id: payload.tourist_id,
        action_type: payload.action_type,
        place_id: payload.place_id ?? null,
        created_at: new Date().toISOString(),
      });

    if (error) {
      console.warn(
        `[ActivityLog] Failed to log "${payload.action_type}":`,
        error.message,
      );
    }
  }
}
