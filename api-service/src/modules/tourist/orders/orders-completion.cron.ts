import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { supabase } from '../../../config/supabase';

@Injectable()
export class OrdersCompletionCron {
  private readonly logger = new Logger(OrdersCompletionCron.name);

  @Cron('* * * * *')
  async autoCompleteOrders() {
    const now = new Date().toISOString();

    const { data: orders, error } = await supabase
      .schema('order_sys')
      .from('orders')
      .select('id')
      .eq('status', 'processing')
      .not('auto_complete_at', 'is', null)
      .lte('auto_complete_at', now)
      .limit(50);

    if (error) {
      this.logger.error('Failed to fetch orders for auto-completion', error.message);
      return;
    }

    if (!orders || orders.length === 0) return;

    const ids = (orders as Array<{ id: string }>).map((o) => o.id);

    const { error: updateError } = await supabase
      .schema('order_sys')
      .from('orders')
      .update({ status: 'completed' })
      .in('id', ids)
      .eq('status', 'processing'); // guard against race condition

    if (updateError) {
      this.logger.error('Failed to auto-complete orders', updateError.message);
    } else {
      this.logger.log(`Auto-completed ${ids.length} order(s)`);
    }
  }
}
