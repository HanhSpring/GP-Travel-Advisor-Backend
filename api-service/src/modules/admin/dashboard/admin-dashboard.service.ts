import {
  Injectable,
  InternalServerErrorException,
  BadRequestException,
} from '@nestjs/common';
import { supabase } from 'src/config/supabase';

export interface ActiveUserChartResponse {
  date: string;
  users: number;
}

export interface PopularPlaceStats {
  id: string;
  name: string;
  visitCount: number;
  pendingPct: number;
  ongoingPct: number;
  completedPct: number;
  uncompletedPct: number;
}

export interface UserInteractionStats {
  noInteraction: number;
  createdTrip: number;
  completedTrip: number;
}

export interface DashboardStatsResponse {
  totalUsers: number;
  newUsersMonth: number;
  totalLocations: number;
  pendingApproval: number;
  totalReviews: number;
  pendingReviews: number;
  violationReviews: number;
}

@Injectable()
export class DashboardService {
  // ─── Cache: popular places (TTL 1 giờ) ──────────────────────────────
  private readonly _placesCache = new Map<
    string,
    { data: PopularPlaceStats[]; expiresAt: number }
  >();
  private readonly PLACES_CACHE_TTL_MS = 60 * 60 * 1000;

  // ─── Cache: chart per (month, week) key (TTL 30 phút) ───────────────
  private readonly _chartCache = new Map<
    string,
    { data: ActiveUserChartResponse[]; expiresAt: number }
  >();
  private readonly CHART_CACHE_TTL_MS = 30 * 60 * 1000;

  // ─── Cache: interactions (TTL 5 phút) ───────────────────────────────
  private _interactionCache: {
    data: UserInteractionStats;
    expiresAt: number;
  } | null = null;
  private readonly INTERACTION_CACHE_TTL_MS = 5 * 60 * 1000;

  // ─── Cache: dashboard stats (TTL 2 phút) ────────────────────────────
  private _statsCache: {
    data: DashboardStatsResponse;
    expiresAt: number;
  } | null = null;
  private readonly STATS_CACHE_TTL_MS = 2 * 60 * 1000;

  // ─── Cache helpers ───────────────────────────────────────────────────
  private getCachedPlaces(key: string): PopularPlaceStats[] | null {
    const entry = this._placesCache.get(key);
    if (!entry || Date.now() > entry.expiresAt) {
      this._placesCache.delete(key);
      return null;
    }
    return entry.data;
  }

  private setCachedPlaces(key: string, data: PopularPlaceStats[]): void {
    this._placesCache.set(key, {
      data,
      expiresAt: Date.now() + this.PLACES_CACHE_TTL_MS,
    });
  }

  private getCachedChart(key: string): ActiveUserChartResponse[] | null {
    const entry = this._chartCache.get(key);
    if (!entry || Date.now() > entry.expiresAt) {
      this._chartCache.delete(key);
      return null;
    }
    return entry.data;
  }

  private setCachedChart(
    key: string,
    data: ActiveUserChartResponse[],
  ): void {
    this._chartCache.set(key, {
      data,
      expiresAt: Date.now() + this.CHART_CACHE_TTL_MS,
    });
  }

  // ─── Active Users Chart ──────────────────────────────────────────────
  async getActiveUsersChart(
    month?: number,
    week?: number,
  ): Promise<ActiveUserChartResponse[]> {
    if (week !== undefined && month === undefined) {
      throw new BadRequestException(
        'Phải truyền tháng (month) khi dùng tham số tuần (week)',
      );
    }

    const cacheKey = `chart:${month ?? 'all'}:${week ?? 'all'}`;
    const cached = this.getCachedChart(cacheKey);
    if (cached) return cached;

    const currentYear = new Date().getFullYear();

    let startDate: string;
    let endDate: string;
    let intervalText: string;

    if (!month) {
      startDate = `${currentYear}-01-01`;
      endDate = `${currentYear}-12-31`;
      intervalText = '1 month';
    } else {
      intervalText = '1 day';
      const formattedMonth = month.toString().padStart(2, '0');

      if (!week) {
        const lastDayOfMonth = new Date(currentYear, month, 0).getDate();
        startDate = `${currentYear}-${formattedMonth}-01`;
        endDate = `${currentYear}-${formattedMonth}-${lastDayOfMonth}`;
      } else {
        const startDay = (week - 1) * 7 + 1;
        let endDay = startDay + 6;

        const lastDayOfMonth = new Date(currentYear, month, 0).getDate();
        if (endDay > lastDayOfMonth || week >= 4) {
          endDay = lastDayOfMonth;
        }

        startDate = `${currentYear}-${formattedMonth}-${startDay.toString().padStart(2, '0')}`;
        endDate = `${currentYear}-${formattedMonth}-${endDay.toString().padStart(2, '0')}`;
      }
    }

    const { data, error } = (await supabase.rpc('get_active_users_chart', {
      p_start_date: startDate,
      p_end_date: endDate,
      p_interval: intervalText,
    })) as {
      data: Array<{ time_label: unknown; users_count: unknown }> | null;
      error: { message: string } | null;
    };

    if (error) {
      throw new InternalServerErrorException(
        `Lỗi khi lấy dữ liệu biểu đồ: ${error.message}`,
      );
    }

    const result = (data ?? []).map((row) => ({
      date: String(row.time_label),
      users: Number(row.users_count),
    }));

    this.setCachedChart(cacheKey, result);
    return result;
  }

  // ─── Popular Places Chart ────────────────────────────────────────────
  async getPopularPlacesChart(
    limit = 20,
    mode: 'top' | 'flop' = 'top',
  ): Promise<PopularPlaceStats[]> {
    const cacheKey = `places:${mode}:${limit}`;
    const cached = this.getCachedPlaces(cacheKey);
    if (cached) return cached;

    const { data, error } = (await supabase.rpc(
      'get_place_popularity_stats',
      { p_limit: limit, p_mode: mode },
    )) as {
      data: Array<{
        place_id: unknown;
        place_name: unknown;
        visit_count: unknown;
        completed_count: unknown;
        planning_count: unknown;
        ongoing_count: unknown;
        total_count: unknown;
      }> | null;
      error: { message: string } | null;
    };

    if (error) {
      throw new InternalServerErrorException(
        `Lỗi khi lấy thống kê địa điểm: ${error.message}`,
      );
    }

    const result = (data ?? []).map((row) => {
      const total = Number(row.total_count) || 1;
      const completed = Number(row.completed_count);
      const planning = Number(row.planning_count);
      const ongoing = Number(row.ongoing_count);
      const uncompleted = Math.max(0, total - planning - ongoing - completed);

      return {
        id: String(row.place_id),
        name: String(row.place_name),
        visitCount: Number(row.visit_count),
        pendingPct: Math.round((planning / total) * 100),
        ongoingPct: Math.round((ongoing / total) * 100),
        completedPct: Math.round((completed / total) * 100),
        uncompletedPct: Math.round((uncompleted / total) * 100),
      };
    });

    this.setCachedPlaces(cacheKey, result);
    return result;
  }

  // ─── User Interactions ───────────────────────────────────────────────
  async getUserInteractions(): Promise<UserInteractionStats> {
    if (
      this._interactionCache &&
      Date.now() < this._interactionCache.expiresAt
    ) {
      return this._interactionCache.data;
    }

    const { data, error } = (await supabase.rpc(
      'get_user_interaction_stats',
    )) as {
      data: Array<{
        total_valid_users: number;
        no_interaction_users: number;
        created_trip_users: number;
        completed_trip_users: number;
      }> | null;
      error: { message: string } | null;
    };

    if (error) {
      throw new InternalServerErrorException(
        `Lỗi khi tính toán tương tác người dùng: ${error.message}`,
      );
    }

    const stats = data && data.length > 0 ? data[0] : null;

    const result: UserInteractionStats = stats
      ? {
          noInteraction: Math.round(
            (Number(stats.no_interaction_users) /
              (Number(stats.total_valid_users) || 1)) *
              100,
          ),
          createdTrip: Math.round(
            (Number(stats.created_trip_users) /
              (Number(stats.total_valid_users) || 1)) *
              100,
          ),
          completedTrip: Math.round(
            (Number(stats.completed_trip_users) /
              (Number(stats.total_valid_users) || 1)) *
              100,
          ),
        }
      : { noInteraction: 0, createdTrip: 0, completedTrip: 0 };

    this._interactionCache = {
      data: result,
      expiresAt: Date.now() + this.INTERACTION_CACHE_TTL_MS,
    };

    return result;
  }

  // ─── Dashboard Stats (tổng hợp, 1 call thay 4 calls) ────────────────
  async getDashboardStats(): Promise<DashboardStatsResponse> {
    if (this._statsCache && Date.now() < this._statsCache.expiresAt) {
      return this._statsCache.data;
    }

    const [rUsers, rLocTotal, rLocPending, rReviewTotal, rReviewPending, rReviewViolation] =
      await Promise.allSettled([
        supabase.rpc('get_user_statistics'),
        supabase
          .schema('travel')
          .from('places')
          .select('id', { count: 'exact', head: true }),
        supabase
          .schema('travel')
          .from('places')
          .select('id', { count: 'exact', head: true })
          .is('is_approved', null)
          .or('is_active.is.null,is_active.eq.true'),
        supabase
          .schema('review_ai')
          .from('reviews')
          .select('id', { count: 'exact', head: true }),
        supabase
          .schema('review_ai')
          .from('reviews')
          .select('id', { count: 'exact', head: true })
          .eq('status', 'pending'),
        supabase
          .schema('review_ai')
          .from('reviews')
          .select('id', { count: 'exact', head: true })
          .eq('status', 'violation'),
      ]);

    let totalUsers = 0;
    let newUsersMonth = 0;
    if (rUsers.status === 'fulfilled' && !rUsers.value.error) {
      const d = rUsers.value.data as Array<{
        total_users: number;
        new_this_month: number;
      }> | null;
      if (d && d.length > 0) {
        totalUsers = Number(d[0].total_users ?? 0);
        newUsersMonth = Number(d[0].new_this_month ?? 0);
      }
    }

    const totalLocations =
      rLocTotal.status === 'fulfilled'
        ? Number(rLocTotal.value.count ?? 0)
        : 0;

    const pendingApproval =
      rLocPending.status === 'fulfilled'
        ? Number(rLocPending.value.count ?? 0)
        : 0;

    const totalReviews =
      rReviewTotal.status === 'fulfilled'
        ? Number(rReviewTotal.value.count ?? 0)
        : 0;

    const pendingReviews =
      rReviewPending.status === 'fulfilled'
        ? Number(rReviewPending.value.count ?? 0)
        : 0;

    const violationReviews =
      rReviewViolation.status === 'fulfilled'
        ? Number(rReviewViolation.value.count ?? 0)
        : 0;

    const result: DashboardStatsResponse = {
      totalUsers,
      newUsersMonth,
      totalLocations,
      pendingApproval,
      totalReviews,
      pendingReviews,
      violationReviews,
    };

    this._statsCache = {
      data: result,
      expiresAt: Date.now() + this.STATS_CACHE_TTL_MS,
    };

    return result;
  }
}
