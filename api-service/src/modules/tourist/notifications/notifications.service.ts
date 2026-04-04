import {
  BadRequestException,
  Injectable,
  InternalServerErrorException,
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

        const sentAt =
          link.sent_at || base.created_at || new Date().toISOString();

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
}
