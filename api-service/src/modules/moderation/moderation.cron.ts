import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { supabase } from '../../config/supabase';
import { ModerationService } from './moderation.service';
import { NotificationsService } from '../tourist/notifications/notifications.service';
import { AdminAlgorithmSettingsService } from '../admin/algorithm-settings/admin-algorithm-settings.service';

@Injectable()
export class ModerationCron {
  private readonly logger = new Logger(ModerationCron.name);
  private lastRunTime: number = 0;
  private isProcessing: boolean = false;

  constructor(
    private readonly moderationService: ModerationService,
    private readonly notificationsService: NotificationsService,
    private readonly adminSettingsService: AdminAlgorithmSettingsService,
  ) {}

  @Cron('* * * * *') // Runs every minute, but we'll check interval
  async handleBatchModeration() {
    if (this.isProcessing) return;

    try {
      this.isProcessing = true;

      let intervalMinutes = 10;
      try {
        const settings = await this.adminSettingsService.getTwoTowerSettings();
        if (
          settings.core &&
          typeof settings.core.moderationBatchIntervalMinutes?.currentValue ===
            'number'
        ) {
          intervalMinutes =
            settings.core.moderationBatchIntervalMinutes.currentValue;
        }
      } catch (err: any) {
        if (
          err.status === 404 ||
          err.name === 'NotFoundException' ||
          (err.message && err.message.includes('seeded'))
        ) {
          // Ignore unseeded config and use default
        } else {
          throw err;
        }
      }

      const intervalMs = intervalMinutes * 60 * 1000;
      const now = Date.now();

      // Skip if interval has not passed since last run
      if (now - this.lastRunTime < intervalMs) {
        return;
      }

      this.lastRunTime = now;
      this.logger.log('Starting Review Moderation Batch Job...');

      // 2. Fetch pending reviews (limit 50 per batch)
      const { data: pendingReviews, error: fetchError } = await supabase
        .schema('review_ai')
        .from('reviews')
        .select('id, tourist_id, place_id, status')
        .eq('status', 'pending')
        .limit(50);

      if (fetchError || !pendingReviews || pendingReviews.length === 0) {
        if (fetchError)
          this.logger.error('Failed to fetch pending reviews', fetchError);
        return;
      }

      // We need to fetch contents for these reviews
      const reviewIds = pendingReviews.map((r) => r.id);
      const { data: contents } = await supabase
        .schema('review_ai')
        .from('review_contents')
        .select('review_id, content')
        .in('review_id', reviewIds);

      const contentMap = new Map<string, string>();
      if (contents) {
        contents.forEach((c) => contentMap.set(c.review_id, c.content || ''));
      }

      // 3. Process each review
      for (const review of pendingReviews) {
        const textContent = contentMap.get(review.id);

        // If there's no content, just approve it automatically
        if (!textContent || !textContent.trim()) {
          await this.updateReviewStatus(review.id, 'approved');
          continue;
        }

        const result = await this.moderationService.moderateReview(textContent);

        if (result.status === 'violation') {
          await this.updateReviewStatus(review.id, 'violation');
          await this.notificationsService.sendNotification(
            review.tourist_id,
            'Đánh giá vi phạm',
            `Đánh giá của bạn đã bị từ chối do vi phạm tiêu chuẩn cộng đồng (${result.violations.join(', ')}).`,
            'review_rejected',
          );
        } else if (result.status === 'approved') {
          await this.updateReviewStatus(review.id, 'approved');
          // Optional: Send success notification
          // await this.notificationsService.sendNotification(review.tourist_id, 'Đánh giá được phê duyệt', 'Đánh giá của bạn đã được công khai.', 'review_approved');
        } else if (result.status === 'pending') {
          // Manual review needed - keep status pending, don't send notification yet
          this.logger.warn(
            `Review ${review.id} flagged for manual review: ${result.violations.join(', ')}`,
          );
        }
      }

      this.logger.log(`Processed ${pendingReviews.length} pending reviews.`);
    } catch (error) {
      this.logger.error('Error during moderation batch job', error);
    } finally {
      this.isProcessing = false;
    }
  }

  private async updateReviewStatus(
    reviewId: string,
    status: 'approved' | 'violation',
  ) {
    await supabase
      .schema('review_ai')
      .from('reviews')
      .update({ status })
      .eq('id', reviewId);
  }
}
