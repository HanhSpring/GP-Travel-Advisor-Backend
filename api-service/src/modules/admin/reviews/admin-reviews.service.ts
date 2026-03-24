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

  async getReviews(
    page: number = 1,
    limit: number = 10,
    search?: string,
    status?: string,
    sort: ReviewSort = 'newest',
    classification?: ReviewClassification,
    dateSent: ReviewDateSent = 'all',
    rating?: number,
  ): Promise<AdminReviewListResponseDto> {
    if (page < 1) throw new BadRequestException('Page must be >= 1');
    if (limit < 1 || limit > 100)
      throw new BadRequestException('Limit must be between 1 and 100');

    const offset = (page - 1) * limit;

    try {
      // Get summary statistics
      const { data: allReviews, error: summaryError } = await supabase
        .schema('review_ai')
        .from('reviews')
        .select('status', { count: 'exact' });

      if (summaryError && summaryError.code !== 'PGRST116') throw summaryError;

      const reviews = allReviews || [];
      const summary = {
        total_reviews: reviews.length,
        pending_count: reviews.filter((r: ReviewRow) => r.status === 'pending')
          .length,
        approved_count: reviews.filter(
          (r: ReviewRow) => r.status === 'approved',
        ).length,
        violation_count: reviews.filter(
          (r: ReviewRow) => r.status === 'violation',
        ).length,
      };

      // Build base query - simplified without complex joins
      let query = supabase
        .schema('review_ai')
        .from('reviews')
        .select(
          `
          id,
          tourist_id,
          place_id,
          rating,
          created_at,
          review_type,
          status
        `,
          { count: 'exact' },
        );

      // Apply filters
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
          fromDate = new Date(
            now.getFullYear(),
            now.getMonth(),
            now.getDate(),
            0,
            0,
            0,
            0,
          );
        }

        if (dateSent === 'yesterday') {
          fromDate = new Date(
            now.getFullYear(),
            now.getMonth(),
            now.getDate() - 1,
            0,
            0,
            0,
            0,
          );
          toDate = new Date(
            now.getFullYear(),
            now.getMonth(),
            now.getDate(),
            0,
            0,
            0,
            0,
          );
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

      if (search) {
        const { data: placeRows, error: placeSearchError } = await supabase
          .schema('travel')
          .from('places')
          .select('id')
          .ilike('name', `%${search}%`);

        if (placeSearchError) throw placeSearchError;

        const placeIds = (placeRows || [])
          .map((item) => (item as { id: string }).id)
          .filter(Boolean);

        if (placeIds.length === 0) {
          return {
            data: [],
            pagination: {
              total: 0,
              page,
              limit,
              total_pages: 0,
            },
            summary,
          };
        }

        query = query.in('place_id', placeIds);
      }

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
            .eq('time_label', 'long_term');
        }

        if (normalizedClassification === 'short-term') {
          contentsQuery = contentsQuery
            .eq('processing_status', 'processed')
            .eq('time_label', 'short_term');
        }

        if (normalizedClassification === 'need-action') {
          contentsQuery = contentsQuery
            .eq('processing_status', 'processed')
            .eq('time_label', 'unknown');
        }

        if (normalizedClassification === 'unclassified') {
          contentsQuery = contentsQuery
            .eq('processing_status', 'pending')
            .is('time_label', null);
        }

        const { data: classifiedRows, error: classifiedError } =
          await contentsQuery;

        if (classifiedError) throw classifiedError;

        const reviewIds = (classifiedRows || [])
          .map((item) => (item as { review_id: string }).review_id)
          .filter(Boolean);

        if (reviewIds.length === 0) {
          return {
            data: [],
            pagination: {
              total: 0,
              page,
              limit,
              total_pages: 0,
            },
            summary,
          };
        }

        query = query.in('id', reviewIds);
      }

      // Apply sorting
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

      query = query.range(offset, offset + limit - 1);

      const { data, error, count } = await query;

      if (error && error.code !== 'PGRST116') throw error;

      // Process each review to fetch related data
      const reviewsList = await Promise.all(
        (data || []).map(async (review: ReviewRow) => {
          try {
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
              .schema('core')
              .from('users')
              .select('full_name')
              .eq('id', review.tourist_id)
              .single()) as { data: UserData | null };
            if (userData) {
              userName = userData.full_name;
            }

            // Count reviews by this user
            const { count: reviewCount = 0 } = await supabase
              .schema('review_ai')
              .from('reviews')
              .select('id', { count: 'exact' })
              .eq('tourist_id', review.tourist_id);

            // Get review content/topic (optional: not every review has row in review_contents)
            const { data: contentData } = (await supabase
              .schema('review_ai')
              .from('review_contents')
              .select('main_topic, content')
              .eq('review_id', review.id)
              .maybeSingle()) as { data: ReviewContentData | null };

            const mainTopic = contentData?.main_topic ?? null;
            const reviewContent = contentData?.content ?? null;

            return {
              id: review.id,
              reviewer_id: review.tourist_id,
              reviewer_name: userName,
              reviewer_review_count: reviewCount || 0,
              reviewer_report_count: 0,
              place_id: review.place_id,
              place_name: placeName,
              place_address: placeAddress,
              rating: review.rating,
              review_content: reviewContent,
              main_topic: mainTopic,
              status: review.status,
              created_at: review.created_at,
              has_images: false,
            };
          } catch (err) {
            console.error('Error processing review:', err);
            return {
              id: review.id,
              reviewer_id: review.tourist_id,
              reviewer_name: 'Unknown User',
              reviewer_review_count: 0,
              reviewer_report_count: 0,
              place_id: review.place_id,
              place_name: 'Unknown Place',
              place_address: '',
              rating: review.rating,
              review_content: null,
              main_topic: null,
              status: review.status,
              created_at: review.created_at,
              has_images: false,
            };
          }
        }),
      );

      const totalPages = Math.ceil((count || 0) / limit);

      return {
        data: reviewsList,
        pagination: {
          total: count || 0,
          page,
          limit,
          total_pages: totalPages,
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
        .select('id, tourist_id, place_id, rating, created_at, status')
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
        .schema('core')
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
        .select('content, main_topic')
        .eq('review_id', reviewId)
        .maybeSingle()) as { data: ReviewContentData | null };

      const reviewContent = contentData?.content ?? null;
      const mainTopic = contentData?.main_topic ?? null;

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
        review_content: reviewContent,
        images: [],
        status: review.status,
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

  getFilterOptions(): Promise<{
    statuses: Array<{ value: string; label: string }>;
    classifications: Array<{ value: string; label: string }>;
    date_sent_options: Array<{ value: string; label: string }>;
    rating_options: Array<{ value: string; label: string }>;
  }> {
    return Promise.resolve({
      statuses: [
        { value: 'pending', label: 'Chờ duyệt' },
        { value: 'approved', label: 'Đã duyệt' },
        { value: 'violation', label: 'Vi phạm' },
      ],
      classifications: [
        { value: 'long-term', label: 'Dài hạn' },
        { value: 'short-term', label: 'Ngắn hạn' },
        { value: 'need-action', label: 'Cần xử lý' },
        { value: 'unclassified', label: 'Chưa phân loại' },
      ],
      date_sent_options: [
        { value: 'all', label: 'Tất cả' },
        { value: 'today', label: 'Hôm nay' },
        { value: 'yesterday', label: 'Hôm qua' },
        { value: 'last_7_days', label: '7 ngày qua' },
        { value: 'last_30_days', label: '30 ngày qua' },
      ],
      rating_options: [
        { value: '1', label: '1 sao' },
        { value: '2', label: '2 sao' },
        { value: '3', label: '3 sao' },
        { value: '4', label: '4 sao' },
        { value: '5', label: '5 sao' },
      ],
    });
  }
}
