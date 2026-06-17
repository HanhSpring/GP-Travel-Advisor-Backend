import { Injectable, InternalServerErrorException, NotFoundException, BadRequestException } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { randomUUID } from 'crypto';
import { supabase } from '../../../config/supabase';
import { ACTIVITY_LOG_EVENT } from '../../activity/activity.listener';
import { buildCirclePolygonEWKT, clampGeofenceRadius, computeDwellThresholdSeconds, DAY_END_HOUR, DEFAULT_VISIT_STATUS, NEXT_DAY_ALARM_HOUR, STATUS_LABEL_VI, STATUS_MAP_COLOR, STATUS_MAP_ICON, VisitStatus, vnTimestamp } from '../itinerary-tracking.constants';
import { ItineraryRow, DetailRow, PlaceRow, GeofenceRow, VisitRow } from '../itinerary-tracking.types';

const VISIT_COLS =
  'geofence_id, itinerary_detail_id, itinerary_id, tourist_id, track_date, status, recorded_at, dwell_seconds, dwell_threshold_seconds, expected_duration_minutes, entered_at, exited_at, enter_count, checked_in_at, last_event_type, geofences ( id, place_id, name, radius_m, is_active )';

@Injectable()
export class ItineraryTrackingQueryService {
  constructor(private readonly eventEmitter: EventEmitter2) {}

  // ───────────────────────── Helpers ─────────────────────────

  /** Ngày hiện tại theo giờ VN (YYYY-MM-DD). */
  public todayVN(): string {
    return new Date(Date.now() + 7 * 3600 * 1000).toISOString().slice(0, 10);
  }

  public resolveDate(date?: string): string {
    return date && date.trim() ? date.trim() : this.todayVN();
  }

  /** Chuẩn hoá lỗi DB; nhắc chạy migration nếu thiếu bảng/cột tracking. */
  public dbError(error: unknown, context: string): never {
    const err = error as { code?: string; message?: string };
    const msg = err?.message ?? String(error);
    const missingSchema =
      err?.code === 'PGRST205' ||
      err?.code === '42P01' || // undefined_table
      err?.code === '42703' || // undefined_column
      ((/geofence|tracking/i.test(msg) || /column/i.test(msg)) &&
        /(could not find|schema cache|does not exist)/i.test(msg));

    if (missingSchema) {
      throw new InternalServerErrorException(
        'Schema/bảng/cột tracking chưa khớp. Hãy chạy migration ' +
          'api-service/sql/2026_tracking_geofence.sql trong Supabase SQL Editor ' +
          '(thêm place_id/radius_m cho tracking.geofences và các cột dwell cho ' +
          'tracking.geofence_visits) rồi thử lại.',
      );
    }
    throw new InternalServerErrorException(`[${context}] ${msg}`);
  }

  public statusFields(status: VisitStatus) {
    return {
      statusLabelVi: STATUS_LABEL_VI[status],
      mapColor: STATUS_MAP_COLOR[status],
      mapIcon: STATUS_MAP_ICON[status],
    };
  }

  public async loadItinerary(
    itineraryId: string,
    touristId?: string,
  ): Promise<ItineraryRow> {
    const { data, error } = await supabase
      .schema('travel')
      .from('itineraries')
      .select('id, creator_id, status, start_date, end_date')
      .eq('id', itineraryId)
      .maybeSingle<ItineraryRow>();

    if (error) this.dbError(error, 'loadItinerary');
    if (!data) throw new NotFoundException('Không tìm thấy lịch trình');
    if (touristId && data.creator_id !== touristId) {
      throw new NotFoundException('Lịch trình không thuộc về người dùng này');
    }
    return data;
  }

  public async loadDetailsByDay(
    itineraryId: string,
    date: string,
  ): Promise<DetailRow[]> {
    const { data, error } = await supabase
      .schema('travel')
      .from('itinerary_details')
      .select(
        'id, itinerary_id, place_id, visit_date, duration_minutes, arrival_time, sequence_order',
      )
      .eq('itinerary_id', itineraryId)
      .eq('visit_date', date)
      .order('sequence_order', { ascending: true })
      .order('arrival_time', { ascending: true })
      .returns<DetailRow[]>();

    if (error) this.dbError(error, 'loadDetailsByDay');
    return data ?? [];
  }

  public async loadPlacesMap(
    placeIds: string[],
  ): Promise<Map<string, PlaceRow>> {
    const map = new Map<string, PlaceRow>();
    if (placeIds.length === 0) return map;

    const { data, error } = await supabase
      .schema('travel')
      .from('places')
      .select('id, name, latitude, longitude, address, visit_duration')
      .in('id', placeIds)
      .returns<PlaceRow[]>();

    if (error) this.dbError(error, 'loadPlaces');
    for (const place of data ?? []) map.set(place.id, place);
    return map;
  }

  /** Lấy các bản ghi ghé của một ngày (kèm geofence nhúng). */
  public async loadVisitsByDay(
    itineraryId: string,
    trackDate: string,
  ): Promise<VisitRow[]> {
    const { data, error } = await supabase
      .schema('tracking')
      .from('geofence_visits')
      .select(VISIT_COLS)
      .eq('itinerary_id', itineraryId)
      .eq('track_date', trackDate)
      .order('recorded_at', { ascending: true })
      .returns<VisitRow[]>();

    if (error) this.dbError(error, 'loadVisitsByDay');
    return data ?? [];
  }

  /**
   * Tìm hoặc tạo geofence cho 1 place (1 place ↔ 1 geofence, gắn place_id).
   * Polygon là vòng tròn xấp xỉ quanh toạ độ place.
   */
  public async ensureGeofenceForPlace(
    place: PlaceRow,
    radiusM: number,
  ): Promise<GeofenceRow> {
    const { data: existing, error: selErr } = await supabase
      .schema('tracking')
      .from('geofences')
      .select('id, place_id, name, radius_m, is_active')
      .eq('place_id', place.id)
      .limit(1)
      .returns<GeofenceRow[]>();
    if (selErr) this.dbError(selErr, 'ensureGeofence.select');
    if (existing && existing.length > 0) return existing[0];

    const row: Record<string, unknown> = {
      id: randomUUID(),
      place_id: place.id,
      name: place.name ?? 'Địa điểm',
      radius_m: radiusM,
      is_active: true,
      created_at: new Date().toISOString(),
    };
    if (place.latitude != null && place.longitude != null) {
      row.polygon = buildCirclePolygonEWKT(
        Number(place.longitude),
        Number(place.latitude),
        radiusM,
      );
    }

    const { data: inserted, error: insErr } = await supabase
      .schema('tracking')
      .from('geofences')
      .insert(row)
      .select('id, place_id, name, radius_m, is_active')
      .single<GeofenceRow>();
    if (insErr) this.dbError(insErr, 'ensureGeofence.insert');
    return inserted!;
  }

  /** Tìm 1 visit theo itineraryDetailId, hoặc theo (itineraryId, placeId, date). */
  public async resolveVisitRow(args: {
    itineraryDetailId?: string;
    itineraryId?: string;
    placeId?: string;
    date?: string;
  }): Promise<VisitRow> {
    let detailId = args.itineraryDetailId;

    if (!detailId) {
      if (!args.itineraryId || !args.placeId) {
        throw new BadRequestException(
          'Cần cung cấp itineraryDetailId, hoặc cả itineraryId + placeId',
        );
      }
      const { data, error } = await supabase
        .schema('travel')
        .from('itinerary_details')
        .select('id')
        .eq('itinerary_id', args.itineraryId)
        .eq('place_id', args.placeId)
        .eq('visit_date', this.resolveDate(args.date))
        .limit(1)
        .returns<{ id: string }[]>();
      if (error) this.dbError(error, 'resolveVisit.detail');
      if (!data || data.length === 0) {
        throw new NotFoundException(
          'Không tìm thấy điểm dừng tương ứng trong lịch trình.',
        );
      }
      detailId = data[0].id;
    }

    const { data, error } = await supabase
      .schema('tracking')
      .from('geofence_visits')
      .select(VISIT_COLS)
      .eq('itinerary_detail_id', detailId)
      .limit(1)
      .returns<VisitRow[]>();

    if (error) this.dbError(error, 'resolveVisitRow');
    if (!data || data.length === 0) {
      throw new NotFoundException(
        'Không tìm thấy bản ghi theo dõi. Hãy gọi /start cho ngày này trước.',
      );
    }
    return data[0];
  }

  public async placeName(placeId: string): Promise<string> {
    const { data } = await supabase
      .schema('travel')
      .from('places')
      .select('name')
      .eq('id', placeId)
      .maybeSingle<{ name: string | null }>();
    return data?.name ?? 'địa điểm';
  }

  /** Tạo thông báo push "Bạn đã đến ..." (không throw nếu lỗi). */
  public async createVisitNotification(
    touristId: string,
    placeName: string,
  ): Promise<string | null> {
    const message = `Bạn đã đến ${placeName}`;
    try {
      const notificationId = randomUUID();
      const nowIso = new Date().toISOString();

      const { error: nErr } = await supabase
        .schema('public')
        .from('notifications')
        .insert({
          id: notificationId,
          title: 'Check-in lịch trình',
          content: message,
          type: 'itinerary',
          is_global: false,
          created_at: nowIso,
        });
      if (nErr) throw nErr;

      const { error: uErr } = await supabase
        .schema('public')
        .from('users_notifications')
        .insert({
          id: randomUUID(),
          user_id: touristId,
          notification_id: notificationId,
          is_read: false,
          sent_at: nowIso,
        });
      if (uErr) throw uErr;

      return message;
    } catch (e) {
      console.warn(
        '[ItineraryTracking] Tạo thông báo thất bại:',
        (e as Error).message,
      );
      return null;
    }
  }

  public nextDayInfo(nextDayDate: string | null) {
    return {
      nextDayDate,
      nextDayAlarmAt: nextDayDate
        ? vnTimestamp(nextDayDate, NEXT_DAY_ALARM_HOUR)
        : null,
    };
  }

  public async findNextDay(
    itineraryId: string,
    afterDate: string,
  ): Promise<string | null> {
    const { data, error } = await supabase
      .schema('travel')
      .from('itinerary_details')
      .select('visit_date')
      .eq('itinerary_id', itineraryId)
      .gt('visit_date', afterDate)
      .order('visit_date', { ascending: true })
      .limit(1)
      .returns<{ visit_date: string | null }[]>();

    if (error) this.dbError(error, 'findNextDay');
    return data && data.length ? (data[0].visit_date ?? null) : null;
  }

  public buildSummary(rows: VisitRow[]) {
    const total = rows.length;
    const visited = rows.filter((r) => r.status === 'visited').length;
    const skipped = rows.filter((r) => r.status === 'skipped').length;
    const pending = rows.filter((r) => r.status === 'not_visited').length;
    return {
      total,
      visited,
      pending,
      skipped,
      progressPercent: total > 0 ? Math.round((visited / total) * 100) : 0,
    };
  }


  // ───────────────────────── Internal ─────────────────────────

  public async applyUpdate(
    row: VisitRow,
    updates: Record<string, unknown>,
  ): Promise<VisitRow> {
    const { error } = await supabase
      .schema('tracking')
      .from('geofence_visits')
      .update(updates)
      .eq('geofence_id', row.geofence_id)
      .eq('itinerary_detail_id', row.itinerary_detail_id);
    if (error) this.dbError(error, 'applyUpdate');
    return { ...row, ...(updates as Partial<VisitRow>) };
  }

  public emitVisited(touristId: string, placeId: string | null): void {
    if (!placeId) return;
    this.eventEmitter.emit(ACTIVITY_LOG_EVENT, {
      tourist_id: touristId,
      action_type: 'visited',
      place_id: placeId,
    });
  }

  public eventResponse(
    row: VisitRow,
    placeName: string,
    statusChanged: boolean,
    notificationCreated: boolean,
    notificationMessage: string | null,
    message: string,
  ) {
    return {
      itineraryDetailId: row.itinerary_detail_id,
      geofenceId: row.geofence_id,
      placeId: row.geofences?.place_id ?? null,
      placeName,
      status: row.status,
      statusLabelVi: STATUS_LABEL_VI[row.status],
      statusChanged,
      dwellSeconds: row.dwell_seconds,
      dwellThresholdSeconds: row.dwell_threshold_seconds,
      checkedInAt: row.checked_in_at,
      notificationCreated,
      notificationMessage,
      message,
    };
  }

}
