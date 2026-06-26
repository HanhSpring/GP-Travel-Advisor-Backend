import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { createClient } from '@supabase/supabase-js';
import { ModerationService } from './moderation.service';
import { NotificationsService } from '../tourist/notifications/notifications.service';

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
    );
  }

  @Cron('*/5 * * * *') // Run every 5 minutes
  async handleCron() {
    this.logger.log('Starting batch review moderation...');
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

    for (const review of pendingReviews) {
      try {
        const content = review.content || '';
        const url_image = review.url_image || [];
        
        let finalStatus = 'approved';
        let violationReason = '';

        // 1. Check Text
        if (content) {
          const textResult = await this.moderationService.moderateReview(content, []);
          if (textResult.status === 'violation') {
            finalStatus = 'violation';
            violationReason = `Nội dung văn bản: ${textResult.violations.join(', ')}`;
          }
        }

        // 2. Check Media if text is fine
        if (finalStatus === 'approved' && url_image.length > 0) {
          const mediaResult = await this.moderationService.moderateReview(null, url_image);
          if (mediaResult.status === 'violation') {
            finalStatus = 'violation';
            violationReason = `Hình ảnh/Video vi phạm tiêu chuẩn cộng đồng`;
          }
        }

        // 3. Update Status
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
          this.logger.error(`Error updating ${tableName} ID ${review.id}:`, updateError);
          continue;
        }

        // 4. Send Notification if violated
        if (finalStatus === 'violation' && review.tourist_id) {
          let notifContent = `Đánh giá của bạn vi phạm tiêu chuẩn cộng đồng`;
          if (violationReason.includes('Nội dung văn bản')) {
            // "trích xuất nội dung vi phạm" -> give a short snippet of their text
            const snippet = content.length > 50 ? content.substring(0, 50) + '...' : content;
            notifContent = `Đánh giá của bạn vi phạm tiêu chuẩn cộng đồng: "${snippet}"`;
          } else {
            notifContent = `Hình ảnh/Video trong đánh giá của bạn vi phạm tiêu chuẩn cộng đồng`;
          }

          await this.notificationsService.sendNotification(
            review.tourist_id,
            'Đánh giá bị từ chối',
            notifContent,
            'system',
          );
        }
      } catch (err) {
        this.logger.error(`Error processing review ID ${review.id}:`, err);
      }
    }
  }
}
