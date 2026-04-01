import {
  BadRequestException,
  Injectable,
  InternalServerErrorException,
  NotFoundException,
} from '@nestjs/common';
import { supabase } from '../../../config/supabase';

interface PlaceRow {
  id: string;
  name: string;
  is_approved: boolean | null;
  is_active: boolean | null;
  vendor_id: string | null;
}

interface ReviewRow {
  id: string;
  tourist_id: string;
  rating: number;
  created_at: string;
}

interface ReviewContentRow {
  review_id: string;
  content: string | null;
  main_topic: string | null;
}

interface UserRow {
  id: string;
  full_name: string | null;
}

interface BusinessRow {
  id: string;
}

type ReviewSort = 'newest' | 'oldest' | 'highest_rating' | 'lowest_rating';

@Injectable()
export class BusinessReviewsService {
  private async resolveVendorId(vendorId: string): Promise<string> {
    const normalizedVendorId = vendorId?.trim();

    if (!normalizedVendorId) {
      throw new BadRequestException('vendor_id is required');
    }

    const { data: existingPlaceRows, error: existingPlaceError } =
      await supabase
        .schema('travel')
        .from('places')
        .select('id')
        .eq('vendor_id', normalizedVendorId)
        .limit(1);

    if (existingPlaceError) {
      throw new InternalServerErrorException(existingPlaceError.message);
    }

    if ((existingPlaceRows ?? []).length > 0) {
      return normalizedVendorId;
    }

    const { data: businessRow, error: businessError } = await supabase
      .schema('public')
      .from('businesses')
      .select('id')
      .eq('id', normalizedVendorId)
      .maybeSingle<BusinessRow>();

    if (businessError) {
      throw new InternalServerErrorException(businessError.message);
    }

    return businessRow?.id ?? normalizedVendorId;
  }

  private mapPlaceStatus(
    isApproved: boolean | null,
  ): 'pending' | 'approved' | 'rejected' {
    if (isApproved === true) {
      return 'approved';
    }

    if (isApproved === false) {
      return 'rejected';
    }

    return 'pending';
  }

  private buildStarBreakdown(ratings: number[]) {
    const total = ratings.length;
    const counts: Record<number, number> = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };

    for (const rating of ratings) {
      if (rating >= 1 && rating <= 5) {
        counts[rating] += 1;
      }
    }

    return {
      5: {
        count: counts[5],
        percent: total ? Math.round((counts[5] / total) * 100) : 0,
      },
      4: {
        count: counts[4],
        percent: total ? Math.round((counts[4] / total) * 100) : 0,
      },
      3: {
        count: counts[3],
        percent: total ? Math.round((counts[3] / total) * 100) : 0,
      },
      2: {
        count: counts[2],
        percent: total ? Math.round((counts[2] / total) * 100) : 0,
      },
      1: {
        count: counts[1],
        percent: total ? Math.round((counts[1] / total) * 100) : 0,
      },
    };
  }

  async getReviews(
    placeId: string,
    vendorId: string,
    page: number = 1,
    limit: number = 10,
    rating?: number,
    sort: ReviewSort = 'newest',
    topic?: string,
    hasImages?: boolean,
  ) {
    const resolvedVendorId = await this.resolveVendorId(vendorId);

    if (
      !['newest', 'oldest', 'highest_rating', 'lowest_rating'].includes(sort)
    ) {
      throw new BadRequestException(
        'sort must be one of: newest, oldest, highest_rating, lowest_rating',
      );
    }

    const { data: place, error: placeError } = await supabase
      .schema('travel')
      .from('places')
      .select('id, name, is_approved, is_active, vendor_id')
      .eq('id', placeId)
      .eq('vendor_id', resolvedVendorId)
      .maybeSingle<PlaceRow>();

    if (placeError) {
      throw new InternalServerErrorException(placeError.message);
    }

    if (!place) {
      throw new NotFoundException('Place not found for this vendor');
    }

    // Load all ratings for overall stats in the header block.
    const { data: ratingRows, error: ratingError } = await supabase
      .schema('review_ai')
      .from('reviews')
      .select('id, rating')
      .eq('place_id', placeId);

    if (ratingError) {
      throw new InternalServerErrorException(ratingError.message);
    }

    const allRatings = (ratingRows ?? []).map((item) => item.rating as number);
    const totalReviews = allRatings.length;
    const averageRating = totalReviews
      ? Number(
          (
            allRatings.reduce((sum, current) => sum + current, 0) / totalReviews
          ).toFixed(1),
        )
      : 0;

    const starBreakdown = this.buildStarBreakdown(allRatings);

    const offset = (page - 1) * limit;

    let reviewQuery = supabase
      .schema('review_ai')
      .from('reviews')
      .select('id, tourist_id, rating, created_at', { count: 'exact' })
      .eq('place_id', placeId);

    if (typeof rating === 'number') {
      reviewQuery = reviewQuery.eq('rating', rating);
    }

    if (sort === 'newest') {
      reviewQuery = reviewQuery.order('created_at', { ascending: false });
    } else if (sort === 'oldest') {
      reviewQuery = reviewQuery.order('created_at', { ascending: true });
    } else if (sort === 'highest_rating') {
      reviewQuery = reviewQuery
        .order('rating', { ascending: false })
        .order('created_at', { ascending: false });
    } else if (sort === 'lowest_rating') {
      reviewQuery = reviewQuery
        .order('rating', { ascending: true })
        .order('created_at', { ascending: false });
    }

    const {
      data: reviewRows,
      error: reviewError,
      count,
    } = await reviewQuery.range(offset, offset + limit - 1);

    if (reviewError) {
      throw new InternalServerErrorException(reviewError.message);
    }

    const typedReviews = (reviewRows ?? []) as ReviewRow[];
    const reviewIds = typedReviews.map((item) => item.id);
    const userIds = typedReviews.map((item) => item.tourist_id).filter(Boolean);

    const [contentsResult, usersResult] = await Promise.all([
      reviewIds.length
        ? supabase
            .schema('review_ai')
            .from('review_contents')
            .select('review_id, content, main_topic')
            .in('review_id', reviewIds)
        : Promise.resolve({ data: [], error: null }),
      userIds.length
        ? supabase
            .schema('public')
            .from('users')
            .select('id, full_name')
            .in('id', userIds)
        : Promise.resolve({ data: [], error: null }),
    ]);

    if (contentsResult.error) {
      throw new InternalServerErrorException(contentsResult.error.message);
    }

    if (usersResult.error) {
      throw new InternalServerErrorException(usersResult.error.message);
    }

    const contents = (contentsResult.data ?? []) as ReviewContentRow[];
    const users = (usersResult.data ?? []) as UserRow[];

    const topicList = Array.from(
      new Set(
        contents
          .map((item) => item.main_topic)
          .filter((item): item is string => Boolean(item)),
      ),
    );

    let list = typedReviews.map((review) => {
      const user = users.find((item) => item.id === review.tourist_id);
      const content = contents.find((item) => item.review_id === review.id);

      return {
        id: review.id,
        user_name: user?.full_name ?? 'Ẩn danh',
        rating: review.rating,
        content: content?.content ?? '',
        main_topic: content?.main_topic ?? null,
        images: [],
        created_at: review.created_at,
      };
    });

    if (topic) {
      list = list.filter((item) => item.main_topic === topic);
    }

    if (hasImages === true) {
      list = list.filter((item) => item.images.length > 0);
    }

    return {
      place: {
        id: place.id,
        name: place.name,
        status: this.mapPlaceStatus(place.is_approved),
        is_active: Boolean(place.is_active),
      },
      stats: {
        average_rating: averageRating,
        total_reviews: totalReviews,
        breakdown: starBreakdown,
      },
      ai_insight:
        averageRating >= 4
          ? 'Khach hang danh gia cao chat luong dich vu tai dia diem nay.'
          : 'Can cai thien trai nghiem de nang cao diem danh gia tong the.',
      filters: {
        available_topics: topicList,
      },
      reviews: list,
      pagination: {
        page,
        limit,
        total: count || 0,
        pages: Math.ceil((count || 0) / limit),
      },
    };
  }
}
