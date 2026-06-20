import {
  BadRequestException,
  Injectable,
  InternalServerErrorException,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'crypto';
import { supabase } from '../../../config/supabase';
import {
  SubmitItineraryReviewDto,
  SubmitReviewMediaDto,
} from './dto/submit-itinerary-review.dto';

interface ItineraryRow {
  id: string;
  creator_id: string;
  destination: string | null;
  start_date: string | null;
  end_date: string | null;
  status: string | null;
}

interface ItineraryDetailRow {
  id: string;
  itinerary_id: string;
  place_id: string;
  visit_date: string | null;
  arrival_time: string | null;
  departure_time: string | null;
}

interface PlaceRow {
  id: string;
  name: string;
  image_url: string[] | string | null;
}

interface ItineraryReviewRow {
  id: string;
  itinerary_id: string;
  tourist_id: string;
}

interface ItineraryFullReviewRow {
  id: string;
  rating: number | null;
  content: string | null;
  url_image: string[] | null;
}

interface PlaceReviewRow {
  id: string;
  place_id: string;
  rating: number | null;
  url_image: string[] | null;
}

interface ReviewContentRow {
  review_id: string;
  content: string | null;
}

@Injectable()
export class ItineraryReviewsService {
  constructor(private readonly configService: ConfigService) {}

  private normalizeOptionalText(value: unknown): string | null {
    if (typeof value !== 'string') {
      return null;
    }

    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
  }

  private handleTableError(error: { code?: string; message?: string } | null) {
    if (!error) {
      return;
    }

    if (error.code === '42P01' || error.code === 'PGRST205') {
      throw new InternalServerErrorException(
        'Missing itinerary review tables. Run migrations/create_itinerary_review_tables.sql first.',
      );
    }

    throw new InternalServerErrorException(error.message || 'Database error');
  }

  private getFirstPlaceImageUrl(place: PlaceRow | undefined): string | null {
    const imageUrl = place?.image_url;

    if (Array.isArray(imageUrl)) {
      const firstValidUrl = imageUrl.find(
        (item) => typeof item === 'string' && item.trim().length > 0,
      );
      return firstValidUrl?.trim() ?? null;
    }

    if (typeof imageUrl === 'string') {
      const trimmed = imageUrl.trim();
      return trimmed.length > 0 ? trimmed : null;
    }

    return null;
  }

  private async getItineraryOrThrow(touristId: string, itineraryId: string) {
    const { data: itinerary, error } = await supabase
      .schema('travel')
      .from('itineraries')
      .select('id, creator_id, destination, start_date, end_date, status')
      .eq('id', itineraryId)
      .eq('creator_id', touristId)
      .maybeSingle<ItineraryRow>();

    if (error) {
      throw new InternalServerErrorException(error.message);
    }

    if (!itinerary) {
      throw new NotFoundException('Itinerary not found for this tourist');
    }

    return itinerary;
  }

  private async getItineraryDetails(itineraryId: string) {
    const { data: details, error } = await supabase
      .schema('travel')
      .from('itinerary_details')
      .select(
        'id, itinerary_id, place_id, visit_date, arrival_time, departure_time',
      )
      .eq('itinerary_id', itineraryId)
      .order('visit_date', { ascending: true })
      .order('arrival_time', { ascending: true });

    if (error) {
      throw new InternalServerErrorException(error.message);
    }

    return (details ?? []) as ItineraryDetailRow[];
  }

  private async getPlaces(placeIds: string[]) {
    if (placeIds.length === 0) {
      return [] as PlaceRow[];
    }

    const { data: places, error } = await supabase
      .schema('travel')
      .from('places')
      .select('id, name, image_url')
      .in('id', placeIds);

    if (error) {
      throw new InternalServerErrorException(error.message);
    }

    return (places ?? []) as PlaceRow[];
  }

  private async getReviewDraft(touristId: string, itineraryId: string) {
    const { data, error } = await supabase
      .schema('review_ai')
      .from('itinerary_reviews')
      .select('id, itinerary_id, tourist_id')
      .eq('tourist_id', touristId)
      .eq('itinerary_id', itineraryId)
      .maybeSingle<ItineraryReviewRow>();

    this.handleTableError(error as { code?: string; message?: string } | null);

    return data;
  }

  private async getOrCreateReviewDraft(
    touristId: string,
    itineraryId: string,
  ): Promise<ItineraryReviewRow> {
    const existing = await this.getReviewDraft(touristId, itineraryId);

    if (existing) {
      return existing;
    }

    const { data, error } = await supabase
      .schema('review_ai')
      .from('itinerary_reviews')
      .insert([
        {
          tourist_id: touristId,
          itinerary_id: itineraryId,
        },
      ])
      .select('id, itinerary_id, tourist_id')
      .single<ItineraryReviewRow>();

    this.handleTableError(error as { code?: string; message?: string } | null);

    if (!data) {
      throw new InternalServerErrorException(
        'Cannot initialize itinerary review draft',
      );
    }

    return data;
  }

  private async saveItinerarySummaryReview(
    touristId: string,
    itineraryId: string,
    overallRating: number | null,
    overallContent: string | null,
    applyAllPlaces: boolean,
  ): Promise<string | null> {
    const isUnknownColumnError = (error: { code?: string; message?: string }) =>
      error.code === '42703' ||
      error.code === 'PGRST204' ||
      error.code === 'PGRST205' ||
      (error.message || '').includes('Could not find the') ||
      ((error.message || '').includes('column') &&
        (error.message || '').includes('does not exist'));

    const hasSummary = overallRating !== null || Boolean(overallContent);
    if (!hasSummary) {
      return null;
    }

    const existing = await this.getReviewDraft(touristId, itineraryId);
    let fallbackExistingId: string | null = null;

    if (!existing) {
      const { data: latestByItinerary } = await supabase
        .schema('review_ai')
        .from('itinerary_reviews')
        .select('id')
        .eq('itinerary_id', itineraryId)
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle<{ id: string }>();

      fallbackExistingId = latestByItinerary?.id ?? null;
    }

    const updateCandidates: Array<Record<string, unknown>> = [
      {
        tourist_id: touristId,
        itinerary_id: itineraryId,
        overall_rating: overallRating,
        overall_content: overallContent,
        apply_all_places: applyAllPlaces,
        is_approved: null,
      },
      {
        tourist_id: touristId,
        itinerary_id: itineraryId,
        rating: overallRating,
        content: overallContent,
        apply_all_places: applyAllPlaces,
        is_approved: null,
      },
      {
        tourist_id: touristId,
        itinerary_id: itineraryId,
        rating: overallRating,
        content: overallContent,
        status: 'pending',
      },
      {
        tourist_id: touristId,
        itinerary_id: itineraryId,
        rating: overallRating,
        content: overallContent,
      },
      {
        rating: overallRating,
        content: overallContent,
        status: 'pending',
      },
      {
        rating: overallRating,
        content: overallContent,
      },
      {
        tourist_id: touristId,
        itinerary_id: itineraryId,
        rating: overallRating,
        content: overallContent,
        is_approved: null,
      },
      {
        tourist_id: touristId,
        itinerary_id: itineraryId,
        score: overallRating,
        comment: overallContent,
        is_approved: null,
      },
    ];

    if (existing || fallbackExistingId != null) {
      const targetId = existing?.id ?? (fallbackExistingId as string);
      for (const candidate of updateCandidates) {
        const { error } = await supabase
          .schema('review_ai')
          .from('itinerary_reviews')
          .update(candidate)
          .eq('id', targetId);

        if (!error) {
          return targetId;
        }

        const isUnknownColumn = isUnknownColumnError(error);
        if (!isUnknownColumn) {
          throw new InternalServerErrorException(error.message);
        }
      }

      return targetId;
    }

    const baseCandidates: Array<Record<string, unknown>> = [
      {
        id: randomUUID(),
        tourist_id: touristId,
        itinerary_id: itineraryId,
        status: 'pending',
      },
      {
        tourist_id: touristId,
        itinerary_id: itineraryId,
        status: 'pending',
      },
      {
        id: randomUUID(),
        itinerary_id: itineraryId,
        status: 'pending',
      },
      {
        itinerary_id: itineraryId,
        status: 'pending',
      },
      {
        id: randomUUID(),
        tourist_id: touristId,
        itinerary_id: itineraryId,
        is_approved: null,
      },
      {
        tourist_id: touristId,
        itinerary_id: itineraryId,
        is_approved: null,
      },
      {
        id: randomUUID(),
        itinerary_id: itineraryId,
        is_approved: null,
      },
      {
        itinerary_id: itineraryId,
        is_approved: null,
      },
    ];

    for (const base of baseCandidates) {
      for (const update of updateCandidates) {
        const candidate = {
          ...base,
          ...update,
        };

        const { data, error } = await supabase
          .schema('review_ai')
          .from('itinerary_reviews')
          .insert([candidate])
          .select('id')
          .maybeSingle<{ id: string }>();

        if (!error) {
          return data?.id ?? null;
        }

        const isUnknownColumn = isUnknownColumnError(error);
        const isFkTouristError = (error.message || '').includes(
          'itinerary_reviews_tourist_id_fkey',
        );

        if (!isUnknownColumn && !isFkTouristError) {
          throw new InternalServerErrorException(error.message);
        }
      }
    }

    return null;
  }

  private async getItinerarySummaryReview(
    touristId: string,
    itineraryId: string,
  ): Promise<{
    overall_rating: number | null;
    overall_content: string | null;
    apply_all_places: boolean;
  }> {
    const selectVariants = [
      'id, itinerary_id, tourist_id, overall_rating, overall_content, apply_all_places',
      'id, itinerary_id, tourist_id, rating, content, apply_all_places',
      'id, itinerary_id, tourist_id, rating, content',
      'id, itinerary_id, tourist_id, score, comment',
    ];

    for (const fields of selectVariants) {
      for (const byTourist of [true, false]) {
        let query = supabase
          .schema('review_ai')
          .from('itinerary_reviews')
          .select(fields)
          .eq('itinerary_id', itineraryId)
          .order('created_at', { ascending: false })
          .limit(1);

        if (byTourist) {
          query = query.eq('tourist_id', touristId);
        }

        const { data: rows, error } =
          await query.returns<Record<string, unknown>[]>();

        if (error) {
          const isUnknownColumn =
            error.code === '42703' ||
            error.code === 'PGRST204' ||
            error.code === 'PGRST205' ||
            (error.message || '').includes('Could not find the') ||
            ((error.message || '').includes('column') &&
              (error.message || '').includes('does not exist'));

          if (isUnknownColumn) {
            break;
          }

          throw new InternalServerErrorException(error.message);
        }

        const data = rows != null && rows.length > 0 ? rows[0] : null;

        if (!data) {
          continue;
        }

        const overallRatingRaw =
          (data['overall_rating'] as number | null | undefined) ??
          (data['rating'] as number | null | undefined) ??
          (data['score'] as number | null | undefined) ??
          null;

        const overallContentRaw =
          (data['overall_content'] as string | null | undefined) ??
          (data['content'] as string | null | undefined) ??
          (data['comment'] as string | null | undefined) ??
          null;

        const applyAllRaw =
          (data['apply_all_places'] as boolean | null | undefined) ?? false;

        return {
          overall_rating:
            overallRatingRaw !== null && overallRatingRaw !== undefined
              ? Number(overallRatingRaw)
              : null,
          overall_content: overallContentRaw,
          apply_all_places: Boolean(applyAllRaw),
        };
      }
    }

    return {
      overall_rating: null,
      overall_content: null,
      apply_all_places: false,
    };
  }

  private getReviewMediaCount(payload: SubmitItineraryReviewDto) {
    return (
      (payload.media?.length ?? 0) +
      (payload.place_reviews ?? []).reduce(
        (total, item) => total + (item.media?.length ?? 0),
        0,
      )
    );
  }

  private validateReviewMediaCounts(payload: SubmitItineraryReviewDto) {
    const totalMediaCount = this.getReviewMediaCount(payload);

    if (totalMediaCount > 30) {
      throw new BadRequestException(
        'Review submit is limited to 30 media items',
      );
    }
  }

  private getR2PublicBaseUrl() {
    const publicR2Url = this.configService
      .get<string>('CLOUDFLARE_R2_PUBLIC_URL')
      ?.replace(/\/+$/, '');

    if (!publicR2Url) {
      throw new InternalServerErrorException(
        'Missing Cloudflare R2 public URL configuration',
      );
    }

    return publicR2Url;
  }

  private buildR2PublicUrl(objectKey: string) {
    return `${this.getR2PublicBaseUrl()}/${objectKey}`;
  }

  private validateReviewMediaObjectKey(params: {
    expectedPrefix: string;
    mediaType: 'image' | 'video';
    objectKey: string;
  }) {
    const objectKey = params.objectKey.trim();
    const expectedFolder = params.mediaType === 'image' ? 'images' : 'videos';

    if (
      objectKey.length === 0 ||
      objectKey.includes('\\') ||
      objectKey.startsWith('/') ||
      /^https?:\/\//i.test(objectKey) ||
      /^[a-zA-Z]:[\\/]/.test(objectKey)
    ) {
      throw new BadRequestException(
        `Invalid review media object_key: ${params.objectKey}`,
      );
    }

    if (!objectKey.startsWith(params.expectedPrefix)) {
      throw new BadRequestException(
        `object_key does not match expected review media prefix: ${objectKey}`,
      );
    }

    if (!objectKey.startsWith(`${params.expectedPrefix}${expectedFolder}/`)) {
      throw new BadRequestException(
        `object_key folder does not match media_type ${params.mediaType}: ${objectKey}`,
      );
    }

    return objectKey;
  }

  private buildReviewMediaUrls(params: {
    expectedPrefix: string;
    media: SubmitReviewMediaDto[];
  }): string[] {
    return [...params.media]
      .map((item, index) => ({
        objectKey: this.validateReviewMediaObjectKey({
          expectedPrefix: params.expectedPrefix,
          mediaType: item.media_type,
          objectKey: item.object_key,
        }),
        sortOrder: item.sort_order ?? index,
      }))
      .sort((a, b) => a.sortOrder - b.sortOrder)
      .map((item) => this.buildR2PublicUrl(item.objectKey));
  }

  private assertUniqueReviewMediaUrls(mediaUrls: string[]) {
    const seen = new Set<string>();

    for (const url of mediaUrls) {
      if (seen.has(url)) {
        throw new BadRequestException(
          `Duplicate review media object URL: ${url}`,
        );
      }

      seen.add(url);
    }
  }

  private async updateItineraryReviewImages(
    itineraryReviewId: string,
    mediaUrls: string[],
  ) {
    if (mediaUrls.length === 0) {
      return;
    }

    const { error } = await supabase
      .schema('review_ai')
      .from('itinerary_reviews')
      .update({ url_image: mediaUrls })
      .eq('id', itineraryReviewId);

    this.handleTableError(error as { code?: string; message?: string } | null);
  }

  private buildDayInfo(details: ItineraryDetailRow[]) {
    const orderedDates = Array.from(
      new Set(
        details
          .map((item) => item.visit_date)
          .filter((item): item is string => Boolean(item)),
      ),
    ).sort((a, b) => a.localeCompare(b));

    const dayByDate = new Map<string, string>();
    orderedDates.forEach((date, index) => {
      dayByDate.set(date, `DAY ${index + 1}`);
    });

    const dayFilters = [
      { value: 'all', label: 'Tất cả' },
      ...orderedDates.map((date, index) => ({
        value: date,
        label: `Ngày ${index + 1}`,
      })),
    ];

    return {
      dayByDate,
      dayFilters,
    };
  }

  private async getItineraryFullReview(
    touristId: string,
    itineraryId: string,
  ): Promise<ItineraryFullReviewRow | null> {
    for (const byTourist of [true, false]) {
      let query = supabase
        .schema('review_ai')
        .from('itinerary_reviews')
        .select('id, rating, content, url_image')
        .eq('itinerary_id', itineraryId)
        .order('created_at', { ascending: false })
        .limit(1);

      if (byTourist) {
        query = (query as typeof query).eq('tourist_id', touristId);
      }

      const { data, error } = await query.maybeSingle<ItineraryFullReviewRow>();

      if (error) {
        if (
          error.code === 'PGRST205' ||
          error.code === '42703' ||
          (error.message || '').includes('does not exist')
        ) {
          continue;
        }
        throw new InternalServerErrorException(error.message);
      }

      if (data) return data;
    }
    return null;
  }

  private async getPlaceReviewsForItinerary(
    touristId: string,
    itineraryId: string,
  ): Promise<
    Map<string, { rating: number | null; content: string | null; mediaUrls: string[] }>
  > {
    const { data: reviews, error } = await supabase
      .schema('review_ai')
      .from('reviews')
      .select('id, place_id, rating, url_image')
      .eq('tourist_id', touristId)
      .eq('itinerary_id', itineraryId)
      .returns<PlaceReviewRow[]>();

    if (error) throw new InternalServerErrorException(error.message);
    if (!reviews || reviews.length === 0) {
      return new Map();
    }

    const reviewIds = reviews.map((r) => r.id);
    const { data: contents } = await supabase
      .schema('review_ai')
      .from('review_contents')
      .select('review_id, content')
      .in('review_id', reviewIds)
      .returns<ReviewContentRow[]>();

    const contentByReviewId = new Map<string, string | null>(
      (contents ?? []).map((c) => [c.review_id, c.content]),
    );

    const byPlaceId = new Map<
      string,
      { rating: number | null; content: string | null; mediaUrls: string[] }
    >();
    for (const r of reviews) {
      byPlaceId.set(r.place_id, {
        rating: r.rating,
        content: contentByReviewId.get(r.id) ?? null,
        mediaUrls: Array.isArray(r.url_image) ? r.url_image : [],
      });
    }
    return byPlaceId;
  }

  async getSubmittedReview(touristId: string, itineraryId: string) {
    if (!touristId || !itineraryId) {
      throw new BadRequestException('tourist_id and itinerary_id are required');
    }

    const [itinerary, details, overallReview, placeReviewsMap] =
      await Promise.all([
        this.getItineraryOrThrow(touristId, itineraryId),
        this.getItineraryDetails(itineraryId),
        this.getItineraryFullReview(touristId, itineraryId),
        this.getPlaceReviewsForItinerary(touristId, itineraryId),
      ]);

    const placeIds = [...new Set(details.map((d) => d.place_id))];
    const places = await this.getPlaces(placeIds);
    const placeMap = new Map(places.map((p) => [p.id, p]));
    const { dayByDate } = this.buildDayInfo(details);

    return {
      itinerary: {
        id: itinerary.id,
        title: itinerary.destination ?? 'Lịch trình của bạn',
        start_date: itinerary.start_date ?? '',
        end_date: itinerary.end_date ?? '',
        cover_image: this.getFirstPlaceImageUrl(places[0]),
      },
      overall: {
        rating: overallReview?.rating ?? null,
        content: overallReview?.content ?? null,
        media_urls: Array.isArray(overallReview?.url_image)
          ? overallReview.url_image
          : [],
      },
      places: details.map((detail) => {
        const place = placeMap.get(detail.place_id);
        const placeReview = placeReviewsMap.get(detail.place_id);
        return {
          itinerary_detail_id: detail.id,
          day_label: detail.visit_date
            ? (dayByDate.get(detail.visit_date) ?? 'DAY')
            : 'DAY',
          place_name: place?.name ?? 'Địa điểm',
          place_image_url: this.getFirstPlaceImageUrl(place),
          rating: placeReview?.rating ?? null,
          content: placeReview?.content ?? null,
          media_urls: placeReview?.mediaUrls ?? [],
        };
      }),
    };
  }

  async getSummary(touristId: string, itineraryId: string) {
    if (!touristId || !itineraryId) {
      throw new BadRequestException('tourist_id and itinerary_id are required');
    }

    const summaryReview = await this.getItinerarySummaryReview(
      touristId,
      itineraryId,
    );

    return {
      has_review: summaryReview.overall_rating !== null,
      rating: summaryReview.overall_rating,
      content: summaryReview.overall_content,
    };
  }

  async getPopup(touristId: string, itineraryId: string) {
    if (!touristId || !itineraryId) {
      throw new BadRequestException('tourist_id and itinerary_id are required');
    }

    const itinerary = await this.getItineraryOrThrow(touristId, itineraryId);
    const details = await this.getItineraryDetails(itineraryId);
    const summaryReview = await this.getItinerarySummaryReview(
      touristId,
      itineraryId,
    );
    const placeIds = Array.from(new Set(details.map((item) => item.place_id)));
    const places = await this.getPlaces(placeIds);
    const coverImage = this.getFirstPlaceImageUrl(places[0]);
    const isCompleted = (itinerary.status ?? '').toLowerCase() === 'completed';

    const showPopup = isCompleted;
    const reason = isCompleted ? 'eligible' : 'itinerary_not_completed';

    return {
      show_popup: showPopup,
      reason,
      itinerary: {
        id: itinerary.id,
        title: itinerary.destination ?? 'Lịch trình của bạn',
        start_date: itinerary.start_date ?? '',
        end_date: itinerary.end_date ?? '',
        cover_image: coverImage,
      },
      draft: {
        overall_rating: summaryReview.overall_rating,
        overall_content: summaryReview.overall_content,
        apply_all_places: summaryReview.apply_all_places,
        status: 'draft' as const,
      },
      actions: {
        detail_target: `/itinerary-reviews/${itinerary.id}/detail?tourist_id=${touristId}`,
        submit_target: `/itinerary-reviews/${itinerary.id}/submit`,
        dismiss_target: '/itinerary-reviews/popup/dismiss',
      },
    };
  }

  async getDetail(touristId: string, itineraryId: string) {
    if (!touristId || !itineraryId) {
      throw new BadRequestException('tourist_id and itinerary_id are required');
    }

    const itinerary = await this.getItineraryOrThrow(touristId, itineraryId);
    const details = await this.getItineraryDetails(itineraryId);
    const summaryReview = await this.getItinerarySummaryReview(
      touristId,
      itineraryId,
    );
    const placeIds = Array.from(new Set(details.map((item) => item.place_id)));
    const places = await this.getPlaces(placeIds);
    const placeMap = new Map(places.map((item) => [item.id, item]));

    const { dayByDate, dayFilters } = this.buildDayInfo(details);

    return {
      itinerary: {
        id: itinerary.id,
        title: itinerary.destination ?? 'Lịch trình của bạn',
        start_date: itinerary.start_date ?? '',
        end_date: itinerary.end_date ?? '',
        status: itinerary.status,
        cover_image: this.getFirstPlaceImageUrl(places[0]),
        total_places: details.length,
      },
      general_review: {
        overall_rating: summaryReview.overall_rating,
        overall_content: summaryReview.overall_content,
        apply_all_places: summaryReview.apply_all_places,
      },
      day_filters: dayFilters,
      places: details.map((item) => {
        const place = placeMap.get(item.place_id);

        return {
          itinerary_detail_id: item.id,
          day_label: item.visit_date
            ? (dayByDate.get(item.visit_date) ?? 'DAY')
            : 'DAY',
          visit_date: item.visit_date ?? '',
          place_id: item.place_id,
          place_name: place?.name ?? 'Địa điểm',
          place_image_url: this.getFirstPlaceImageUrl(place),
          rating: null,
          content: null,
        };
      }),
      media_urls: [],
      actions: {
        submit_target: `/itinerary-reviews/${itinerary.id}/submit`,
      },
    };
  }

  async submitReview(
    touristId: string,
    itineraryId: string,
    payload: SubmitItineraryReviewDto,
  ) {
    if (!touristId || !itineraryId) {
      throw new BadRequestException('tourist_id and itinerary_id are required');
    }

    const normalizedOverallContent = this.normalizeOptionalText(
      payload.overall_content,
    );
    this.validateReviewMediaCounts(payload);

    const hasOverallRating =
      payload.overall_rating !== null && payload.overall_rating !== undefined;
    const hasOverallContent = Boolean(normalizedOverallContent);
    const hasPlaceReviews = Boolean(payload.place_reviews?.length);
    const hasItineraryMedia = Boolean(payload.media?.length);

    if (
      !hasOverallRating &&
      !hasOverallContent &&
      !hasPlaceReviews &&
      !hasItineraryMedia
    ) {
      throw new BadRequestException(
        'At least one review input is required: overall rating/content, media, or place reviews',
      );
    }

    await this.getItineraryOrThrow(touristId, itineraryId);
    const details = await this.getItineraryDetails(itineraryId);

    if (details.length === 0) {
      throw new BadRequestException('Itinerary has no place details to review');
    }

    let itineraryReviewId = await this.saveItinerarySummaryReview(
      touristId,
      itineraryId,
      hasOverallRating ? (payload.overall_rating as number) : null,
      normalizedOverallContent,
      payload.apply_all_places ?? false,
    );

    if (!itineraryReviewId) {
      const draft = await this.getOrCreateReviewDraft(touristId, itineraryId);
      itineraryReviewId = draft.id;
    }

    const detailById = new Map(details.map((item) => [item.id, item]));
    const ratingByDetailId = new Map<
      string,
      {
        itinerary_detail_id: string;
        place_id: string;
        rating: number;
        content: string | null;
      }
    >();

    if (payload.apply_all_places && hasOverallRating) {
      for (const item of details) {
        ratingByDetailId.set(item.id, {
          itinerary_detail_id: item.id,
          place_id: item.place_id,
          rating: payload.overall_rating as number,
          content: null,
        });
      }
    }

    for (const placeReview of payload.place_reviews ?? []) {
      const detail = detailById.get(placeReview.itinerary_detail_id);

      if (!detail) {
        throw new BadRequestException(
          `itinerary_detail_id ${placeReview.itinerary_detail_id} does not belong to itinerary ${itineraryId}`,
        );
      }

      ratingByDetailId.set(placeReview.itinerary_detail_id, {
        itinerary_detail_id: placeReview.itinerary_detail_id,
        place_id: detail.place_id,
        rating: placeReview.rating,
        content: this.normalizeOptionalText(placeReview.content),
      });
    }

    const finalPlaceRatings = Array.from(ratingByDetailId.values());
    const itineraryMediaUrls = this.buildReviewMediaUrls({
      expectedPrefix: `reviews/itineraries/${itineraryId}/`,
      media: payload.media ?? [],
    });
    const allMediaUrls = [...itineraryMediaUrls];

    const reviewsWithTags = finalPlaceRatings.map((item) => {
      const matchingPlaceReview = payload.place_reviews?.find(
        (placeReview) =>
          placeReview.itinerary_detail_id === item.itinerary_detail_id,
      );

      const tags: string[] | null = Array.isArray(matchingPlaceReview?.tags)
        ? [...matchingPlaceReview.tags]
        : null;

      return {
        source_itinerary_detail_id: item.itinerary_detail_id,
        url_image: this.buildReviewMediaUrls({
          expectedPrefix: `reviews/itinerary-details/${item.itinerary_detail_id}/`,
          media: matchingPlaceReview?.media ?? [],
        }),
        id: randomUUID(),
        tourist_id: touristId,
        itinerary_id: itineraryId,
        place_id: item.place_id,
        rating: item.rating,
        review_type: item.content ? 'with_content' : 'without_content',
        tags,
      };
    });

    for (const review of reviewsWithTags) {
      allMediaUrls.push(...review.url_image);
    }

    this.assertUniqueReviewMediaUrls(allMediaUrls);
    await this.updateItineraryReviewImages(
      itineraryReviewId,
      itineraryMediaUrls,
    );

    if (reviewsWithTags.length > 0) {
      const { error: insertReviewsError } = await supabase
        .schema('review_ai')
        .from('reviews')
        .insert(
          reviewsWithTags.map(({ source_itinerary_detail_id, ...review }) => ({
            ...review,
          })),
        );

      if (insertReviewsError) {
        throw new InternalServerErrorException(insertReviewsError.message);
      }

      const reviewContents = reviewsWithTags
        .map((review, index) => ({
          id: randomUUID(),
          review_id: review.id,
          content: finalPlaceRatings[index].content,
          processing_status: 'pending',
        }))
        .filter((item) => item.content !== null);

      if (reviewContents.length > 0) {
        const { error: insertReviewContentsError } = await supabase
          .schema('review_ai')
          .from('review_contents')
          .insert(reviewContents);

        if (insertReviewContentsError) {
          throw new InternalServerErrorException(
            insertReviewContentsError.message,
          );
        }
      }
    }

    const savedMediaCount = allMediaUrls.length;

    return {
      success: true,
      itinerary_review_id: itineraryReviewId,
      saved_place_reviews: finalPlaceRatings.length,
      saved_media_count: savedMediaCount,
      message: 'Itinerary review submitted successfully',
    };
  }
}
