import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { supabase } from '../../../config/supabase';
import { IncurredCostsService } from '../../itinerary/incurred-costs.service';

interface CompletableOrderRow {
  id: string;
  place_id: string | null;
  tourist_id: string | null;
  total_amount: number | null;
  itinerary_detail_id: string | null;
}

@Injectable()
export class OrdersCompletionCron {
  private readonly logger = new Logger(OrdersCompletionCron.name);

  constructor(private readonly incurredCostsService: IncurredCostsService) {}

  @Cron('* * * * *')
  async autoCompleteOrders() {
    const now = new Date().toISOString();

    const { data: orders, error } = await supabase
      .schema('order_sys')
      .from('orders')
      .select('id, place_id, tourist_id, total_amount, itinerary_detail_id')
      .eq('status', 'processing')
      .not('auto_complete_at', 'is', null)
      .lte('auto_complete_at', now)
      .limit(50)
      .returns<CompletableOrderRow[]>();

    if (error) {
      this.logger.error('Failed to fetch orders for auto-completion', error.message);
      return;
    }

    if (!orders || orders.length === 0) return;

    const ids = orders.map((o) => o.id);

    const { error: updateError } = await supabase
      .schema('order_sys')
      .from('orders')
      .update({ status: 'completed' })
      .in('id', ids)
      .eq('status', 'processing'); // guard against race condition

    if (updateError) {
      this.logger.error('Failed to auto-complete orders', updateError.message);
      return;
    }

    this.logger.log(`Auto-completed ${ids.length} order(s)`);

    // Ghi giá món ăn THẬT vào "Chi phí kế hoạch" của địa điểm — chỉ áp dụng
    // cho đơn có gắn itinerary_detail_id (đặt món từ trong 1 lịch trình cụ
    // thể). Lỗi ở bước này không được làm hỏng việc chuyển trạng thái đơn đã
    // thành công ở trên — chỉ log warn. Logic tra itinerary/dayNumber nằm
    // chung ở IncurredCostsService.recordCompletedOrderExpense() — dùng
    // chung với business.service.ts's updateOrderStatus() (chủ quán bấm
    // "Hoàn tất" tay), tránh lặp lại và lệch nhau.
    for (const order of orders) {
      try {
        await this.incurredCostsService.recordCompletedOrderExpense(order);
      } catch (err: any) {
        this.logger.warn(
          `Cannot record completed-order expense for order ${order.id}: ${err?.message ?? err}`,
        );
      }
    }
  }
}
