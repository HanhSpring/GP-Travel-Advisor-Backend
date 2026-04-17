import {
  BadRequestException,
  Injectable,
  InternalServerErrorException,
} from '@nestjs/common';
import { randomUUID } from 'crypto';
import axios from 'axios';
import { supabase } from '../../../config/supabase';

// Địa chỉ FastAPI optimizer/moderator
const AI_SERVICE_URL = process.env.AI_SERVICE_URL ?? 'http://localhost:8000';

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

    // ─── KIỂM DUYỆT NỘI DUNG TỰ ĐỘNG (OpenAI Moderation) ───────────
    if (payload.content) {
      try {
        const aiResponse = await axios.post(`${AI_SERVICE_URL}/api/v1/moderation/check`, {
          text: payload.content,
        });

        if (aiResponse.data.flagged) {
          throw new BadRequestException(
            'Bình luận của bạn vi phạm tiêu chuẩn cộng đồng (chứa ngôn từ không phù hợp). Vui lòng chỉnh sửa lại.',
          );
        }
      } catch (error) {
        // Nếu lỗi do flagged thì throw tiếp
        if (error instanceof BadRequestException) throw error;
        // Nếu lỗi kết nối AI Service → log lại nhưng vẫn cho phép lưu để tránh block user
        console.error('[ReviewsService] Moderation error:', error.message);
      }
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
