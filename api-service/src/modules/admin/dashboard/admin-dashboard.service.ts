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
  planningPct: number;
  confirmedPct: number;
  completedPct: number;
  uncompletedPct: number;
}

export interface UserInteractionStats {
  noInteraction: number;
  createdTrip: number;
  completedTrip: number;
}

@Injectable()
export class DashboardService {
  async getActiveUsersChart(
    month?: number,
    week?: number,
  ): Promise<ActiveUserChartResponse[]> {
    if (week !== undefined && month === undefined) {
      throw new BadRequestException(
        'Phải truyền tháng (month) khi dùng tham số tuần (week)',
      );
    }

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

    return (data ?? []).map((row) => ({
      date: String(row.time_label),
      users: Number(row.users_count),
    }));
  }

  async getPopularPlacesChart(limit = 10): Promise<PopularPlaceStats[]> {
    const { data, error } = (await supabase.rpc('get_dashboard_places_stats', {
      p_limit: limit,
    })) as {
      data: Array<{
        destination_name: unknown;
        total_count: unknown;
        completed_count: unknown;
        planning_count: unknown;
        confirmed_count: unknown;
      }> | null;
      error: { message: string } | null;
    };

    if (error) {
      throw new InternalServerErrorException(
        `Lỗi khi lấy thống kê địa điểm: ${error.message}`,
      );
    }

    return (data ?? []).map((row) => {
      const total = Number(row.total_count) || 1;
      const completed = Number(row.completed_count);
      const planning = Number(row.planning_count);
      const confirmed = Number(row.confirmed_count);

      const uncompleted = total - planning - confirmed - completed;

      return {
        id: String(row.destination_name),
        name: String(row.destination_name),
        visitCount: completed,
        planningPct: Math.round((planning / total) * 100),
        confirmedPct: Math.round((confirmed / total) * 100),
        completedPct: Math.round((completed / total) * 100),
        uncompletedPct: Math.round((uncompleted / total) * 100),
      };
    });
  }

  async getUserInteractions(): Promise<UserInteractionStats> {
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

    if (!stats) {
      return { noInteraction: 0, createdTrip: 0, completedTrip: 0 };
    }

    const totalUsers = Number(stats.total_valid_users) || 1;

    return {
      noInteraction: Math.round(
        (Number(stats.no_interaction_users) / totalUsers) * 100,
      ),
      createdTrip: Math.round(
        (Number(stats.created_trip_users) / totalUsers) * 100,
      ),
      completedTrip: Math.round(
        (Number(stats.completed_trip_users) / totalUsers) * 100,
      ),
    };
  }
}
