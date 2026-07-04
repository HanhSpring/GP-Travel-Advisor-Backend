import {
  BadRequestException,
  Injectable,
  InternalServerErrorException,
  NotFoundException,
} from '@nestjs/common';
import { randomUUID } from 'crypto';
import { supabase } from '../../../config/supabase';
import { PushNotificationService } from './push-notification.service';

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
  action_type?: string | null;
  action_label?: string | null;
  target_type?: string | null;
  place_id?: string | null;
  itinerary_id?: string | null;
  itinerary_detail_id?: string | null;
  metadata?: Record<string, unknown> | null;
  created_at: string | null;
}

interface VisitedPlaceTargetRow {
  itinerary_id: string | null;
  itinerary_detail_id: string;
  recorded_at: string | null;
  geofences?:
    | { place_id: string | null }
    | { place_id: string | null }[]
    | null;
}

interface PlaceNameRow {
  id: string;
  name: string | null;
}

interface ReviewStatusRow {
  place_id: string;
  itinerary_id: string | null;
}

interface CompletedItineraryRow {
  id: string;
  destination: string | null;
  start_date: string | null;
  end_date: string | null;
}

interface ItineraryReviewStatusRow {
  itinerary_id: string;
}

const NOTIFICATION_SELECT_WITH_ACTION =
  'id, title, content, type, is_global, action_type, target_type, metadata, created_at';
const NOTIFICATION_SELECT_BASE =
  'id, title, content, type, is_global, created_at';

@Injectable()
export class NotificationsService {
  constructor(private readonly pushService: PushNotificationService) {}
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

  private metadataString(base: NotificationRow, key: string): string | null {
    const value = base.metadata?.[key];
    return typeof value === 'string' && value.trim().length > 0 ? value : null;
  }

  private metadataBoolean(base: NotificationRow, key: string): boolean {
    return base.metadata?.[key] === true;
  }

  private formatDateVi(value: string | null): string | null {
    if (!value) return null;

    const [year, month, day] = value.slice(0, 10).split('-');
    if (!year || !month || !day) return value;

    return `${Number(day)}/${Number(month)}/${year}`;
  }

  private todayViDate(): string {
    return new Date(Date.now() + 7 * 60 * 60 * 1000).toISOString().slice(0, 10);
  }

  private buildCompletedItineraryContent(
    itinerary: CompletedItineraryRow,
  ): string {
    const itineraryTitle = itinerary.destination ?? 'của bạn';
    const startDate = this.formatDateVi(itinerary.start_date);
    const endDate = this.formatDateVi(itinerary.end_date);
    const dateRange =
      startDate && endDate
        ? ` từ ngày ${startDate} đến ngày ${endDate}`
        : startDate
          ? ` từ ngày ${startDate}`
          : endDate
            ? ` kết thúc ngày ${endDate}`
            : '';

    return `Lịch trình du lịch ${itineraryTitle}${dateRange} đã hoàn thành. Hãy chia sẻ trải nghiệm của bạn để chúng tôi có thể gợi ý tốt hơn cho những chuyến đi sau.`;
  }

  private buildNotificationItem(
    link: UserNotificationRow,
    base: NotificationRow,
  ) {
    const sentAt = link.sent_at || base.created_at || new Date().toISOString();
    const actionLabel =
      this.metadataString(base, 'action_label') ?? base.action_label ?? null;
    const placeId =
      this.metadataString(base, 'place_id') ?? base.place_id ?? null;
    const itineraryId =
      this.metadataString(base, 'itinerary_id') ?? base.itinerary_id ?? null;
    const itineraryDetailId =
      this.metadataString(base, 'itinerary_detail_id') ??
      base.itinerary_detail_id ??
      null;
    const shareStatus = this.metadataString(base, 'share_status');
    const actionType =
      shareStatus === 'accepted'
        ? 'itinerary_share_accepted'
        : shareStatus === 'rejected'
          ? 'itinerary_share_rejected'
          : base.action_type ?? null;

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
      action_type: actionType,
      action_label: actionLabel,
      target_type: base.target_type ?? null,
      place_id: placeId,
      itinerary_id: itineraryId,
      itinerary_detail_id: itineraryDetailId,
      has_place_review: this.metadataBoolean(base, 'has_place_review'),
      has_itinerary_review: this.metadataBoolean(base, 'has_itinerary_review'),
      metadata: base.metadata ?? null,
    };
  }

  private isPlaceReviewNotification(base: NotificationRow): boolean {
    const type = (base.type ?? '').toLowerCase();
    const actionType = (base.action_type ?? '').toLowerCase();
    const targetType = (base.target_type ?? '').toLowerCase();
    const title = (base.title ?? '').toLowerCase();

    if (
      actionType === 'review_itinerary' ||
      targetType === 'itinerary_review'
    ) {
      return false;
    }

    return (
      actionType === 'review_place' ||
      targetType === 'place_review' ||
      (type.includes('review') && !title.includes('lịch trình'))
    );
  }

  private isItineraryReviewNotification(base: NotificationRow): boolean {
    const actionType = (base.action_type ?? '').toLowerCase();
    const targetType = (base.target_type ?? '').toLowerCase();
    const title = (base.title ?? '').toLowerCase();

    return (
      actionType === 'review_itinerary' ||
      targetType === 'itinerary_review' ||
      title.includes('đánh giá lịch trình')
    );
  }

  private async ensureCompletedItineraryReviewNotifications(
    touristId: string,
  ): Promise<void> {
    const { data: itineraries, error: itineraryError } = await supabase
      .schema('travel')
      .from('itineraries')
      .select('id, destination, start_date, end_date')
      .eq('creator_id', touristId)
      .in('status', ['completed', 'uncompleted'])
      .lt('end_date', this.todayViDate());

    if (itineraryError || !itineraries || itineraries.length === 0) {
      return;
    }

    const completedItineraries = itineraries as CompletedItineraryRow[];
    const { data: links, error: linkError } = await supabase
      .schema('public')
      .from('users_notifications')
      .select('notification_id')
      .eq('user_id', touristId);

    if (linkError) {
      return;
    }

    const notificationIds = (links ?? [])
      .map((item) => item.notification_id)
      .filter((id): id is string => Boolean(id));

    const existingNotificationByItineraryId = new Map<string, string>();
    if (notificationIds.length > 0) {
      const existingNotifications =
        await this.selectNotificationsByIds(notificationIds);
      for (const notification of existingNotifications) {
        if (!this.isItineraryReviewNotification(notification)) {
          continue;
        }
        const itineraryId = this.metadataString(notification, 'itinerary_id');
        if (itineraryId) {
          existingNotificationByItineraryId.set(itineraryId, notification.id);
        }
      }
    }

    const nowIso = new Date().toISOString();
    for (const itinerary of completedItineraries) {
      const title = 'Đánh giá lịch trình';
      const content = this.buildCompletedItineraryContent(itinerary);
      const existingNotificationId = existingNotificationByItineraryId.get(
        itinerary.id,
      );

      if (existingNotificationId) {
        await supabase
          .schema('public')
          .from('notifications')
          .update({
            title,
            content,
            type: 'review',
            action_type: 'review_itinerary',
            target_type: 'itinerary_review',
            metadata: {
              action_label: 'Viết đánh giá',
              itinerary_id: itinerary.id,
            },
          })
          .eq('id', existingNotificationId);
        continue;
      }

      const notificationId = randomUUID();

      const { error: notificationError } = await supabase
        .schema('public')
        .from('notifications')
        .insert({
          id: notificationId,
          title,
          content,
          type: 'review',
          is_global: false,
          action_type: 'review_itinerary',
          target_type: 'itinerary_review',
          metadata: {
            action_label: 'Viết đánh giá',
            itinerary_id: itinerary.id,
          },
          created_at: nowIso,
        });

      if (notificationError) {
        continue;
      }

      await supabase.schema('public').from('users_notifications').insert({
        id: randomUUID(),
        user_id: touristId,
        notification_id: notificationId,
        is_read: false,
        sent_at: nowIso,
      });
    }
  }

  private needsReviewTarget(base: NotificationRow): boolean {
    return (
      this.isPlaceReviewNotification(base) &&
      (!base.action_type ||
        !(this.metadataString(base, 'itinerary_id') ?? base.itinerary_id) ||
        !(
          this.metadataString(base, 'itinerary_detail_id') ??
          base.itinerary_detail_id
        ))
    );
  }

  private applyReviewTarget(
    base: NotificationRow,
    target: {
      itineraryId: string | null;
      itineraryDetailId: string;
      placeId: string | null;
    },
  ): NotificationRow {
    const existingPlaceId =
      this.metadataString(base, 'place_id') ?? base.place_id;
    const existingItineraryId =
      this.metadataString(base, 'itinerary_id') ?? base.itinerary_id;
    const existingItineraryDetailId =
      this.metadataString(base, 'itinerary_detail_id') ??
      base.itinerary_detail_id;

    return {
      ...base,
      action_type: base.action_type ?? 'review_place',
      action_label: base.action_label ?? 'Đánh giá địa điểm',
      target_type: base.target_type ?? 'place_review',
      place_id: existingPlaceId ?? target.placeId,
      itinerary_id: existingItineraryId ?? target.itineraryId,
      itinerary_detail_id:
        existingItineraryDetailId ?? target.itineraryDetailId,
      metadata: {
        ...(base.metadata ?? {}),
        action_label: base.action_label ?? 'Danh gia dia diem',
        place_id: existingPlaceId ?? target.placeId,
        itinerary_id: existingItineraryId ?? target.itineraryId,
        itinerary_detail_id:
          existingItineraryDetailId ?? target.itineraryDetailId,
      },
    };
  }

  private visitPlaceId(visit: VisitedPlaceTargetRow): string | null {
    const geofence = Array.isArray(visit.geofences)
      ? visit.geofences[0]
      : visit.geofences;

    return geofence?.place_id ?? null;
  }

  private async attachPlaceReviewStatus(
    touristId: string,
    rows: NotificationRow[],
  ): Promise<NotificationRow[]> {
    const reviewRows = rows.filter((row) =>
      this.isPlaceReviewNotification(row),
    );
    if (reviewRows.length === 0) {
      return rows;
    }

    const placeIds = reviewRows
      .map((row) => this.metadataString(row, 'place_id') ?? row.place_id)
      .filter((id): id is string => Boolean(id));

    if (placeIds.length === 0) {
      return rows;
    }

    const { data, error } = await supabase
      .schema('review_ai')
      .from('reviews')
      .select('place_id, itinerary_id')
      .eq('tourist_id', touristId)
      .in('place_id', Array.from(new Set(placeIds)));

    if (error) {
      return rows;
    }

    const reviewTargets = ((data ?? []) as ReviewStatusRow[]).map((row) => ({
      placeId: row.place_id,
      itineraryId: row.itinerary_id,
    }));

    return rows.map((row) => {
      if (!this.isPlaceReviewNotification(row)) {
        return row;
      }

      const placeId = this.metadataString(row, 'place_id') ?? row.place_id;
      const itineraryId =
        this.metadataString(row, 'itinerary_id') ?? row.itinerary_id;
      const hasPlaceReview = reviewTargets.some((target) => {
        if (target.placeId !== placeId) {
          return false;
        }
        return !itineraryId || target.itineraryId === itineraryId;
      });

      return {
        ...row,
        metadata: {
          ...(row.metadata ?? {}),
          has_place_review: hasPlaceReview,
        },
      };
    });
  }

  private async attachItineraryReviewStatus(
    touristId: string,
    rows: NotificationRow[],
  ): Promise<NotificationRow[]> {
    const itineraryReviewRows = rows.filter((row) =>
      this.isItineraryReviewNotification(row),
    );
    if (itineraryReviewRows.length === 0) {
      return rows;
    }

    const itineraryIds = itineraryReviewRows
      .map(
        (row) => this.metadataString(row, 'itinerary_id') ?? row.itinerary_id,
      )
      .filter((id): id is string => Boolean(id));

    if (itineraryIds.length === 0) {
      return rows;
    }

    const { data, error } = await supabase
      .schema('review_ai')
      .from('itinerary_reviews')
      .select('itinerary_id')
      .eq('tourist_id', touristId)
      .in('itinerary_id', Array.from(new Set(itineraryIds)));

    if (error) {
      return rows;
    }

    const reviewedItineraryIds = new Set(
      ((data ?? []) as ItineraryReviewStatusRow[]).map(
        (row) => row.itinerary_id,
      ),
    );

    return rows.map((row) => {
      if (!this.isItineraryReviewNotification(row)) {
        return row;
      }

      const itineraryId =
        this.metadataString(row, 'itinerary_id') ?? row.itinerary_id;

      return {
        ...row,
        metadata: {
          ...(row.metadata ?? {}),
          has_itinerary_review: itineraryId
            ? reviewedItineraryIds.has(itineraryId)
            : false,
        },
      };
    });
  }

  private async attachReviewStatuses(
    touristId: string,
    rows: NotificationRow[],
  ): Promise<NotificationRow[]> {
    return this.attachItineraryReviewStatus(
      touristId,
      await this.attachPlaceReviewStatus(touristId, rows),
    );
  }

  private async inferReviewTargets(
    touristId: string,
    rows: NotificationRow[],
  ): Promise<NotificationRow[]> {
    if (!rows.some((row) => this.needsReviewTarget(row))) {
      return rows;
    }

    const { data: visits, error: visitsError } = await supabase
      .schema('tracking')
      .from('geofence_visits')
      .select(
        'itinerary_id, itinerary_detail_id, recorded_at, geofences ( place_id )',
      )
      .eq('tourist_id', touristId)
      .eq('status', 'visited')
      .order('recorded_at', { ascending: false })
      .limit(100);

    if (visitsError) {
      return rows;
    }

    const visitedRows = (visits ?? []) as unknown as VisitedPlaceTargetRow[];
    const placeIds = visitedRows
      .map((row) => this.visitPlaceId(row))
      .filter((id): id is string => Boolean(id));

    if (visitedRows.length === 0) {
      return rows;
    }

    const placesById = new Map<string, string>();
    if (placeIds.length > 0) {
      const { data: places } = await supabase
        .schema('travel')
        .from('places')
        .select('id, name')
        .in('id', Array.from(new Set(placeIds)));

      for (const place of (places ?? []) as PlaceNameRow[]) {
        placesById.set(place.id, place.name ?? '');
      }
    }

    return rows.map((row) => {
      if (!this.needsReviewTarget(row)) {
        return row;
      }

      const content = `${row.title ?? ''} ${row.content ?? ''}`.toLowerCase();
      const matchedVisit =
        visitedRows.find((visit) => {
          const placeId = this.visitPlaceId(visit);
          const placeName = placeId ? placesById.get(placeId) : null;
          return Boolean(
            placeName && content.includes(placeName.toLowerCase()),
          );
        }) ?? visitedRows[0];

      return this.applyReviewTarget(row, {
        itineraryId: matchedVisit.itinerary_id,
        itineraryDetailId: matchedVisit.itinerary_detail_id,
        placeId: this.visitPlaceId(matchedVisit),
      });
    });
  }

  private isOptionalNotificationColumnError(error: {
    code?: string;
    message?: string;
  }): boolean {
    return (
      error.code === '42703' ||
      error.code === 'PGRST204' ||
      /column|schema cache/i.test(error.message ?? '')
    );
  }

  private async selectNotificationsByIds(notificationIds: string[]) {
    const actionResult = await supabase
      .schema('public')
      .from('notifications')
      .select(NOTIFICATION_SELECT_WITH_ACTION)
      .in('id', notificationIds);
    let data = actionResult.data as NotificationRow[] | null;
    let error = actionResult.error;

    if (error && this.isOptionalNotificationColumnError(error)) {
      const fallback = await supabase
        .schema('public')
        .from('notifications')
        .select(NOTIFICATION_SELECT_BASE)
        .in('id', notificationIds);
      data = fallback.data as NotificationRow[] | null;
      error = fallback.error;
    }

    if (error) {
      throw new InternalServerErrorException(error.message);
    }

    return data ?? [];
  }

  private async selectNotificationById(notificationId: string) {
    const actionResult = await supabase
      .schema('public')
      .from('notifications')
      .select(NOTIFICATION_SELECT_WITH_ACTION)
      .eq('id', notificationId)
      .maybeSingle();
    let data = actionResult.data as NotificationRow | null;
    let error = actionResult.error;

    if (error && this.isOptionalNotificationColumnError(error)) {
      const fallback = await supabase
        .schema('public')
        .from('notifications')
        .select(NOTIFICATION_SELECT_BASE)
        .eq('id', notificationId)
        .maybeSingle();
      data = fallback.data as NotificationRow | null;
      error = fallback.error;
    }

    if (error) {
      throw new InternalServerErrorException(error.message);
    }

    return data;
  }

  async getNotifications(touristId: string) {
    if (!touristId) {
      throw new BadRequestException('tourist_id is required');
    }

    await this.ensureCompletedItineraryReviewNotifications(touristId);

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

    const notifications = await this.attachReviewStatuses(
      touristId,
      await this.inferReviewTargets(
        touristId,
        await this.selectNotificationsByIds(notificationIds),
      ),
    );
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

    let notificationRow = await this.selectNotificationById(notificationId);

    if (!notificationRow) {
      throw new NotFoundException('Notification not found');
    }
    [notificationRow] = await this.inferReviewTargets(touristId, [
      notificationRow,
    ]);
    [notificationRow] = await this.attachReviewStatuses(touristId, [
      notificationRow,
    ]);

    return this.buildNotificationItem(
      linkRow as UserNotificationRow,
      notificationRow,
    );
  }

  async markAsRead(touristId: string, notificationId: string) {
    if (!touristId) {
      throw new BadRequestException('tourist_id is required');
    }

    if (!notificationId) {
      throw new BadRequestException('notification id is required');
    }

    let notificationRow = await this.selectNotificationById(notificationId);

    if (!notificationRow) {
      throw new NotFoundException('Notification not found');
    }
    [notificationRow] = await this.inferReviewTargets(touristId, [
      notificationRow,
    ]);
    [notificationRow] = await this.attachReviewStatuses(touristId, [
      notificationRow,
    ]);

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
      notificationRow,
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

  async registerFcmToken(touristId: string, fcmToken: string): Promise<void> {
    if (!touristId || !fcmToken) {
      throw new BadRequestException('tourist_id and fcm_token are required');
    }

    const { error } = await supabase
      .schema('public')
      .from('users')
      .update({ fcm_token: fcmToken })
      .eq('id', touristId);

    if (error) {
      throw new InternalServerErrorException(error.message);
    }
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

    // Send FCM push notification (best-effort, non-blocking)
    const { data: userRow } = await supabase
      .schema('public')
      .from('users')
      .select('fcm_token')
      .eq('id', touristId)
      .maybeSingle();

    if (userRow?.fcm_token) {
      void this.pushService.sendPush(userRow.fcm_token, title, content, {
        notification_id: notification.id,
        type,
      });
    }
  }
}
