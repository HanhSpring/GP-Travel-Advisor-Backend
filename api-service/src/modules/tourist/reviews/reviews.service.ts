import {
  BadRequestException,
  Injectable,
  InternalServerErrorException,
  NotFoundException,
} from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { randomUUID } from 'crypto';
import { supabase } from '../../../config/supabase';
import { ACTIVITY_LOG_EVENT } from '../../activity/activity.listener';
import { getReviewActivityAction } from './review-activity';

interface CreateReviewPayload {
  tourist_id: string;
  place_id: string;
  itinerary_id?: string | null;
  rating: number;
  content?: string | null;
  tags?: string[] | null;
  images?: string[] | null;
}

export interface ReviewResponse {
  id: string;
  tourist_id: string;
  place_id: string;
  itinerary_id?: string | null;
  rating: number;
  created_at: string;
  content?: string | null;
  tags?: string[] | null;
  images?: string[] | null;
}

@Injectable()
export class ReviewsService {
  constructor(private readonly eventEmitter: EventEmitter2) {}

  private normalizeMediaUrls(value: unknown): string[] {
    let values: unknown[] = [];
    if (Array.isArray(value)) {
      values = value;
    } else if (typeof value === 'string' && value.trim()) {
      try {
        const decoded = JSON.parse(value) as unknown;
        values = Array.isArray(decoded) ? decoded : [value];
      } catch {
        values = [value];
      }
    }

    const publicUrl = (process.env.CLOUDFLARE_R2_PUBLIC_URL ?? '').replace(
      /\/$/,
      '',
    );
    return values
      .map((item) => String(item ?? '').trim())
      .filter(Boolean)
      .map((url) => {
        if (/^(https?:|data:|blob:)/i.test(url)) return url;
        return publicUrl ? `${publicUrl}/${url.replace(/^\//, '')}` : url;
      });
  }

  async getReviewCatalog(touristId: string, status = 'all') {
    if (!touristId) {
      throw new BadRequestException('tourist_id is required');
    }
    if (!['pending', 'reviewed', 'all'].includes(status)) {
      throw new BadRequestException('status must be pending, reviewed or all');
    }

    const { data: itineraries, error: itineraryError } = await supabase
      .schema('travel')
      .from('itineraries')
      .select('id, description, destination, start_date, end_date, status')
      .eq('creator_id', touristId)
      .order('end_date', { ascending: false });
    if (itineraryError) {
      throw new InternalServerErrorException(itineraryError.message);
    }

    const allItineraries = itineraries ?? [];
    const todayVi = new Date(Date.now() + 7 * 60 * 60 * 1000)
      .toISOString()
      .slice(0, 10);
    const completedItineraries = allItineraries.filter(
      (item) =>
        ['completed', 'uncompleted'].includes(
          String(item.status ?? '').toLowerCase(),
        ) &&
        Boolean(item.end_date) &&
        String(item.end_date).slice(0, 10) < todayVi,
    );
    const itineraryIds = allItineraries.map((item) => item.id as string);
    const [itineraryReviewResult, detailResult, placeReviewResult] =
      await Promise.all([
        supabase
          .schema('review_ai')
          .from('itinerary_reviews')
          .select('*')
          .eq('tourist_id', touristId),
        itineraryIds.length
          ? supabase
              .schema('travel')
              .from('itinerary_details')
              .select('id, itinerary_id, place_id, visit_date')
              .in('itinerary_id', itineraryIds)
          : Promise.resolve({ data: [], error: null }),
        supabase
          .schema('review_ai')
          .from('reviews')
          .select(
            'id, tourist_id, itinerary_id, place_id, rating, tags, url_image, status, review_type, created_at',
          )
          .eq('tourist_id', touristId)
          .order('created_at', { ascending: false }),
      ]);
    for (const result of [
      itineraryReviewResult,
      detailResult,
      placeReviewResult,
    ]) {
      if (result.error)
        throw new InternalServerErrorException(result.error.message);
    }

    const details = detailResult.data ?? [];
    const itineraryReviews = itineraryReviewResult.data ?? [];
    const placeReviews = placeReviewResult.data ?? [];
    const placeIds = Array.from(
      new Set(
        [
          ...details.map((item) => item.place_id as string),
          ...placeReviews.map((item) => item.place_id as string),
        ].filter(Boolean),
      ),
    );
    const { data: places, error: placeError } = placeIds.length
      ? await supabase
          .schema('travel')
          .from('places')
          .select('id, name, image_url')
          .in('id', placeIds)
      : { data: [], error: null };
    if (placeError) throw new InternalServerErrorException(placeError.message);
    const placeMap = new Map<
      string,
      { name?: string; image_url?: string | string[] | null }
    >();
    for (const item of places ?? []) placeMap.set(item.id as string, item);
    const itineraryMap = new Map<string, Record<string, any>>();
    for (const item of allItineraries)
      itineraryMap.set(item.id as string, item);
    const reviewIds = placeReviews.map((item) => item.id as string);
    const { data: reviewContents, error: contentError } = reviewIds.length
      ? await supabase
          .schema('review_ai')
          .from('review_contents')
          .select('review_id, content')
          .in('review_id', reviewIds)
      : { data: [], error: null };
    if (contentError)
      throw new InternalServerErrorException(contentError.message);
    const contentMap = new Map<string, string | null>();
    for (const item of reviewContents ?? []) {
      contentMap.set(item.review_id as string, item.content as string | null);
    }

    const reviewedItineraries = itineraryReviews
      .map((review) => {
        const itinerary = itineraryMap.get(review.itinerary_id);
        return {
          kind: 'itinerary',
          status: 'reviewed',
          review_id: review.id,
          itinerary_id: review.itinerary_id,
          itinerary_detail_id: null,
          place_id: null,
          title:
            itinerary?.description ||
            itinerary?.destination ||
            'Lịch trình của bạn',
          itinerary_title:
            itinerary?.description ||
            itinerary?.destination ||
            'Lịch trình của bạn',
          destination: itinerary?.destination ?? null,
          image_url: null,
          rating: Number(
            review.overall_rating ?? review.rating ?? review.score ?? 0,
          ),
          content:
            review.overall_content ?? review.content ?? review.comment ?? null,
          tags: review.tags ?? [],
          media_urls: this.normalizeMediaUrls(review.url_image),
          review_status: review.status ?? null,
          itinerary_status: itinerary?.status ?? null,
          place_reviews: placeReviews
            .filter(
              (placeReview) => placeReview.itinerary_id === review.itinerary_id,
            )
            .map((placeReview) => {
              const place = placeMap.get(placeReview.place_id);
              const detail = details.find(
                (item) =>
                  item.itinerary_id === placeReview.itinerary_id &&
                  item.place_id === placeReview.place_id,
              );
              return {
                review_id: placeReview.id,
                itinerary_detail_id: detail?.id ?? null,
                place_id: placeReview.place_id,
                place_name: place?.name ?? 'Địa điểm',
                place_image_url:
                  this.normalizeMediaUrls(place?.image_url)[0] ?? null,
                visit_date: detail?.visit_date ?? null,
                rating: Number(placeReview.rating),
                content: contentMap.get(placeReview.id) ?? null,
                tags: placeReview.tags ?? [],
                media_urls: this.normalizeMediaUrls(placeReview.url_image),
                status: placeReview.status ?? null,
                reviewed_at: placeReview.created_at ?? null,
              };
            }),
          reviewed_at: review.updated_at ?? review.created_at ?? null,
          start_date: itinerary?.start_date ?? null,
          end_date: itinerary?.end_date ?? null,
          visit_date: null,
        };
      })
      .filter((item) => itineraryMap.has(item.itinerary_id));
    const reviewedItineraryIds = new Set(
      reviewedItineraries.map((item) => item.itinerary_id),
    );
    const pendingItineraries = completedItineraries
      .filter((item) => !reviewedItineraryIds.has(item.id))
      .map((item) => ({
        kind: 'itinerary',
        status: 'pending',
        review_id: null,
        itinerary_id: item.id,
        itinerary_detail_id: null,
        place_id: null,
        title: item.description || item.destination || 'Lịch trình của bạn',
        itinerary_title:
          item.description || item.destination || 'Lịch trình của bạn',
        destination: item.destination ?? null,
        image_url: null,
        rating: null,
        content: null,
        tags: [],
        media_urls: [],
        review_status: null,
        itinerary_status: item.status ?? null,
        place_reviews: [],
        reviewed_at: null,
        start_date: item.start_date,
        end_date: item.end_date,
        visit_date: null,
      }));

    const reviewedPlaces = placeReviews.map((review) => {
      const place = placeMap.get(review.place_id);
      const detail = details.find(
        (item) =>
          item.itinerary_id === review.itinerary_id &&
          item.place_id === review.place_id,
      );
      return {
        kind: 'place',
        status: 'reviewed',
        review_id: review.id,
        itinerary_id: review.itinerary_id,
        itinerary_detail_id: detail?.id ?? null,
        place_id: review.place_id,
        title: place?.name ?? 'Địa điểm',
        itinerary_title:
          itineraryMap.get(review.itinerary_id)?.description ||
          itineraryMap.get(review.itinerary_id)?.destination ||
          null,
        destination: itineraryMap.get(review.itinerary_id)?.destination ?? null,
        image_url: this.normalizeMediaUrls(place?.image_url)[0] ?? null,
        rating: Number(review.rating),
        content: contentMap.get(review.id) ?? null,
        tags: review.tags ?? [],
        media_urls: this.normalizeMediaUrls(review.url_image),
        review_status: review.status ?? null,
        itinerary_status: itineraryMap.get(review.itinerary_id)?.status ?? null,
        reviewed_at: review.created_at,
        start_date: null,
        end_date: detail?.visit_date ?? null,
        visit_date: detail?.visit_date ?? null,
      };
    });
    const reviewedPlaceKeys = new Set(
      reviewedPlaces.map((item) => `${item.itinerary_id}:${item.place_id}`),
    );
    const completedItineraryIds = new Set(
      completedItineraries.map((item) => item.id as string),
    );
    const pendingPlaces = details
      .filter(
        (detail) =>
          completedItineraryIds.has(detail.itinerary_id) &&
          !reviewedPlaceKeys.has(`${detail.itinerary_id}:${detail.place_id}`),
      )
      .map((detail) => {
        const place = placeMap.get(detail.place_id);
        return {
          kind: 'place',
          status: 'pending',
          review_id: null,
          itinerary_id: detail.itinerary_id,
          itinerary_detail_id: detail.id,
          place_id: detail.place_id,
          title: place?.name ?? 'Địa điểm',
          itinerary_title:
            itineraryMap.get(detail.itinerary_id)?.description ||
            itineraryMap.get(detail.itinerary_id)?.destination ||
            'Lịch trình của bạn',
          destination:
            itineraryMap.get(detail.itinerary_id)?.destination ?? null,
          image_url: this.normalizeMediaUrls(place?.image_url)[0] ?? null,
          rating: null,
          content: null,
          tags: [],
          media_urls: [],
          review_status: null,
          itinerary_status:
            itineraryMap.get(detail.itinerary_id)?.status ?? null,
          reviewed_at: null,
          start_date: null,
          end_date: detail.visit_date,
          visit_date: detail.visit_date,
        };
      });

    const pending = [...pendingItineraries, ...pendingPlaces];
    const reviewed = [...reviewedItineraries, ...reviewedPlaces].sort((a, b) =>
      String(b.reviewed_at ?? '').localeCompare(String(a.reviewed_at ?? '')),
    );
    return {
      pending: status === 'reviewed' ? [] : pending,
      reviewed: status === 'pending' ? [] : reviewed,
      counts: { pending: pending.length, reviewed: reviewed.length },
    };
  }

  async getReview(reviewId: string, touristId: string) {
    if (!touristId) throw new BadRequestException('tourist_id is required');
    const { data: review, error } = await supabase
      .schema('review_ai')
      .from('reviews')
      .select(
        'id, tourist_id, itinerary_id, place_id, rating, tags, created_at',
      )
      .eq('id', reviewId)
      .eq('tourist_id', touristId)
      .maybeSingle();
    if (error) throw new InternalServerErrorException(error.message);
    if (!review) throw new NotFoundException('Review not found');
    const { data: content } = await supabase
      .schema('review_ai')
      .from('review_contents')
      .select('content')
      .eq('review_id', reviewId)
      .maybeSingle();
    return { ...review, content: content?.content ?? null };
  }

  async createReview(payload: CreateReviewPayload): Promise<ReviewResponse> {
    if (!payload.tourist_id || !payload.place_id) {
      throw new BadRequestException('tourist_id and place_id are required');
    }

    if (
      typeof payload.rating !== 'number' ||
      payload.rating < 1 ||
      payload.rating > 5
    ) {
      throw new BadRequestException('rating must be a number between 1 and 5');
    }

    const reviewId = randomUUID();
    const createdAt = new Date().toISOString();
    const reviewType = payload.content ? 'with_content' : 'without_content';

    const { error: reviewError } = await supabase
      .schema('review_ai')
      .from('reviews')
      .insert([
        {
          id: reviewId,
          tourist_id: payload.tourist_id,
          place_id: payload.place_id,
          itinerary_id: payload.itinerary_id ?? null,
          rating: payload.rating,
          review_type: reviewType,
          tags: payload.tags ?? null,
        },
      ]);

    if (reviewError) {
      throw new InternalServerErrorException(
        `Failed to create review: ${reviewError?.message || 'Unknown error'}`,
      );
    }

    if (payload.content !== undefined && payload.content !== null) {
      const { error: contentError } = await supabase
        .schema('review_ai')
        .from('review_contents')
        .insert([
          {
            id: randomUUID(),
            review_id: reviewId,
            content: payload.content,
            processing_status: 'pending',
          },
        ]);

      if (contentError) {
        console.warn(
          `Warning: Failed to insert review content: ${contentError.message}`,
        );
      }
    }

    this.eventEmitter.emit(ACTIVITY_LOG_EVENT, {
      tourist_id: payload.tourist_id,
      action_type: getReviewActivityAction(payload.content),
      place_id: payload.place_id,
    });

    return {
      id: reviewId,
      tourist_id: payload.tourist_id,
      place_id: payload.place_id,
      itinerary_id: payload.itinerary_id ?? null,
      rating: payload.rating,
      created_at: createdAt,
      content: payload.content || null,
      tags: payload.tags || null,
      images: payload.images || null,
    };
  }
}
