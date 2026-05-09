import { Injectable } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { supabase } from '../../config/supabase';

/** Trả về ISO-8601 string theo múi giờ Việt Nam (UTC+7) */
function getNowVN(): string {
  const now = new Date();
  // Offset UTC+7 tính bằng milliseconds
  const VN_OFFSET_MS = 7 * 60 * 60 * 1000;
  const vnTime = new Date(now.getTime() + VN_OFFSET_MS);
  // toISOString() luôn trả UTC nên thay suffix Z → +07:00
  return vnTime.toISOString().replace('Z', '+07:00');
}

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
        created_at: getNowVN(),
      });

    if (error) {
      console.warn(
        `[ActivityLog] Failed to log "${payload.action_type}":`,
        error.message,
      );
    }
  }
}
