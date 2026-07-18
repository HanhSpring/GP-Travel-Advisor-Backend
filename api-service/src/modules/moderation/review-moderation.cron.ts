import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { createClient } from '@supabase/supabase-js';
import { ModerationService } from './moderation.service';
import { NotificationsService } from '../tourist/notifications/notifications.service';
import { createLimitedFetch } from 'src/config/supabase-http';

export interface ReviewSubmittedPayload {
  reviewIds?: string[];
  itineraryReviewId?: string;
}

const CATEGORY_LABELS_VI: Record<string, string> = {
  sexual: 'Nội dung khiêu dâm',
  'sexual/minors': 'Nội dung khiêu dâm liên quan trẻ em',
  harassment: 'Quấy rối',
  'harassment/threatening': 'Quấy rối kèm đe dọa',
  hate: 'Thù ghét / phân biệt',
  'hate/threatening': 'Thù ghét kèm đe dọa',
  illicit: 'Nội dung phi pháp',
  'illicit/violent': 'Nội dung phi pháp kèm bạo lực',
  'self-harm': 'Tự gây hại',
  'self-harm/intent': 'Ý định tự gây hại',
  'self-harm/instructions': 'Hướng dẫn tự gây hại',
  violence: 'Bạo lực',
  'violence/graphic': 'Bạo lực, hình ảnh phản cảm',
};

function translateCategories(categories: string[]): string[] {
  return categories.map((c) => CATEGORY_LABELS_VI[c] ?? c);
}

@Injectable()
export class ReviewModerationCronService {
  private readonly logger = new Logger(ReviewModerationCronService.name);
  private supabase;

  constructor(
    private readonly moderationService: ModerationService,
    private readonly notificationsService: NotificationsService,
  ) {
    this.supabase = createClient(
      process.env.SUPABASE_URL || '',
      process.env.SUPABASE_KEY || '',
      { global: { fetch: createLimitedFetch() } },
    );
  }

  @OnEvent('review.submitted', { async: true })
  async handleReviewSubmittedEvent() {
    this.logger.log('Starting real-time review moderation...');
    await this.processReviews('reviews');
    await this.processReviews('itinerary_reviews');
  }

  private async processReviews(tableName: 'reviews' | 'itinerary_reviews') {
    // 1. Fetch pending reviews
    const { data: pendingReviews, error: fetchError } = await this.supabase
      .schema('review_ai')
      .from(tableName)
      .select('*')
      .eq('status', 'pending')
      .limit(50);

    if (fetchError) {
      this.logger.error(`Error fetching pending ${tableName}:`, fetchError);
      return;
    }

    if (!pendingReviews || pendingReviews.length === 0) {
      return;
    }

    // Process reviews in parallel (bounded concurrency) instead of one at a
    // time — a burst of reviews submitted together no longer serializes
    // through OpenAI one-by-one.
    const CONCURRENCY = 5;
    for (let i = 0; i < pendingReviews.length; i += CONCURRENCY) {
      const chunk = pendingReviews.slice(i, i + CONCURRENCY);
      await Promise.all(
        chunk.map((review) => this.moderateSingleReview(tableName, review)),
      );
    }
  }

  private async moderateSingleReview(
    tableName: 'reviews' | 'itinerary_reviews',
    review: any,
  ) {
    try {
      const content = review.content || '';

      const url_image = review.url_image || [];

      // Single combined call checks text + media together (one OpenAI round-trip)
      const result = await this.moderationService.moderateReview(
        content || null,
        url_image,
      );

      const finalStatus = result.status;
      let violationReason = '';
      if (finalStatus === 'violation') {
        if (result.textViolations.length > 0) {
          violationReason = translateCategories(result.textViolations).join(
            ', ',
          );
        } else {
          violationReason = `Hình ảnh/Video vi phạm tiêu chuẩn cộng đồng`;
        }
      }

      // Update Status
      const updatePayload: any = { status: finalStatus };
      if (finalStatus === 'violation') {
        updatePayload.violation_reason = violationReason;
      }

      const { error: updateError } = await this.supabase
        .schema('review_ai')
        .from(tableName)
        .update(updatePayload)
        .eq('id', review.id);

      if (updateError) {
        this.logger.error(
          `Error updating ${tableName} ID ${review.id}:`,
          updateError,
        );
        return;
      }

      // Send Notification if violated
      if (finalStatus === 'violation' && review.tourist_id) {
        let notifContent = `Đánh giá của bạn vi phạm tiêu chuẩn cộng đồng`;
        let metadata: Record<string, unknown> | undefined;

        if (result.textViolations.length > 0) {
          notifContent = `Đánh giá của bạn vi phạm tiêu chuẩn cộng đồng: "${content}"`;
        } else {
          notifContent = `Hình ảnh/Video trong đánh giá của bạn vi phạm tiêu chuẩn cộng đồng`;
        }

        // Attach the specific violating image(s)/video(s) + category so the
        // notification detail view can show/highlight them.
        if (result.mediaViolationDetails.length > 0) {
          metadata = {
            violation_media: result.mediaViolationDetails.map((v) => ({
              url: v.url,
              media_type: v.mediaType,
              categories: translateCategories(v.categories),
            })),
          };
        }

        await this.notificationsService.sendNotification(
          review.tourist_id,
          'Đánh giá bị từ chối',
          notifContent,
          'system',
          metadata,
        );
      }
    } catch (err) {
      this.logger.error(`Error processing review ID ${review.id}:`, err);
    }
  }
}
