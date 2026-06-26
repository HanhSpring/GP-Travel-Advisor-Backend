import {
  Injectable,
  BadRequestException,
  InternalServerErrorException,
} from '@nestjs/common';
import { supabase } from '../../../config/supabase';
import { AdminReviewListResponseDto } from './dto/admin-review-list.dto';
import { AdminReviewDetailDto } from './dto/admin-review-detail.dto';

interface ReviewRow {
  id: string;
  tourist_id: string;
  place_id: string;
  rating: number;
  created_at: string;
  review_type: string;
  status: 'pending' | 'approved' | 'violation';
  violation_reason?: string | null;
}

interface PlaceData {
  name: string;
  address: string;
}

interface UserData {
  full_name: string;
}

interface ReviewContentData {
  content: string | null;
  main_topic: string | null;
  processing_status?: string | null;
  time_label?: string | null;
}

type ReviewSort = 'newest' | 'oldest' | 'highest_rating' | 'lowest_rating';
type ReviewClassification =
  | 'short-term'
  | 'long-term'
  | 'need-action'
  | 'unclassified';
type ReviewDateSent =
  | 'all'
  | 'today'
  | 'yesterday'
  | 'last_7_days'
  | 'last_30_days';

@Injectable()
export class AdminReviewsService {
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

  private normalizeClassification(
    classification?: ReviewClassification,
  ): 'short-term' | 'long-term' | 'need-action' | 'unclassified' | null {
    if (!classification) {
      return null;
    }

    if (classification === 'short-term') {
      return 'short-term';
    }

    if (classification === 'long-term') {
      return 'long-term';
    }

    if (classification === 'need-action') {
      return 'need-action';
    }

    if (classification === 'unclassified') {
      return 'unclassified';
    }

    return null;
  }

  private async getSummaryStats(): Promise<{
    total_reviews: number;
    pending_count: number;
    approved_count: number;
    violation_count: number;
  }> {
    const [pendingRes, approvedRes, violationRes] = await Promise.all([
      supabase
        .schema('review_ai')
        .from('reviews')
        .select('*', { count: 'exact', head: true })
        .eq('status', 'pending'),
      supabase
        .schema('review_ai')
        .from('reviews')
        .select('*', { count: 'exact', head: true })
        .eq('status', 'approved'),
      supabase
        .schema('review_ai')
        .from('reviews')
        .select('*', { count: 'exact', head: true })
        .eq('status', 'violation'),
    ]);

    const pending = pendingRes.count ?? 0;
    const approved = approvedRes.count ?? 0;
    const violation = violationRes.count ?? 0;

    return {
      total_reviews: pending + approved + violation,
      pending_count: pending,
      approved_count: approved,
      violation_count: violation,
    };
  }

  async getReviews(
    page: number = 1,
    limit: number = 10,
    search?: string,
    status?: string,
    sort: ReviewSort = 'newest',
    classification?: ReviewClassification,
    dateSent: ReviewDateSent = 'all',
    dateExact?: string,
    rating?: number,
  ): Promise<AdminReviewListResponseDto> {
    if (page < 1) throw new BadRequestException('Page must be >= 1');
    if (limit < 1 || limit > 100)
      throw new BadRequestException('Limit must be between 1 and 100');

    const offset = (page - 1) * limit;

    try {
      // Fire summary stats in background while we prepare the main query
      const summaryPromise = this.getSummaryStats();

      // Classification filter — 1 query upfront if needed
      let classificationReviewIds: string[] | null = null;
      const normalizedClassification =
        this.normalizeClassification(classification);

      if (normalizedClassification) {
        let contentsQuery = supabase
          .schema('review_ai')
          .from('review_contents')
          .select('review_id');

        if (normalizedClassification === 'long-term') {
          contentsQuery = contentsQuery
            .eq('processing_status', 'processed')
            .eq('time_label', 'long-term');
        } else if (normalizedClassification === 'short-term') {
          contentsQuery = contentsQuery
            .eq('processing_status', 'processed')
            .eq('time_label', 'short-term');
        } else if (normalizedClassification === 'need-action') {
          contentsQuery = contentsQuery
            .eq('processing_status', 'processed')
            .eq('time_label', 'amb');
        } else if (normalizedClassification === 'unclassified') {
          contentsQuery = contentsQuery
            .eq('processing_status', 'pending')
            .is('time_label', null);
        }

        const { data: classifiedRows, error: classifiedError } =
          await contentsQuery;

        if (classifiedError) throw classifiedError;

        classificationReviewIds = (classifiedRows || [])
          .map((item) => (item as { review_id: string }).review_id)
          .filter(Boolean);

        if (classificationReviewIds.length === 0) {
          return {
            data: [],
            pagination: { total: 0, page, limit, total_pages: 0 },
            summary: await summaryPromise,
          };
        }
      }

      // Build main paginated query
      let query = supabase
        .schema('review_ai')
        .from('reviews')
        .select('id, tourist_id, place_id, rating, created_at, review_type, status', { count: 'exact' });

      if (status && ['pending', 'approved', 'violation'].includes(status)) {
        query = query.eq('status', status);
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
        } else if (dateSent === 'yesterday') {
          fromDate = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1, 0, 0, 0, 0);
          toDate = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0, 0);
        } else if (dateSent === 'last_7_days') {
          fromDate = new Date(now);
          fromDate.setDate(fromDate.getDate() - 7);
        } else if (dateSent === 'last_30_days') {
          fromDate = new Date(now);
          fromDate.setDate(fromDate.getDate() - 30);
        }

        if (fromDate) query = query.gte('created_at', fromDate.toISOString());
        if (toDate) query = query.lt('created_at', toDate.toISOString());
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

      if (classificationReviewIds) {
        query = query.in('id', classificationReviewIds);
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

      const normalizedSearch = this.normalizeForSearch(search);
      const usesClientSearch = Boolean(normalizedSearch);

      if (!usesClientSearch) {
        query = query.range(offset, offset + limit - 1);
      }

      // Wave 1: main query + summary in parallel
      const [{ data, error, count }, summary] = await Promise.all([
        query,
        summaryPromise,
      ]);

      if (error && error.code !== 'PGRST116') throw error;

      const reviewRows = (data || []) as ReviewRow[];

      if (reviewRows.length === 0) {
        return {
          data: [],
          pagination: { total: 0, page, limit, total_pages: 0 },
          summary,
        };
      }

      // Wave 2: batch fetch all related data in parallel — replaces N×4 sequential queries
      const placeIds = [...new Set(reviewRows.map((r) => r.place_id).filter(Boolean))];
      const touristIds = [...new Set(reviewRows.map((r) => r.tourist_id).filter(Boolean))];
      const reviewIds = reviewRows.map((r) => r.id);

      const [placesRes, usersRes, touristReviewsRes, contentsRes] =
        await Promise.all([
          supabase
            .schema('travel')
            .from('places')
            .select('id, name, address')
            .in('id', placeIds),
          supabase
            .schema('public')
            .from('users')
            .select('id, full_name')
            .in('id', touristIds),
          supabase
            .schema('review_ai')
            .from('reviews')
            .select('tourist_id')
            .in('tourist_id', touristIds),
          supabase
            .schema('review_ai')
            .from('review_contents')
            .select('review_id, main_topic, content, time_label')
            .in('review_id', reviewIds),
        ]);

      // Build O(1) lookup maps
      const placeMap = new Map<string, { name: string; address: string }>();
      for (const p of (placesRes.data || []) as Array<{ id: string; name: string; address: string }>) {
        placeMap.set(p.id, { name: p.name, address: p.address });
      }

      const userMap = new Map<string, string>();
      for (const u of (usersRes.data || []) as Array<{ id: string; full_name: string }>) {
        userMap.set(u.id, u.full_name);
      }

      const touristCountMap = new Map<string, number>();
      for (const r of (touristReviewsRes.data || []) as Array<{ tourist_id: string }>) {
        touristCountMap.set(r.tourist_id, (touristCountMap.get(r.tourist_id) || 0) + 1);
      }

      const contentMap = new Map<string, { main_topic: string | null; content: string | null; time_label: string | null }>();
      for (const c of (contentsRes.data || []) as Array<{ review_id: string; main_topic: string | null; content: string | null; time_label: string | null }>) {
        contentMap.set(c.review_id, {
          main_topic: c.main_topic,
          content: c.content,
          time_label: c.time_label,
        });
      }

      // Assemble results from maps — O(n) with no DB calls
      const reviewsList = reviewRows.map((review) => {
        const place = placeMap.get(review.place_id);
        const content = contentMap.get(review.id);

        return {
          id: review.id,
          reviewer_id: review.tourist_id,
          reviewer_name: userMap.get(review.tourist_id) || 'Unknown User',
          reviewer_review_count: touristCountMap.get(review.tourist_id) || 0,
          reviewer_report_count: 0,
          place_id: review.place_id,
          place_name: place?.name || 'Unknown Place',
          place_address: place?.address || '',
          rating: review.rating,
          review_content: content?.content ?? null,
          main_topic: content?.main_topic ?? null,
          time_label: content?.time_label ?? null,
          status: review.status,
          created_at: review.created_at,
          has_images: false,
        };
      });

      const filteredReviews = usesClientSearch
        ? reviewsList.filter((review) => {
            const searchableText = [
              review.reviewer_name,
              review.place_name,
              review.review_content,
            ]
              .map((item) => this.normalizeForSearch(item))
              .join(' ');
            return searchableText.includes(normalizedSearch);
          })
        : reviewsList;

      const total = usesClientSearch ? filteredReviews.length : (count ?? 0);
      const pagedReviews = usesClientSearch
        ? filteredReviews.slice(offset, offset + limit)
        : filteredReviews;

      return {
        data: pagedReviews,
        pagination: {
          total,
          page,
          limit,
          total_pages: Math.ceil(total / limit),
        },
        summary,
      };
    } catch (error) {
      console.error('Error fetching reviews:', error);
      throw new InternalServerErrorException('Failed to fetch reviews list');
    }
  }

  async getReviewDetail(reviewId: string): Promise<AdminReviewDetailDto> {
    if (!reviewId) throw new BadRequestException('Review ID is required');

    try {
      // Get review data
      const queryResult = await supabase
        .schema('review_ai')
        .from('reviews')
        .select('id, tourist_id, place_id, rating, created_at, status, violation_reason')
        .eq('id', reviewId)
        .single();

      const review = queryResult.data as ReviewRow | null;
      const error = queryResult.error;

      if (error) throw error;
      if (!review) throw new BadRequestException('Review not found');

      // Get place info
      let placeName = 'Unknown Place';
      let placeAddress = '';
      const { data: placeData } = (await supabase
        .schema('travel')
        .from('places')
        .select('name, address')
        .eq('id', review.place_id)
        .single()) as { data: PlaceData | null };
      if (placeData) {
        placeName = placeData.name;
        placeAddress = placeData.address;
      }

      // Get user info
      let userName = 'Unknown User';
      const { data: userData } = (await supabase
        .schema('public')
        .from('users')
        .select('full_name')
        .eq('id', review.tourist_id)
        .single()) as { data: UserData | null };
      if (userData) {
        userName = userData.full_name;
      }

      // Count reviews by user
      const { count: reviewCount = 0 } = await supabase
        .schema('review_ai')
        .from('reviews')
        .select('id', { count: 'exact' })
        .eq('tourist_id', review.tourist_id);

      // Get review content (optional: not every review has row in review_contents)
      const { data: contentData } = (await supabase
        .schema('review_ai')
        .from('review_contents')
        .select('content, main_topic, time_label')
        .eq('review_id', reviewId)
        .maybeSingle()) as { data: ReviewContentData | null };

      const reviewContent = contentData?.content ?? null;
      const mainTopic = contentData?.main_topic ?? null;
      const timeLabel = contentData?.time_label ?? null;

      return {
        id: review.id,
        user: {
          id: review.tourist_id,
          name: userName,
          review_count: reviewCount || 0,
          report_count: 0,
        },
        place: {
          id: review.place_id,
          name: placeName,
          address: placeAddress,
        },
        rating: review.rating,
        main_topic: mainTopic,
        time_label: timeLabel,
        review_content: reviewContent,
        images: [],
        status: review.status,
        violation_reason: review.violation_reason ?? null,
        created_at: review.created_at,
      };
    } catch (error) {
      console.error('Error fetching review detail:', error);
      throw new InternalServerErrorException('Failed to fetch review detail');
    }
  }

  async updateReviewStatus(
    reviewId: string,
    status: 'approved' | 'violation',
    reason?: string,
  ): Promise<{ success: boolean; message: string }> {
    if (!reviewId) throw new BadRequestException('Review ID is required');
    if (!['approved', 'violation'].includes(status)) {
      throw new BadRequestException('Invalid status');
    }

    if (status === 'violation' && !reason) {
      throw new BadRequestException('Reason is required for violation status');
    }

    try {
      const { error } = await supabase
        .schema('review_ai')
        .from('reviews')
        .update({
          status,
        })
        .eq('id', reviewId);

      if (error) throw error;

      return {
        success: true,
        message: `Review ${status === 'approved' ? 'approved' : 'marked as violation'} successfully`,
      };
    } catch (error) {
      console.error('Error updating review status:', error);
      throw new InternalServerErrorException('Failed to update review status');
    }
  }

}
