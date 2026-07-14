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

  private setCachedChart(key: string, data: ActiveUserChartResponse[]): void {
    this._chartCache.set(key, {
      data,
      expiresAt: Date.now() + this.CHART_CACHE_TTL_MS,
    });
  }

  // ─── Xóa toàn bộ cache (dùng khi cần dữ liệu mới ngay, vd: demo) ────
  clearCache(): void {
    this._placesCache.clear();
    this._chartCache.clear();
    this._interactionCache = null;
    this._statsCache = null;
  }

  private formatDateKey(date: Date): string {
    return date.toISOString().slice(0, 10);
  }

  private formatChartLabel(date: Date, intervalText: string): string {
    const day = String(date.getUTCDate()).padStart(2, '0');
    const month = String(date.getUTCMonth() + 1).padStart(2, '0');
    const year = date.getUTCFullYear();
    return intervalText === '1 month' ? `${month}/${year}` : `${day}/${month}`;
  }

  private addUtcDays(date: Date, days: number): Date {
    const next = new Date(date);
    next.setUTCDate(next.getUTCDate() + days);
    return next;
  }

  private addUtcMonths(date: Date, months: number): Date {
    const next = new Date(date);
    next.setUTCMonth(next.getUTCMonth() + months);
    return next;
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

    const bucketStart = new Date(`${startDate}T00:00:00.000Z`);
    const bucketEnd = new Date(`${endDate}T00:00:00.000Z`);
    const bucketUserIds = new Map<string, Set<string>>();

    for (
      let cursor = new Date(bucketStart);
      cursor <= bucketEnd;
      cursor =
        intervalText === '1 month'
          ? this.addUtcMonths(cursor, 1)
          : this.addUtcDays(cursor, 1)
    ) {
      bucketUserIds.set(this.formatDateKey(cursor), new Set<string>());
    }

    const exclusiveEnd = this.addUtcDays(bucketEnd, 1);

    const { data, error } = await supabase
      .schema('travel')
      .from('activity_logs')
      .select('tourist_id, created_at')
      .gte('created_at', startDate)
      .lt('created_at', this.formatDateKey(exclusiveEnd));

    if (error) {
      throw new InternalServerErrorException(
        `Lỗi khi lấy dữ liệu biểu đồ: ${error.message}`,
      );
    }

    for (const row of (data ?? []) as Array<{
      tourist_id: string | null;
      created_at: string | null;
    }>) {
      if (!row.tourist_id || !row.created_at) continue;
      const createdAt = new Date(`${row.created_at.replace(' ', 'T')}Z`);
      const bucketDate =
        intervalText === '1 month'
          ? new Date(
              Date.UTC(createdAt.getUTCFullYear(), createdAt.getUTCMonth(), 1),
            )
          : new Date(
              Date.UTC(
                createdAt.getUTCFullYear(),
                createdAt.getUTCMonth(),
                createdAt.getUTCDate(),
              ),
            );
      bucketUserIds.get(this.formatDateKey(bucketDate))?.add(row.tourist_id);
    }

    const result = Array.from(bucketUserIds.entries()).map(
      ([key, userIds]) => ({
        date: this.formatChartLabel(
          new Date(`${key}T00:00:00.000Z`),
          intervalText,
        ),
        users: userIds.size,
      }),
    );

    this.setCachedChart(cacheKey, result);
    return result;
  }

  // ─── Popular Places Chart ────────────────────────────────────────────
  async getPopularPlacesChart(
    limit = 20,
    mode: 'top' | 'flop' = 'top',
    categoryName?: string,
  ): Promise<PopularPlaceStats[]> {
    const cacheKey = `places:${mode}:${limit}:${categoryName ?? 'all'}`;
    const cached = this.getCachedPlaces(cacheKey);
    if (cached) return cached;

    const { data, error } = (await supabase.rpc('get_place_popularity_stats', {
      p_limit: limit,
      p_mode: mode,
      p_category_name: categoryName ?? null,
    })) as {
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

    const [usersResult, itinerariesResult] = await Promise.all([
      supabase
        .from('users')
        .select('id')
        .eq('role', 'TOURIST')
        .eq('is_active', '1'),
      supabase
        .schema('travel')
        .from('itineraries')
        .select('creator_id, status')
        .eq('is_deleted', false),
    ]);

    const queryError = usersResult.error || itinerariesResult.error;
    if (queryError) {
      throw new InternalServerErrorException(
        `Lá»—i khi tÃ­nh toÃ¡n tÆ°Æ¡ng tÃ¡c ngÆ°á»i dÃ¹ng: ${queryError.message}`,
      );
    }

    const touristIds = new Set(
      ((usersResult.data ?? []) as Array<{ id: string | null }>)
        .map((user) => user.id)
        .filter((id): id is string => Boolean(id)),
    );
    const tripStatsByUser = new Map<
      string,
      { totalTrips: number; completedTrips: number }
    >();

    for (const userId of touristIds) {
      tripStatsByUser.set(userId, { totalTrips: 0, completedTrips: 0 });
    }

    for (const itinerary of (itinerariesResult.data ?? []) as Array<{
      creator_id: string | null;
      status: string | null;
    }>) {
      if (!itinerary.creator_id || !touristIds.has(itinerary.creator_id)) {
        continue;
      }
      const stats = tripStatsByUser.get(itinerary.creator_id) ?? {
        totalTrips: 0,
        completedTrips: 0,
      };
      stats.totalTrips += 1;
      if (itinerary.status === 'completed') {
        stats.completedTrips += 1;
      }
      tripStatsByUser.set(itinerary.creator_id, stats);
    }

    const totalValidUsers = touristIds.size || 1;
    let noInteractionUsers = 0;
    let createdTripUsers = 0;
    let completedTripUsers = 0;

    for (const stats of tripStatsByUser.values()) {
      if (stats.totalTrips === 0) {
        noInteractionUsers += 1;
      } else if (stats.completedTrips > 0) {
        completedTripUsers += 1;
      } else {
        createdTripUsers += 1;
      }
    }

    const interactionResult: UserInteractionStats = {
      noInteraction: Math.round((noInteractionUsers / totalValidUsers) * 100),
      createdTrip: Math.round((createdTripUsers / totalValidUsers) * 100),
      completedTrip: Math.round((completedTripUsers / totalValidUsers) * 100),
    };

    this._interactionCache = {
      data: interactionResult,
      expiresAt: Date.now() + this.INTERACTION_CACHE_TTL_MS,
    };

    return interactionResult;
    /*

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
    */
  }

  // ─── Dashboard Stats (tổng hợp, 1 call thay 4 calls) ────────────────
  async getDashboardStats(): Promise<DashboardStatsResponse> {
    if (this._statsCache && Date.now() < this._statsCache.expiresAt) {
      return this._statsCache.data;
    }

    const now = new Date();
    const startOfMonth = new Date(
      now.getFullYear(),
      now.getMonth(),
      1,
    ).toISOString();

    const [
      rUserTotal,
      rUserNewMonth,
      rReviewTotal,
      rReviewPending,
      rReviewViolation,
    ] = await Promise.allSettled([
      supabase.from('users').select('id', {
        count: 'estimated',
        head: true,
      }),
      supabase
        .from('users')
        .select('id', { count: 'estimated', head: true })
        .gte('created_at', startOfMonth),
      supabase
        .schema('review_ai')
        .from('reviews')
        .select('id', { count: 'estimated', head: true }),
      supabase
        .schema('review_ai')
        .from('reviews')
        .select('id', { count: 'estimated', head: true })
        .eq('status', 'pending'),
      supabase
        .schema('review_ai')
        .from('reviews')
        .select('id', { count: 'estimated', head: true })
        .eq('status', 'violation'),
    ]);

    const totalUsers =
      rUserTotal.status === 'fulfilled'
        ? Number(rUserTotal.value.count ?? 0)
        : 0;

    const newUsersMonth =
      rUserNewMonth.status === 'fulfilled'
        ? Number(rUserNewMonth.value.count ?? 0)
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
