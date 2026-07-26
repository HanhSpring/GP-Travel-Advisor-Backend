import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { supabase } from '../../../config/supabase';

@Injectable()
export class ItineraryLifecycleCron implements OnModuleInit {
  private readonly logger = new Logger(ItineraryLifecycleCron.name);
  private running = false;

  /** Chạy ngay khi backend khởi động để dọn dữ liệu quá hạn còn tồn đọng. */
  onModuleInit() {
    void this.completeExpiredItineraries();
  }

  /** Chạy lúc 00:05 mỗi ngày theo giờ Việt Nam. */
  @Cron('0 5 0 * * *', { timeZone: 'Asia/Ho_Chi_Minh' })
  async completeExpiredItineraries() {
    if (this.running) return;
    this.running = true;
    try {
      const today = new Intl.DateTimeFormat('en-CA', {
        timeZone: 'Asia/Ho_Chi_Minh',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
      }).format(new Date());

      const { data, error } = await supabase
        .schema('travel')
        .from('itineraries')
        .update({ status: 'completed', tracking_active: false })
        .eq('status', 'ongoing')
        .lt('end_date', today)
        .select('id');

      if (error) {
        this.logger.error(
          'Failed to complete expired itineraries',
          error.message,
        );
        return;
      }

      if (data && data.length > 0) {
        this.logger.log(
          `Completed ${data.length} expired itinerary(s) before ${today}`,
        );
      }
    } finally {
      this.running = false;
    }
  }
}
