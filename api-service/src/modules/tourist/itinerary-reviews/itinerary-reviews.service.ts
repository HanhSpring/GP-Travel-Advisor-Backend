import {
  BadRequestException,
  Injectable,
  InternalServerErrorException,
  NotFoundException,
} from '@nestjs/common';
import { randomUUID } from 'crypto';
import { supabase } from '../../../config/supabase';
import { SubmitItineraryReviewDto } from './dto/submit-itinerary-review.dto';

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
  image_url: string | null;
}

interface ItineraryReviewRow {
  id: string;
  itinerary_id: string;
  tourist_id: string;
  overall_rating: number | null;
  overall_content: string | null;
  apply_all_places: boolean;
  status: 'draft' | 'submitted';
  popup_dismissed_at: string | null;
}

@Injectable()
export class ItineraryReviewsService {
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
      .select(
        'id, itinerary_id, tourist_id, overall_rating, overall_content, apply_all_places, status, popup_dismissed_at',
      )
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
          status: 'draft',
        },
      ])
      .select(
        'id, itinerary_id, tourist_id, overall_rating, overall_content, apply_all_places, status, popup_dismissed_at',
      )
      .single<ItineraryReviewRow>();

    this.handleTableError(error as { code?: string; message?: string } | null);

    if (!data) {
      throw new InternalServerErrorException(
        'Cannot initialize itinerary review draft',
      );
    }

    return data;
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

  async getPopup(touristId: string, itineraryId: string) {
    if (!touristId || !itineraryId) {
      throw new BadRequestException('tourist_id and itinerary_id are required');
    }

    const itinerary = await this.getItineraryOrThrow(touristId, itineraryId);
    const details = await this.getItineraryDetails(itineraryId);
    const placeIds = Array.from(new Set(details.map((item) => item.place_id)));
    const places = await this.getPlaces(placeIds);
    const coverImage = places[0]?.image_url ?? null;
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
        overall_rating: null,
        overall_content: null,
        apply_all_places: false,
        status: 'draft' as const,
      },
      actions: {
        detail_target: `/itinerary-reviews/${itinerary.id}/detail?tourist_id=${touristId}`,
        submit_target: `/itinerary-reviews/${itinerary.id}/submit`,
        dismiss_target: '/itinerary-reviews/popup/dismiss',
      },
    };
  }

  async dismissPopup(touristId: string, itineraryId: string) {
    if (!touristId || !itineraryId) {
      throw new BadRequestException('tourist_id and itinerary_id are required');
    }

    await this.getItineraryOrThrow(touristId, itineraryId);

    return {
      success: true,
      message: 'Popup dismissed successfully (not persisted)',
    };
  }

  async getDetail(touristId: string, itineraryId: string) {
    if (!touristId || !itineraryId) {
      throw new BadRequestException('tourist_id and itinerary_id are required');
    }

    const itinerary = await this.getItineraryOrThrow(touristId, itineraryId);
    const details = await this.getItineraryDetails(itineraryId);
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
        cover_image: places[0]?.image_url ?? null,
        total_places: details.length,
      },
      general_review: {
        overall_rating: null,
        overall_content: null,
        apply_all_places: false,
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
          place_image_url: place?.image_url ?? null,
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

    const hasOverallRating =
      payload.overall_rating !== null && payload.overall_rating !== undefined;
    const hasOverallContent = Boolean(normalizedOverallContent);
    const hasPlaceReviews = Boolean(payload.place_reviews?.length);

    if (!hasOverallRating && !hasOverallContent && !hasPlaceReviews) {
      throw new BadRequestException(
        'At least one review input is required: overall rating/content or place reviews',
      );
    }

    await this.getItineraryOrThrow(touristId, itineraryId);
    const details = await this.getItineraryDetails(itineraryId);

    if (details.length === 0) {
      throw new BadRequestException('Itinerary has no place details to review');
    }

    const reviewDraft = await this.getOrCreateReviewDraft(
      touristId,
      itineraryId,
    );

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

    const { error: updateReviewError } = await supabase
      .schema('review_ai')
      .from('itinerary_reviews')
      .update({
        overall_rating: payload.overall_rating ?? null,
        overall_content: normalizedOverallContent,
        apply_all_places: payload.apply_all_places ?? false,
        status: 'submitted',
        submitted_at: new Date().toISOString(),
        popup_dismissed_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq('id', reviewDraft.id);

    this.handleTableError(
      updateReviewError as { code?: string; message?: string } | null,
    );

    if (finalPlaceRatings.length > 0) {
      const newReviews = finalPlaceRatings.map((item) => ({
        id: randomUUID(),
        tourist_id: touristId,
        place_id: item.place_id,
        rating: item.rating,
        review_type: item.content ? 'with_content' : 'without_content',
      }));

      const { error: insertReviewsError } = await supabase
        .schema('review_ai')
        .from('reviews')
        .insert(newReviews);

      if (insertReviewsError) {
        throw new InternalServerErrorException(insertReviewsError.message);
      }

      const reviewContents = newReviews
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

    return {
      success: true,
      itinerary_review_id: reviewDraft.id,
      saved_place_reviews: finalPlaceRatings.length,
      saved_media_count: 0,
      message: 'Itinerary review submitted successfully',
    };
  }
}
