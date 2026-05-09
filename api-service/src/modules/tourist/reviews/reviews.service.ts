import {
  BadRequestException,
  Injectable,
  InternalServerErrorException,
} from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { randomUUID } from 'crypto';
import { supabase } from '../../../config/supabase';
import { ACTIVITY_LOG_EVENT } from '../../activity/activity.listener';

/** Trả về ISO-8601 string theo múi giờ Việt Nam (UTC+7) */
function getNowVN(): string {
  const now = new Date();
  const VN_OFFSET_MS = 7 * 60 * 60 * 1000;
  const vnTime = new Date(now.getTime() + VN_OFFSET_MS);
  return vnTime.toISOString().replace('Z', '+07:00');
}

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
    const createdAt = getNowVN();
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
      action_type: 'review',
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
