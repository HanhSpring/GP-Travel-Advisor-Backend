import {
  BadRequestException,
  Injectable,
  InternalServerErrorException,
  NotFoundException,
} from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { randomUUID } from 'crypto';
import { supabase } from '../../config/supabase';
import { ACTIVITY_LOG_EVENT } from '../activity/activity.listener';
import {
  buildCirclePolygonEWKT,
  clampGeofenceRadius,
  computeDwellThresholdSeconds,
  DAY_END_HOUR,
  DEFAULT_VISIT_STATUS,
  NEXT_DAY_ALARM_HOUR,
  STATUS_LABEL_VI,
  STATUS_MAP_COLOR,
  STATUS_MAP_ICON,
  VisitStatus,
  vnTimestamp,
} from './itinerary-tracking.constants';
import { StartTrackingDto } from './dto/start-tracking.dto';
import { GeofenceEventDto } from './dto/geofence-event.dto';
import { CheckInDto } from './dto/check-in.dto';
import { EndDayDto } from './dto/end-day.dto';
import {
  GeofencesQueryDto,
  TrackingStatusQueryDto,
} from './dto/tracking-query.dto';

interface ItineraryRow {
  id: string;
  creator_id: string;
  status: string | null;
  start_date: string | null;
  end_date: string | null;
}

interface DetailRow {
  id: string;
  itinerary_id: string;
  place_id: string;
  visit_date: string | null;
  duration_minutes: number | null;
  arrival_time: string | null;
  sequence_order: number | null;
}

interface PlaceRow {
  id: string;
  name: string | null;
  latitude: number | null;
  longitude: number | null;
  address: string | null;
  visit_duration: number | null;
}

/** Bản ghi tracking.geofences (đã thêm place_id + radius_m so với bản gốc). */
interface GeofenceRow {
  id: string;
  place_id: string | null;
  name: string | null;
  radius_m: number | null;
  is_active: boolean | null;
}

/**
 * Bản ghi tracking.geofence_visits.
 * PK ghép (geofence_id, itinerary_detail_id). Các cột dwell/audit được thêm
 * qua migration để giữ nguyên logic dwell time của use case.
 */
interface VisitRow {
  geofence_id: string;
  itinerary_detail_id: string;
  itinerary_id: string | null;
  tourist_id: string | null;
  track_date: string | null;
  status: VisitStatus;
  recorded_at: string | null;
  dwell_seconds: number;
  dwell_threshold_seconds: number;
  expected_duration_minutes: number | null;
  entered_at: string | null;
  exited_at: string | null;
  enter_count: number;
  checked_in_at: string | null;
  last_event_type: string | null;
  // geofence nhúng kèm khi select (PostgREST embedding cùng schema).
  geofences?: GeofenceRow | null;
}

const VISIT_COLS =
  'geofence_id, itinerary_detail_id, itinerary_id, tourist_id, track_date, status, recorded_at, dwell_seconds, dwell_threshold_seconds, expected_duration_minutes, entered_at, exited_at, enter_count, checked_in_at, last_event_type, geofences ( id, place_id, name, radius_m, is_active )';

@Injectable()
export class ItineraryTrackingService {
  constructor(private readonly eventEmitter: EventEmitter2) {}

  // ───────────────────────── Helpers ─────────────────────────

  /** Ngày hiện tại theo giờ VN (YYYY-MM-DD). */
  private todayVN(): string {
    return new Date(Date.now() + 7 * 3600 * 1000).toISOString().slice(0, 10);
  }

  private resolveDate(date?: string): string {
    return date && date.trim() ? date.trim() : this.todayVN();
  }

  /** Chuẩn hoá lỗi DB; nhắc chạy migration nếu thiếu bảng/cột tracking. */
  private dbError(error: unknown, context: string): never {
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

  private statusFields(status: VisitStatus) {
    return {
      statusLabelVi: STATUS_LABEL_VI[status],
      mapColor: STATUS_MAP_COLOR[status],
      mapIcon: STATUS_MAP_ICON[status],
    };
  }

  private async loadItinerary(
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

  private async loadDetailsByDay(
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

  private async loadPlacesMap(
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
  private async loadVisitsByDay(
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
  private async ensureGeofenceForPlace(
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
    // Chỉ tạo polygon khi có toạ độ hợp lệ.
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
  private async resolveVisitRow(args: {
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

  private async placeName(placeId: string): Promise<string> {
    const { data } = await supabase
      .schema('travel')
      .from('places')
      .select('name')
      .eq('id', placeId)
      .maybeSingle<{ name: string | null }>();
    return data?.name ?? 'địa điểm';
  }

  /** Tạo thông báo push "Bạn đã đến ..." (không throw nếu lỗi). */
  private async createVisitNotification(
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
          type: 'itinerary', // -> icon "map" ở màn hình thông báo
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

  private nextDayInfo(nextDayDate: string | null) {
    return {
      nextDayDate,
      nextDayAlarmAt: nextDayDate
        ? vnTimestamp(nextDayDate, NEXT_DAY_ALARM_HOUR)
        : null,
    };
  }

  private async findNextDay(
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

  private buildSummary(rows: VisitRow[]) {
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

  // ───────────────────────── Use case steps ─────────────────────────

  /** Bước 1-4: "Bắt đầu" — tạo geofence + visit cho các địa điểm của ngày. */
  async start(dto: StartTrackingDto) {
    const date = this.resolveDate(dto.date);
    const itinerary = await this.loadItinerary(dto.itineraryId, dto.touristId);

    // Đánh dấu lịch trình đang diễn ra + bật cờ tracking_active.
    if ((itinerary.status ?? '').toLowerCase() !== 'completed') {
      const { error } = await supabase
        .schema('travel')
        .from('itineraries')
        .update({ status: 'ongoing', tracking_active: true })
        .eq('id', dto.itineraryId);
      if (error) this.dbError(error, 'start.updateStatus');
    }

    const details = await this.loadDetailsByDay(dto.itineraryId, date);

    const { nextDayDate, nextDayAlarmAt } = this.nextDayInfo(
      await this.findNextDay(dto.itineraryId, date),
    );
    const dayEndAt = vnTimestamp(date, DAY_END_HOUR);

    if (details.length === 0) {
      return {
        itineraryId: dto.itineraryId,
        date,
        totalGeofences: 0,
        skippedNoCoordinates: 0,
        dayEndAt,
        nextDayDate,
        nextDayAlarmAt,
        geofences: [],
        message: `Ngày ${date} không có hoạt động nào trong lịch trình.`,
      };
    }

    const placesMap = await this.loadPlacesMap(details.map((d) => d.place_id));
    const existing = await this.loadVisitsByDay(dto.itineraryId, date);
    const existingByDetail = new Map(
      existing.map((r) => [r.itinerary_detail_id, r]),
    );

    const radius = clampGeofenceRadius(dto.radiusM);
    const nowIso = new Date().toISOString();
    const toUpsert: Record<string, unknown>[] = [];

    interface BuiltGeofence {
      detail: DetailRow;
      place: PlaceRow | undefined;
      geofenceId: string;
      threshold: number;
      expected: number | null;
      status: VisitStatus;
    }
    const built: BuiltGeofence[] = [];

    for (const detail of details) {
      const place = placesMap.get(detail.place_id);
      const expected = detail.duration_minutes ?? place?.visit_duration ?? null;
      const threshold = computeDwellThresholdSeconds(expected);

      // Bỏ qua địa điểm không có toạ độ (không thể tạo geofence/đăng ký).
      if (
        !place ||
        place.latitude == null ||
        place.longitude == null ||
        Number.isNaN(Number(place.latitude)) ||
        Number.isNaN(Number(place.longitude))
      ) {
        continue;
      }

      const geofence = await this.ensureGeofenceForPlace(place, radius);
      const existingRow = existingByDetail.get(detail.id);

      built.push({
        detail,
        place,
        geofenceId: geofence.id,
        threshold: existingRow?.dwell_threshold_seconds ?? threshold,
        expected: existingRow?.expected_duration_minutes ?? expected,
        status: existingRow?.status ?? DEFAULT_VISIT_STATUS,
      });

      // Chỉ tạo mới nếu chưa có (giữ nguyên tiến độ khi gọi lại — idempotent).
      if (!existingRow) {
        toUpsert.push({
          geofence_id: geofence.id,
          itinerary_detail_id: detail.id,
          itinerary_id: dto.itineraryId,
          tourist_id: dto.touristId,
          track_date: date,
          status: DEFAULT_VISIT_STATUS,
          recorded_at: nowIso,
          dwell_seconds: 0,
          dwell_threshold_seconds: threshold,
          expected_duration_minutes: expected,
          enter_count: 0,
          created_at: nowIso,
          updated_at: nowIso,
        });
      }
    }

    if (toUpsert.length > 0) {
      const { error } = await supabase
        .schema('tracking')
        .from('geofence_visits')
        .upsert(toUpsert, {
          onConflict: 'geofence_id,itinerary_detail_id',
          ignoreDuplicates: true,
        });
      if (error) this.dbError(error, 'start.insertVisits');
    }

    const skippedNoCoordinates = details.length - built.length;
    const geofences = built.map((b) => ({
      itineraryDetailId: b.detail.id,
      geofenceId: b.geofenceId,
      placeId: b.detail.place_id,
      name: b.place?.name ?? 'Địa điểm',
      latitude: Number(b.place!.latitude),
      longitude: Number(b.place!.longitude),
      radiusM: radius,
      dwellThresholdSeconds: b.threshold,
      expectedDurationMinutes: b.expected ?? 0,
      status: b.status,
      statusLabelVi: STATUS_LABEL_VI[b.status],
    }));

    return {
      itineraryId: dto.itineraryId,
      date,
      totalGeofences: geofences.length,
      skippedNoCoordinates,
      dayEndAt,
      nextDayDate,
      nextDayAlarmAt,
      geofences,
      message: `Đã đăng ký ${geofences.length} geofence cho ngày ${date}.`,
    };
  }

  /** Lấy danh sách geofence của 1 ngày (cho AlarmManager đăng ký lại). */
  async getGeofences(query: GeofencesQueryDto) {
    const date = this.resolveDate(query.date);
    await this.loadItinerary(query.itineraryId);

    const visits = await this.loadVisitsByDay(query.itineraryId, date);
    const radius = clampGeofenceRadius(query.radiusM);

    const { nextDayDate, nextDayAlarmAt } = this.nextDayInfo(
      await this.findNextDay(query.itineraryId, date),
    );

    // Đã /start: dựng từ visit. Chưa: dựng tạm từ lịch trình.
    if (visits.length > 0) {
      const placeIds = visits
        .map((v) => v.geofences?.place_id)
        .filter((id): id is string => !!id);
      const placesMap = await this.loadPlacesMap(placeIds);

      let skippedNoCoordinates = 0;
      const geofences = visits
        .map((v) => {
          const placeId = v.geofences?.place_id ?? null;
          const place = placeId ? placesMap.get(placeId) : undefined;
          if (place?.latitude == null || place?.longitude == null) {
            skippedNoCoordinates += 1;
            return null;
          }
          return {
            itineraryDetailId: v.itinerary_detail_id,
            geofenceId: v.geofence_id,
            placeId,
            name: v.geofences?.name ?? place?.name ?? 'Địa điểm',
            latitude: Number(place.latitude),
            longitude: Number(place.longitude),
            radiusM: v.geofences?.radius_m ?? radius,
            dwellThresholdSeconds: v.dwell_threshold_seconds,
            expectedDurationMinutes: v.expected_duration_minutes ?? 0,
            status: v.status,
            statusLabelVi: STATUS_LABEL_VI[v.status],
          };
        })
        .filter((g): g is NonNullable<typeof g> => g !== null);

      return {
        itineraryId: query.itineraryId,
        date,
        totalGeofences: geofences.length,
        skippedNoCoordinates,
        dayEndAt: vnTimestamp(date, DAY_END_HOUR),
        nextDayDate,
        nextDayAlarmAt,
        started: true,
        geofences,
        message: `Có ${geofences.length} geofence đang theo dõi cho ngày ${date}.`,
      };
    }

    const details = await this.loadDetailsByDay(query.itineraryId, date);
    const placesMap = await this.loadPlacesMap(details.map((d) => d.place_id));

    let skippedNoCoordinates = 0;
    const geofences = details
      .map((detail) => {
        const place = placesMap.get(detail.place_id);
        if (place?.latitude == null || place?.longitude == null) {
          skippedNoCoordinates += 1;
          return null;
        }
        const expected =
          detail.duration_minutes ?? place?.visit_duration ?? null;
        return {
          itineraryDetailId: detail.id,
          geofenceId: '', // chưa /start nên chưa có geofence
          placeId: detail.place_id,
          name: place?.name ?? 'Địa điểm',
          latitude: Number(place.latitude),
          longitude: Number(place.longitude),
          radiusM: radius,
          dwellThresholdSeconds: computeDwellThresholdSeconds(expected),
          expectedDurationMinutes: expected ?? 0,
          status: DEFAULT_VISIT_STATUS,
          statusLabelVi: STATUS_LABEL_VI[DEFAULT_VISIT_STATUS],
        };
      })
      .filter((g): g is NonNullable<typeof g> => g !== null);

    return {
      itineraryId: query.itineraryId,
      date,
      totalGeofences: geofences.length,
      skippedNoCoordinates,
      dayEndAt: vnTimestamp(date, DAY_END_HOUR),
      nextDayDate,
      nextDayAlarmAt,
      started: false,
      geofences,
      message:
        'Ngày này chưa được /start — danh sách dựng từ lịch trình (geofenceId rỗng).',
    };
  }

  /** Bước 5-6: nhận sự kiện geofence ENTER / DWELL / EXIT. */
  async handleEvent(dto: GeofenceEventDto) {
    const row = await this.resolveVisitRow(dto);
    if (row.tourist_id && row.tourist_id !== dto.touristId) {
      throw new BadRequestException('touristId không khớp với bản ghi theo dõi');
    }

    const occurredAt = dto.occurredAt ?? new Date().toISOString();
    const name = await this.placeName(row.geofences?.place_id ?? '');
    const nowIso = new Date().toISOString();

    // Đã "Đã ghé" rồi -> idempotent, không xử lý lại.
    if (row.status === 'visited') {
      return this.eventResponse(
        row,
        name,
        false,
        false,
        null,
        'Địa điểm đã được đánh dấu Đã ghé từ trước.',
      );
    }

    const updates: Record<string, unknown> = {
      last_event_type: dto.eventType,
      updated_at: nowIso,
    };

    if (dto.eventType === 'ENTER') {
      // Bước 5: ghi nhận thời gian vào + bắt đầu tính dwell.
      updates.entered_at = row.entered_at ?? occurredAt;
      updates.enter_count = row.enter_count + 1;
      const updated = await this.applyUpdate(row, updates);
      return this.eventResponse(
        updated,
        name,
        false,
        false,
        null,
        'Đã ghi nhận vào vùng geofence, bắt đầu tính dwell time.',
      );
    }

    // DWELL hoặc EXIT: tính dwell time và kiểm tra ngưỡng.
    const enteredAt = row.entered_at ?? occurredAt;
    if (!row.entered_at) updates.entered_at = enteredAt;

    let effectiveDwell: number;
    if (dto.dwellSeconds != null) {
      effectiveDwell = dto.dwellSeconds;
    } else {
      const diffMs =
        new Date(occurredAt).getTime() - new Date(enteredAt).getTime();
      effectiveDwell = Math.max(0, Math.floor(diffMs / 1000));
    }
    const newDwell = Math.max(row.dwell_seconds, effectiveDwell);
    updates.dwell_seconds = newDwell;
    if (dto.eventType === 'EXIT') updates.exited_at = occurredAt;

    const meetsThreshold = newDwell >= row.dwell_threshold_seconds;

    if (meetsThreshold) {
      // Bước 6: dwell đủ -> "Đã ghé".
      updates.status = 'visited';
      updates.checked_in_at = occurredAt;
      updates.recorded_at = occurredAt;
      const updated = await this.applyUpdate(row, updates);
      const notificationMessage = await this.createVisitNotification(
        dto.touristId,
        name,
      );
      this.emitVisited(dto.touristId, row.geofences?.place_id ?? null);
      return this.eventResponse(
        updated,
        name,
        true,
        notificationMessage != null,
        notificationMessage,
        `Dwell time đủ ngưỡng (${newDwell}s ≥ ${row.dwell_threshold_seconds}s) → đánh dấu "Đã ghé".`,
      );
    }

    // Bước phụ 6.1: dwell chưa đủ -> ghi log, giữ "Chưa ghé".
    const updated = await this.applyUpdate(row, updates);
    return this.eventResponse(
      updated,
      name,
      false,
      false,
      null,
      `Dwell time chưa đủ (${newDwell}s < ${row.dwell_threshold_seconds}s) → giữ trạng thái "Chưa ghé".`,
    );
  }

  /** Đánh dấu "Đã ghé" thủ công (nút "Tôi đã đến đây"). */
  async checkIn(dto: CheckInDto) {
    const row = await this.resolveVisitRow(dto);
    if (row.tourist_id && row.tourist_id !== dto.touristId) {
      throw new BadRequestException('touristId không khớp với bản ghi theo dõi');
    }
    const name = await this.placeName(row.geofences?.place_id ?? '');

    if (row.status === 'visited') {
      return this.eventResponse(
        row,
        name,
        false,
        false,
        null,
        'Địa điểm đã ở trạng thái Đã ghé.',
      );
    }

    const nowIso = new Date().toISOString();
    const updated = await this.applyUpdate(row, {
      status: 'visited',
      checked_in_at: nowIso,
      recorded_at: nowIso,
      entered_at: row.entered_at ?? nowIso,
      dwell_seconds: Math.max(row.dwell_seconds, row.dwell_threshold_seconds),
      last_event_type: 'MANUAL_CHECKIN',
      updated_at: nowIso,
    });

    const notificationMessage = await this.createVisitNotification(
      dto.touristId,
      name,
    );
    this.emitVisited(dto.touristId, row.geofences?.place_id ?? null);

    return this.eventResponse(
      updated,
      name,
      true,
      notificationMessage != null,
      notificationMessage,
      'Đã check-in thủ công → "Đã ghé".',
    );
  }

  /** Bước map: trạng thái từng địa điểm + marker cho bản đồ. */
  async getStatus(query: TrackingStatusQueryDto) {
    const date = this.resolveDate(query.date);
    await this.loadItinerary(query.itineraryId);
    const rows = await this.loadVisitsByDay(query.itineraryId, date);

    const placeIds = rows
      .map((r) => r.geofences?.place_id)
      .filter((id): id is string => !!id);
    const placesMap = await this.loadPlacesMap(placeIds);

    const places = rows.map((row) => {
      const placeId = row.geofences?.place_id ?? null;
      const place = placeId ? placesMap.get(placeId) : undefined;
      const sf = this.statusFields(row.status);
      return {
        itineraryDetailId: row.itinerary_detail_id,
        geofenceId: row.geofence_id,
        placeId,
        name: row.geofences?.name ?? place?.name ?? 'Địa điểm',
        address: place?.address ?? null,
        latitude: place?.latitude != null ? Number(place.latitude) : null,
        longitude: place?.longitude != null ? Number(place.longitude) : null,
        status: row.status,
        statusLabelVi: sf.statusLabelVi,
        mapColor: sf.mapColor,
        mapIcon: sf.mapIcon,
        enteredAt: row.entered_at,
        checkedInAt: row.checked_in_at,
        dwellSeconds: row.dwell_seconds,
        dwellThresholdSeconds: row.dwell_threshold_seconds,
      };
    });

    return {
      itineraryId: query.itineraryId,
      date,
      summary: this.buildSummary(rows),
      places,
    };
  }

  /** Bước 8: kết thúc ngày — gỡ geofence, đánh dấu Bỏ qua, đặt lịch ngày kế. */
  async endDay(dto: EndDayDto) {
    const date = this.resolveDate(dto.date);
    const itinerary = await this.loadItinerary(dto.itineraryId);
    const markSkipped = dto.markPendingAsSkipped !== false; // mặc định true
    const nowIso = new Date().toISOString();

    if (markSkipped) {
      const { error } = await supabase
        .schema('tracking')
        .from('geofence_visits')
        .update({ status: 'skipped', recorded_at: nowIso, updated_at: nowIso })
        .eq('itinerary_id', dto.itineraryId)
        .eq('track_date', date)
        .eq('status', 'not_visited');
      if (error) this.dbError(error, 'endDay.markSkipped');
    }

    const rows = await this.loadVisitsByDay(dto.itineraryId, date);
    const nextDayDate = await this.findNextDay(dto.itineraryId, date);

    let itineraryStatus = (itinerary.status ?? 'ongoing').toLowerCase();
    const isExplicitStop = dto.markPendingAsSkipped === false;

    if (!nextDayDate) {
      // Hết ngày cuối -> hoàn thành lịch trình, tắt tracking.
      const { error } = await supabase
        .schema('travel')
        .from('itineraries')
        .update({ status: 'completed', tracking_active: false })
        .eq('id', dto.itineraryId);
      if (error) this.dbError(error, 'endDay.complete');
      itineraryStatus = 'completed';
    } else if (isExplicitStop) {
      // User bấm Dừng → tắt tracking_active, giữ status = ongoing.
      const { error } = await supabase
        .schema('travel')
        .from('itineraries')
        .update({ tracking_active: false })
        .eq('id', dto.itineraryId);
      if (error) this.dbError(error, 'endDay.stopTracking');
      itineraryStatus = 'ongoing';
    } else {
      // Hết ngày (AlarmManager), sang ngày tiếp theo → tracking vẫn active.
      itineraryStatus = 'ongoing';
    }

    const { nextDayAlarmAt } = this.nextDayInfo(nextDayDate);

    return {
      itineraryId: dto.itineraryId,
      date,
      removedGeofenceIds: rows.map((r) => r.geofence_id),
      removedItineraryDetailIds: rows.map((r) => r.itinerary_detail_id),
      removedPlaceIds: rows
        .map((r) => r.geofences?.place_id)
        .filter((id): id is string => !!id),
      summary: this.buildSummary(rows),
      nextDayDate,
      nextDayAlarmAt,
      itineraryStatus,
      message: nextDayDate
        ? `Đã kết thúc ngày ${date}. Đặt lịch đăng ký lại geofence cho ngày ${nextDayDate}.`
        : `Đã kết thúc ngày cuối ${date}. Lịch trình hoàn thành.`,
    };
  }

  // ───────────────────────── Internal ─────────────────────────

  private async applyUpdate(
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

  private emitVisited(touristId: string, placeId: string | null): void {
    if (!placeId) return;
    this.eventEmitter.emit(ACTIVITY_LOG_EVENT, {
      tourist_id: touristId,
      action_type: 'visited',
      place_id: placeId,
    });
  }

  private eventResponse(
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
