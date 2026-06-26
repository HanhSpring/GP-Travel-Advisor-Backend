import {
  BadRequestException,
  Injectable,
  InternalServerErrorException,
} from '@nestjs/common';
import { supabase } from '../../../config/supabase';
import { AdminItineraryReviewListResponseDto } from './dto/admin-itinerary-review-list.dto';

interface ItineraryReviewRow {
  id: string;
  tourist_id: string;
  itinerary_id: string;
  rating: number;
  content: string | null;
  url_image: string[] | string | null;
  created_at: string;
  status: 'pending' | 'approved' | 'violation' | null;
  violation_reason?: string | null;
}

interface ItineraryRow {
  id: string;
  destination: string | null;
  start_date: string | null;
  end_date: string | null;
}

interface UserRow {
  id: string;
  full_name: string | null;
}

type ReviewStatus = 'all' | 'pending' | 'approved' | 'violation';
type ReviewSort = 'newest' | 'oldest' | 'highest_rating' | 'lowest_rating';
type ReviewDateSent = 'all' | 'today' | 'yesterday' | 'last_7_days' | 'last_30_days';

@Injectable()
export class AdminItineraryReviewsService {
  private normalizeForSearch(value?: string | null): string {
    if (!value) {
      return '';
    }

    return value
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/đ/g, 'd')
      .replace(/Đ/g, 'D')
      .toLowerCase()
      .trim();
  }

  private normalizeImageUrls(value: string[] | string | null | undefined): string[] {
    if (Array.isArray(value)) {
      return value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0);
    }

    if (typeof value === 'string' && value.trim().length > 0) {
      return [value.trim()];
    }

    return [];
  }

  private resolveStatus(status: string | null): 'pending' | 'approved' | 'violation' {
    if (status === 'approved' || status === 'violation') return status;
    return 'pending';
  }

  private async countReviews(status: ReviewStatus = 'all'): Promise<number> {
    if (!['all', 'pending', 'approved', 'violation'].includes(status)) {
      throw new BadRequestException('status must be one of: all, pending, approved, violation');
    }

    let query = supabase
      .schema('review_ai')
      .from('itinerary_reviews')
      .select('id', { count: 'exact', head: true });

    if (status === 'pending') {
      query = query.not('status', 'in', '("approved","violation")');
    } else if (status === 'approved') {
      query = query.eq('status', 'approved');
    } else if (status === 'violation') {
      query = query.eq('status', 'violation');
    }

    const { count, error } = await query;

    if (error) {
      throw new InternalServerErrorException(error.message);
    }

    return count ?? 0;
  }

  private async buildSearchReviewIds(search?: string): Promise<string[] | null> {
    const normalizedSearch = this.normalizeForSearch(search);

    if (!normalizedSearch) {
      return null;
    }

    const simpleSearch = search?.trim() ?? '';
    if (!simpleSearch) {
      return null;
    }

    const [usersResult, itinerariesResult] = await Promise.all([
      supabase.schema('public').from('users').select('id').ilike('full_name', `%${simpleSearch}%`),
      supabase.schema('travel').from('itineraries').select('id').ilike('destination', `%${simpleSearch}%`),
    ]);

    if (usersResult.error) {
      throw new InternalServerErrorException(usersResult.error.message);
    }

    if (itinerariesResult.error) {
      throw new InternalServerErrorException(itinerariesResult.error.message);
    }

    const reviewIds = new Set<string>();

    const userIds = (usersResult.data ?? []).map((item) => (item as UserRow).id).filter(Boolean);
    if (userIds.length > 0) {
      const { data, error } = await supabase
        .schema('review_ai')
        .from('itinerary_reviews')
        .select('id')
        .in('tourist_id', userIds);

      if (error) {
        throw new InternalServerErrorException(error.message);
      }

      for (const item of data ?? []) {
        reviewIds.add((item as { id: string }).id);
      }
    }

    const itineraryIds = (itinerariesResult.data ?? [])
      .map((item) => (item as ItineraryRow).id)
      .filter(Boolean);

    if (itineraryIds.length > 0) {
      const { data, error } = await supabase
        .schema('review_ai')
        .from('itinerary_reviews')
        .select('id')
        .in('itinerary_id', itineraryIds);

      if (error) {
        throw new InternalServerErrorException(error.message);
      }

      for (const item of data ?? []) {
        reviewIds.add((item as { id: string }).id);
      }
    }

    return Array.from(reviewIds);
  }

  async getReviews(
    page: number = 1,
    limit: number = 10,
    search?: string,
    status?: string,
    sort: ReviewSort = 'newest',
    dateSent: ReviewDateSent = 'all',
    dateExact?: string,
    rating?: number,
  ): Promise<AdminItineraryReviewListResponseDto> {
    if (page < 1) {
      throw new BadRequestException('Page must be >= 1');
    }

    if (limit < 1 || limit > 100) {
      throw new BadRequestException('Limit must be between 1 and 100');
    }

    const offset = (page - 1) * limit;

    const [totalReviews, pendingCount, approvedCount, violationCount] = await Promise.all([
      this.countReviews('all'),
      this.countReviews('pending'),
      this.countReviews('approved'),
      this.countReviews('violation'),
    ]);

    const summary = {
      total_reviews: totalReviews,
      pending_count: pendingCount,
      approved_count: approvedCount,
      violation_count: violationCount,
    };

    try {
      let query = supabase
        .schema('review_ai')
        .from('itinerary_reviews')
        .select('id, tourist_id, itinerary_id, rating, content, url_image, created_at, status, violation_reason', {
          count: 'exact',
        });

      if (status && ['pending', 'approved', 'violation'].includes(status)) {
        if (status === 'pending') {
          query = query.not('status', 'in', '("approved","violation")');
        } else {
          query = query.eq('status', status);
        }
      }

      if (rating) {
        query = query.eq('rating', rating);
      }

      if (dateSent !== 'all') {
        const now = new Date();
        let fromDate: Date | null = null;
        let toDate: Date | null = null;

        if (dateSent === 'today') {
          fromDate = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0, 0);
        }

        if (dateSent === 'yesterday') {
          fromDate = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1, 0, 0, 0, 0);
          toDate = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0, 0);
        }

        if (dateSent === 'last_7_days') {
          fromDate = new Date(now);
          fromDate.setDate(fromDate.getDate() - 7);
        }

        if (dateSent === 'last_30_days') {
          fromDate = new Date(now);
          fromDate.setDate(fromDate.getDate() - 30);
        }

        if (fromDate) {
          query = query.gte('created_at', fromDate.toISOString());
        }

        if (toDate) {
          query = query.lt('created_at', toDate.toISOString());
        }
      }

      if (dateExact) {
        const exactDate = new Date(`${dateExact}T00:00:00`);

        if (Number.isNaN(exactDate.getTime())) {
          throw new BadRequestException('date_exact must be in YYYY-MM-DD format');
        }

        const nextDate = new Date(exactDate);
        nextDate.setDate(nextDate.getDate() + 1);

        query = query
          .gte('created_at', exactDate.toISOString())
          .lt('created_at', nextDate.toISOString());
      }

      const searchIds = await this.buildSearchReviewIds(search);
      if (searchIds !== null) {
        if (searchIds.length === 0) {
          return {
            data: [],
            pagination: { total: 0, page, limit, total_pages: 0 },
            summary,
          };
        }

        query = query.in('id', searchIds);
      }

      switch (sort) {
        case 'highest_rating':
          query = query.order('rating', { ascending: false });
          break;
        case 'lowest_rating':
          query = query.order('rating', { ascending: true });
          break;
        case 'oldest':
          query = query.order('created_at', { ascending: true });
          break;
        case 'newest':
        default:
          query = query.order('created_at', { ascending: false });
      }

      const { data, error, count } = await query.range(offset, offset + limit - 1);

      if (error && error.code !== 'PGRST116') {
        throw error;
      }

      const reviewRows = (data ?? []) as ItineraryReviewRow[];
      const itineraryIds = Array.from(new Set(reviewRows.map((item) => item.itinerary_id).filter(Boolean)));
      const touristIds = Array.from(new Set(reviewRows.map((item) => item.tourist_id).filter(Boolean)));

      const [itinerariesResult, usersResult] = await Promise.all([
        itineraryIds.length > 0
          ? supabase.schema('travel').from('itineraries').select('id, destination, start_date, end_date').in('id', itineraryIds)
          : Promise.resolve({ data: [], error: null }),
        touristIds.length > 0
          ? supabase.schema('public').from('users').select('id, full_name').in('id', touristIds)
          : Promise.resolve({ data: [], error: null }),
      ]);

      if (itinerariesResult.error) {
        throw new InternalServerErrorException(itinerariesResult.error.message);
      }

      if (usersResult.error) {
        throw new InternalServerErrorException(usersResult.error.message);
      }

      const itineraryMap = new Map<string, ItineraryRow>();
      for (const item of itinerariesResult.data ?? []) {
        const itinerary = item as ItineraryRow;
        itineraryMap.set(itinerary.id, itinerary);
      }

      const userMap = new Map<string, UserRow>();
      for (const item of usersResult.data ?? []) {
        const user = item as UserRow;
        userMap.set(user.id, user);
      }

      const dataRows = await Promise.all(
        reviewRows.map(async (review) => {
          const [reviewCountResult, reportCountResult] = await Promise.all([
            supabase.schema('review_ai').from('itinerary_reviews').select('id', { count: 'exact', head: true }).eq('tourist_id', review.tourist_id),
            supabase.schema('review_ai').from('itinerary_reviews').select('id', { count: 'exact', head: true }).eq('tourist_id', review.tourist_id).eq('status', 'violation'),
          ]);

          const user = userMap.get(review.tourist_id);
          const itinerary = itineraryMap.get(review.itinerary_id);

          return {
            id: review.id,
            reviewer_id: review.tourist_id,
            reviewer_name: user?.full_name ?? 'Người dùng ẩn danh',
            reviewer_review_count: reviewCountResult.count ?? 0,
            reviewer_report_count: reportCountResult.count ?? 0,
            itinerary_id: review.itinerary_id,
            itinerary_name: itinerary?.destination ?? 'Lịch trình',
            itinerary_start_date: itinerary?.start_date ?? null,
            itinerary_end_date: itinerary?.end_date ?? null,
            rating: review.rating,
            review_content: review.content,
            status: this.resolveStatus(review.status),
            created_at: review.created_at,
            has_images: this.normalizeImageUrls(review.url_image).length > 0,
          };
        }),
      );

      return {
        data: dataRows,
        pagination: { total: count ?? 0, page, limit, total_pages: Math.ceil((count ?? 0) / limit) },
        summary,
      };
    } catch (error) {
      if (error instanceof BadRequestException) {
        throw error;
      }

      throw new InternalServerErrorException(error instanceof Error ? error.message : 'Failed to fetch itinerary reviews');
    }
  }

  async updateReviewStatus(id: string, status: 'approved' | 'violation', reason?: string) {
    const updatePayload: Record<string, unknown> = { status };
    if (status === 'violation' && reason) {
      updatePayload.violation_reason = reason;
    }

    const { data, error } = await supabase
      .schema('review_ai')
      .from('itinerary_reviews')
      .update(updatePayload)
      .eq('id', id)
      .select('id, status')
      .maybeSingle<{ id: string; status: string }>();

    if (error) {
      throw new InternalServerErrorException(error.message);
    }

    if (!data) {
      throw new InternalServerErrorException('Itinerary review not found');
    }

    return {
      id: data.id,
      status,
      message: status === 'approved' ? 'Itinerary review approved successfully' : 'Itinerary review rejected successfully',
      note: reason ?? null,
      note_saved: status === 'violation' && !!reason,
    };
  }

  async approveReview(id: string) {
    return this.updateReviewStatus(id, 'approved');
  }

  async rejectReview(id: string, reason?: string) {
    return this.updateReviewStatus(id, 'violation', reason);
  }

  async getReviewById(id: string) {
    const { data: review, error } = await supabase
      .schema('review_ai')
      .from('itinerary_reviews')
      .select('id, tourist_id, itinerary_id, rating, content, url_image, created_at, status, violation_reason')
      .eq('id', id)
      .single<ItineraryReviewRow>();

    if (error) throw new InternalServerErrorException(error.message);
    if (!review) throw new InternalServerErrorException('Itinerary review not found');

    const [userResult, itineraryResult, reviewCountResult, reportCountResult] = await Promise.all([
      supabase.schema('public').from('users').select('id, full_name').eq('id', review.tourist_id).single<UserRow>(),
      supabase.schema('travel').from('itineraries').select('id, destination, start_date, end_date').eq('id', review.itinerary_id).single<ItineraryRow>(),
      supabase.schema('review_ai').from('itinerary_reviews').select('id', { count: 'exact', head: true }).eq('tourist_id', review.tourist_id),
      supabase.schema('review_ai').from('itinerary_reviews').select('id', { count: 'exact', head: true }).eq('tourist_id', review.tourist_id).eq('status', 'violation'),
    ]);

    const imageUrls = this.normalizeImageUrls(review.url_image).map((url) => ({ url }));
    const resolvedStatus = this.resolveStatus(review.status);

    return {
      id: review.id,
      reviewer: {
        id: review.tourist_id,
        name: userResult.data?.full_name ?? 'Người dùng ẩn danh',
        review_count: reviewCountResult.count ?? 0,
        report_count: reportCountResult.count ?? 0,
      },
      itinerary: {
        id: review.itinerary_id,
        name: itineraryResult.data?.destination ?? 'Lịch trình',
        start_date: itineraryResult.data?.start_date ?? null,
        end_date: itineraryResult.data?.end_date ?? null,
      },
      rating: review.rating,
      review_content: review.content,
      images: imageUrls,
      status: resolvedStatus,
      violation_reason: review.violation_reason ?? null,
      created_at: review.created_at,
    };
  }
}
