import {
  BadRequestException,
  Injectable,
  InternalServerErrorException,
  NotFoundException,
} from '@nestjs/common';
import { supabase } from '../../../config/supabase';

interface UserNotificationRow {
  id: string;
  notification_id: string;
  user_id: string;
  is_read: boolean | null;
  read_at: string | null;
  sent_at: string | null;
}

interface NotificationRow {
  id: string;
  title: string | null;
  content: string | null;
  type: string | null;
  is_global: boolean | null;
  created_at: string | null;
}

@Injectable()
export class NotificationsService {
  private mapIconKey(notificationType: string | null): string {
    const type = (notificationType ?? '').toLowerCase();

    if (type.includes('itinerary') || type.includes('trip')) {
      return 'map';
    }

    if (type.includes('review')) {
      return 'star';
    }

    if (type.includes('order') || type.includes('food')) {
      return 'food';
    }

    return 'info';
  }

  private buildTimeLabel(sentAt: string): string {
    const sentTime = new Date(sentAt).getTime();
    const now = Date.now();
    const diffMs = Math.max(0, now - sentTime);
    const diffMinutes = Math.floor(diffMs / 60000);

    if (diffMinutes < 1) {
      return 'Vừa xong';
    }

    if (diffMinutes < 60) {
      return `${diffMinutes} phút trước`;
    }

    const diffHours = Math.floor(diffMinutes / 60);

    if (diffHours < 24) {
      return `${diffHours} giờ trước`;
    }

    if (diffHours < 48) {
      return 'Hôm qua';
    }

    const diffDays = Math.floor(diffHours / 24);

    if (diffDays <= 7) {
      return `${diffDays} ngày trước`;
    }

    const date = new Date(sentAt);
    return date.toLocaleDateString('vi-VN');
  }

  private isUnreadStatus(isRead: boolean | null): boolean {
    return isRead !== true;
  }

  private buildNotificationItem(
    link: UserNotificationRow,
    base: NotificationRow,
  ) {
    const sentAt = link.sent_at || base.created_at || new Date().toISOString();

    return {
      id: base.id,
      title: base.title ?? 'Thông báo',
      content: base.content ?? '',
      notification_type: base.type,
      status: link.is_read ? 'read' : 'unread',
      is_global: base.is_global ?? false,
      read_at: link.read_at,
      sent_at: sentAt,
      time_label: this.buildTimeLabel(sentAt),
      icon_key: this.mapIconKey(base.type),
      is_unread: this.isUnreadStatus(link.is_read),
    };
  }

  async getNotifications(touristId: string) {
    if (!touristId) {
      throw new BadRequestException('tourist_id is required');
    }

    const { data: userNotificationRows, error: userNotificationError } =
      await supabase
        .schema('public')
        .from('users_notifications')
        .select('id, notification_id, user_id, is_read, read_at, sent_at')
        .eq('user_id', touristId)
        .order('sent_at', { ascending: false });

    if (userNotificationError) {
      throw new InternalServerErrorException(userNotificationError.message);
    }

    const links = (userNotificationRows ?? []) as UserNotificationRow[];

    if (links.length === 0) {
      return {
        tourist_id: touristId,
        total: 0,
        unread_count: 0,
        notifications: [],
      };
    }

    const notificationIds = links.map((item) => item.notification_id);

    const { data: notificationRows, error: notificationError } = await supabase
      .schema('public')
      .from('notifications')
      .select('id, title, content, type, is_global, created_at')
      .in('id', notificationIds);

    if (notificationError) {
      throw new InternalServerErrorException(notificationError.message);
    }

    const notifications = (notificationRows ?? []) as NotificationRow[];
    const notificationMap = new Map(
      notifications.map((item) => [item.id, item]),
    );

    const items = links
      .map((link) => {
        const base = notificationMap.get(link.notification_id);

        if (!base) {
          return null;
        }

        return this.buildNotificationItem(link, base);
      })
      .filter((item): item is NonNullable<typeof item> => Boolean(item));

    const unreadCount = items.filter((item) => item.is_unread).length;

    return {
      tourist_id: touristId,
      total: items.length,
      unread_count: unreadCount,
      notifications: items,
    };
  }

  async getNotificationDetail(touristId: string, notificationId: string) {
    if (!touristId) {
      throw new BadRequestException('tourist_id is required');
    }

    if (!notificationId) {
      throw new BadRequestException('notification id is required');
    }

    const { data: linkRow, error: linkError } = await supabase
      .schema('public')
      .from('users_notifications')
      .select('id, notification_id, user_id, is_read, read_at, sent_at')
      .eq('user_id', touristId)
      .eq('notification_id', notificationId)
      .maybeSingle();

    if (linkError) {
      throw new InternalServerErrorException(linkError.message);
    }

    if (!linkRow) {
      throw new NotFoundException('Notification was not sent to this tourist');
    }

    const { data: notificationRow, error: notificationError } = await supabase
      .schema('public')
      .from('notifications')
      .select('id, title, content, type, is_global, created_at')
      .eq('id', notificationId)
      .maybeSingle();

    if (notificationError) {
      throw new InternalServerErrorException(notificationError.message);
    }

    if (!notificationRow) {
      throw new NotFoundException('Notification not found');
    }

    return this.buildNotificationItem(
      linkRow as UserNotificationRow,
      notificationRow as NotificationRow,
    );
  }

  async markAsRead(touristId: string, notificationId: string) {
    if (!touristId) {
      throw new BadRequestException('tourist_id is required');
    }

    if (!notificationId) {
      throw new BadRequestException('notification id is required');
    }

    const { data: notificationRow, error: notificationError } = await supabase
      .schema('public')
      .from('notifications')
      .select('id, title, content, type, is_global, created_at')
      .eq('id', notificationId)
      .maybeSingle();

    if (notificationError) {
      throw new InternalServerErrorException(notificationError.message);
    }

    if (!notificationRow) {
      throw new NotFoundException('Notification not found');
    }

    const readAt = new Date().toISOString();
    const { data: updatedLinks, error: updateError } = await supabase
      .schema('public')
      .from('users_notifications')
      .update({ is_read: true, read_at: readAt })
      .eq('user_id', touristId)
      .eq('notification_id', notificationId)
      .select('id, notification_id, user_id, is_read, read_at, sent_at');

    if (updateError) {
      throw new InternalServerErrorException(updateError.message);
    }

    if (!updatedLinks || updatedLinks.length === 0) {
      throw new NotFoundException('Notification was not sent to this tourist');
    }

    return this.buildNotificationItem(
      updatedLinks[0] as UserNotificationRow,
      notificationRow as NotificationRow,
    );
  }

  async markAllAsRead(touristId: string) {
    if (!touristId) {
      throw new BadRequestException('tourist_id is required');
    }

    const readAt = new Date().toISOString();
    const { data: updatedRows, error } = await supabase
      .schema('public')
      .from('users_notifications')
      .update({ is_read: true, read_at: readAt })
      .eq('user_id', touristId)
      .or('is_read.is.null,is_read.eq.false')
      .select('id');

    if (error) {
      throw new InternalServerErrorException(error.message);
    }

    return {
      tourist_id: touristId,
      updated_count: updatedRows?.length ?? 0,
    };
  }

  async sendNotification(
    touristId: string,
    title: string,
    content: string,
    type: string,
  ): Promise<void> {
    const { data: notification, error: notifError } = await supabase
      .schema('public')
      .from('notifications')
      .insert({
        title,
        content,
        type,
        is_global: false,
      })
      .select('id')
      .single();

    if (notifError || !notification) {
      throw new InternalServerErrorException(
        notifError?.message ?? 'Failed to create notification',
      );
    }

    const { error: userNotifError } = await supabase
      .schema('public')
      .from('users_notifications')
      .insert({
        notification_id: notification.id,
        user_id: touristId,
        is_read: false,
        sent_at: new Date().toISOString(),
      });

    if (userNotifError) {
      throw new InternalServerErrorException(userNotifError.message);
    }
  }
}
