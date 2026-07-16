import { Injectable, InternalServerErrorException, Logger } from '@nestjs/common';
import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { randomUUID } from 'crypto';
import { NotificationsGateway } from './notifications.gateway';

@Injectable()
export class CommonNotificationsService {
  private supabase: SupabaseClient;
  private readonly logger = new Logger(CommonNotificationsService.name);

  constructor(private readonly gateway: NotificationsGateway) {
    const supabaseUrl = process.env.SUPABASE_URL;
    const supabaseKey = process.env.SUPABASE_KEY;
    if (!supabaseUrl || !supabaseKey) {
      throw new Error('Missing Supabase URL or Anon Key');
    }
    this.supabase = createClient(supabaseUrl, supabaseKey);
  }

  async createNotification(
    userIds: string[],
    title: string,
    content: string,
    type: string,
    actionType?: string,
    metadata?: Record<string, unknown>,
  ) {
    if (!userIds || userIds.length === 0) {
      this.logger.warn(
        `createNotification called with no recipients (title="${title}", type="${type}") — notification was not created`,
      );
      return;
    }

    const notificationId = randomUUID();
    const nowIso = new Date().toISOString();

    const { error: notificationError } = await this.supabase
      .from('notifications')
      .insert({
        id: notificationId,
        title,
        content,
        type,
        is_global: false,
        action_type: actionType,
        metadata,
        created_at: nowIso,
      });

    if (notificationError) {
      throw new InternalServerErrorException(`Failed to create notification: ${notificationError.message}`);
    }

    const userNotifications = userIds.map((userId) => ({
      id: randomUUID(),
      user_id: userId,
      notification_id: notificationId,
      is_read: false,
      sent_at: nowIso,
    }));

    const { error: linkError } = await this.supabase
      .from('users_notifications')
      .insert(userNotifications);

    if (linkError) {
      throw new InternalServerErrorException(`Failed to link notification to users: ${linkError.message}`);
    }

    // id must be the per-user users_notifications row (what PATCH /notifications/:id/read targets),
    // not the shared notifications.id, otherwise marking a live-pushed notification as read no-ops.
    userNotifications.forEach((userNotification) => {
      this.gateway.sendNotificationToUser(userNotification.user_id, {
        id: userNotification.id,
        title,
        content,
        notification_type: type,
        status: 'unread',
        is_global: false,
        sent_at: nowIso,
        action_type: actionType,
        metadata,
      });
    });

    return notificationId;
  }

  async getAdminIds(): Promise<string[]> {
    const { data, error } = await this.supabase
      .from('users')
      .select('id, is_active')
      .eq('role', 'ADMIN');

    if (error) {
      throw new InternalServerErrorException(`Failed to get admin ids: ${error.message}`);
    }

    // is_active can surface as '1' or true depending on the query path (see roles.guard.ts)
    const activeAdminIds = (data || [])
      .filter((admin: any) => String(admin.is_active) === '1' || admin.is_active === true)
      .map((admin: any) => admin.id);

    if (activeAdminIds.length === 0) {
      this.logger.warn('getAdminIds() found no active ADMIN users to notify');
    }

    return activeAdminIds;
  }

  async notifyAdmins(
    title: string,
    content: string,
    type: string,
    actionType?: string,
    metadata?: Record<string, unknown>,
  ) {
    const adminIds = await this.getAdminIds();
    return this.createNotification(adminIds, title, content, type, actionType, metadata);
  }

  async getUserNotifications(userId: string, page: number = 1, limit: number = 20) {
    const offset = (page - 1) * limit;

    const { data, error, count } = await this.supabase
      .from('users_notifications')
      .select('id, is_read, sent_at, notification:notifications(*)', { count: 'exact' })
      .eq('user_id', userId)
      .order('sent_at', { ascending: false })
      .range(offset, offset + limit - 1);

    if (error) {
      throw new InternalServerErrorException(`Failed to get notifications: ${error.message}`);
    }

    const { count: unreadCount, error: unreadError } = await this.supabase
      .from('users_notifications')
      .select('*', { count: 'exact', head: true })
      .eq('user_id', userId)
      .eq('is_read', false);

    if (unreadError) {
      throw new InternalServerErrorException(`Failed to count unread notifications: ${unreadError.message}`);
    }

    return {
      data: data.map((item: any) => ({
        ...item.notification,
        // must win over notification.id — this is the row PATCH /notifications/:id/read updates
        id: item.id,
        is_read: item.is_read,
        sent_at: item.sent_at,
      })),
      meta: {
        total: count,
        page,
        limit,
        unread_count: unreadCount,
      }
    };
  }

  async markAsRead(userId: string, notificationId: string) {
    // If notificationId is 'all', mark all as read
    if (notificationId === 'all') {
      const { error } = await this.supabase
        .from('users_notifications')
        .update({ is_read: true, read_at: new Date().toISOString() })
        .eq('user_id', userId)
        .eq('is_read', false);
      
      if (error) throw new InternalServerErrorException(`Failed to mark all as read: ${error.message}`);
      return { success: true, message: 'All notifications marked as read' };
    }

    const { error } = await this.supabase
      .from('users_notifications')
      .update({ is_read: true, read_at: new Date().toISOString() })
      .eq('id', notificationId)
      .eq('user_id', userId);

    if (error) {
      throw new InternalServerErrorException(`Failed to mark notification as read: ${error.message}`);
    }

    return { success: true };
  }

  async deleteNotification(userId: string, notificationId: string) {
    const { error } = await this.supabase
      .from('users_notifications')
      .delete()
      .eq('id', notificationId)
      .eq('user_id', userId);

    if (error) {
      throw new InternalServerErrorException(`Failed to delete notification: ${error.message}`);
    }

    return { success: true };
  }
}
