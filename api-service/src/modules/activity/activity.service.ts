import {
  Injectable,
  InternalServerErrorException,
  Logger,
} from '@nestjs/common';
import { randomUUID } from 'crypto';
import { supabase } from '../../config/supabase';
import type { FrontendActionType } from './dto/track-activity.dto';
import { toVietnamTimestamp } from './activity-time';

export interface ActivityLogPayload {
  tourist_id: string;
  action_type: FrontendActionType;
  place_id?: string | null;
}

const SEARCH_DEBOUNCE_WINDOW_MS = 5 * 1000;
const MIN_VIEW_DWELL_MS = 2 * 1000;
const VIEW_CLICK_WINDOW_MS = 30 * 60 * 1000;

@Injectable()
export class ActivityService {
  private readonly logger = new Logger(ActivityService.name);

  async log(payload: ActivityLogPayload): Promise<void> {
    if (payload.action_type === 'view') {
      if (!payload.place_id) {
        return;
      }

      const hasEligibleClick = await this.hasEligiblePlaceClick(
        payload.tourist_id,
        payload.place_id,
      );
      if (!hasEligibleClick) {
        return;
      }
    }

    if (payload.action_type === 'search') {
      const duplicateSearch = await this.hasRecentPendingSearch(
        payload.tourist_id,
      );
      if (duplicateSearch) {
        return;
      }
    }

    if (payload.action_type === 'click' && payload.place_id) {
      await this.attachPlaceToLatestSearch(
        payload.tourist_id,
        payload.place_id,
      );
    }

    const { error } = await supabase
      .schema('travel')
      .from('activity_logs')
      .insert({
        id: randomUUID(),
        tourist_id: payload.tourist_id,
        action_type: payload.action_type,
        place_id: payload.place_id ?? null,
        created_at: toVietnamTimestamp(),
      });

    if (error) {
      this.logger.error(
        `Failed to log activity "${payload.action_type}": ${error.message}`,
      );
      throw new InternalServerErrorException('Failed to record activity');
    }
  }

  private async hasEligiblePlaceClick(
    touristId: string,
    placeId: string,
  ): Promise<boolean> {
    const now = Date.now();
    const earliest = toVietnamTimestamp(
      new Date(now - VIEW_CLICK_WINDOW_MS),
    );
    const latest = toVietnamTimestamp(new Date(now - MIN_VIEW_DWELL_MS));
    const { data, error } = await supabase
      .schema('travel')
      .from('activity_logs')
      .select('id')
      .eq('tourist_id', touristId)
      .eq('action_type', 'click')
      .eq('place_id', placeId)
      .gte('created_at', earliest)
      .lte('created_at', latest)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle<{ id: string }>();

    if (error) {
      this.activityError('verify view dwell click', error.message);
    }

    return data != null;
  }

  private async hasRecentPendingSearch(touristId: string): Promise<boolean> {
    const cutoff = toVietnamTimestamp(
      new Date(Date.now() - SEARCH_DEBOUNCE_WINDOW_MS),
    );
    const { data, error } = await supabase
      .schema('travel')
      .from('activity_logs')
      .select('id')
      .eq('tourist_id', touristId)
      .eq('action_type', 'search')
      .is('place_id', null)
      .gte('created_at', cutoff)
      .limit(1)
      .maybeSingle<{ id: string }>();

    if (error) {
      this.activityError('check recent search', error.message);
    }

    return data != null;
  }

  private async attachPlaceToLatestSearch(
    touristId: string,
    placeId: string,
  ): Promise<void> {
    const { data: latestClick, error: clickError } = await supabase
      .schema('travel')
      .from('activity_logs')
      .select('created_at')
      .eq('tourist_id', touristId)
      .eq('action_type', 'click')
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle<{ created_at: string }>();

    if (clickError) {
      this.activityError('find latest click boundary', clickError.message);
    }

    const { data: pendingSearch, error: findError } = await supabase
      .schema('travel')
      .from('activity_logs')
      .select('id, created_at')
      .eq('tourist_id', touristId)
      .eq('action_type', 'search')
      .is('place_id', null)
      .gt(
        'created_at',
        latestClick?.created_at ?? '0001-01-01T00:00:00.000',
      )
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle<{ id: string; created_at: string }>();

    if (findError) {
      this.activityError('find pending search', findError.message);
    }

    if (!pendingSearch) {
      return;
    }

    const { data: updatedSearch, error: updateError } = await supabase
      .schema('travel')
      .from('activity_logs')
      .update({ place_id: placeId })
      .eq('id', pendingSearch.id)
      .is('place_id', null)
      .select('id')
      .maybeSingle<{ id: string }>();

    if (updateError) {
      this.activityError('attach first clicked place', updateError.message);
    }

    if (!updatedSearch) {
      this.logger.debug(
        `Search ${pendingSearch.id} was already claimed by another click`,
      );
    }
  }

  private resolveImage(imageUrl: unknown): string {
    if (Array.isArray(imageUrl)) {
      const first = (imageUrl as unknown[]).find(
        (i) => typeof i === 'string' && (i as string).trim(),
      );
      if (first) return first as string;
    }
    if (typeof imageUrl === 'string' && imageUrl.trim()) return imageUrl.trim();
    return '';
  }

  private activityError(operation: string, message: string): never {
    this.logger.error(`Failed to ${operation}: ${message}`);
    throw new InternalServerErrorException('Failed to record activity');
  }

  async getRecentSearchPlaces(touristId: string): Promise<RecentSearchPlace[]> {
    const { data: logs } = await supabase
      .schema('travel')
      .from('activity_logs')
      .select('place_id, created_at')
      .eq('tourist_id', touristId)
      .eq('action_type', 'search')
      .not('place_id', 'is', null)
      .order('created_at', { ascending: false })
      .limit(50);

    if (!logs?.length) return [];

    const seen = new Set<string>();
    const uniqueIds: string[] = [];
    for (const log of logs) {
      const pid = log.place_id as string | null;
      if (pid && !seen.has(pid)) {
        seen.add(pid);
        uniqueIds.push(pid);
        if (uniqueIds.length >= 10) break;
      }
    }

    if (!uniqueIds.length) return [];

    const { data: places } = await supabase
      .schema('travel')
      .from('places')
      .select('id, name, image_url')
      .in('id', uniqueIds);

    if (!places?.length) return [];

    const placeMap = new Map(places.map((p) => [p.id as string, p]));
    return uniqueIds
      .map((id) => {
        const p = placeMap.get(id);
        if (!p) return null;
        return {
          id: p.id as string,
          name: p.name as string,
          image: this.resolveImage(p.image_url),
          type: 'place' as const,
        };
      })
      .filter((x): x is RecentSearchPlace => x !== null);
  }
}

export interface RecentSearchPlace {
  id: string;
  name: string;
  image: string;
  type: 'place';
}
