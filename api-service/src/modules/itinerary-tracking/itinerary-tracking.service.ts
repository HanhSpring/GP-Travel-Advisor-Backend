import {
  BadRequestException,
  Injectable,
  InternalServerErrorException,
  NotFoundException,
} from '@nestjs/common';
import { ItineraryTrackingQueryService } from './services/itinerary-tracking-query.service';
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

import { ItineraryRow, DetailRow, PlaceRow, GeofenceRow, VisitRow } from './itinerary-tracking.types';

@Injectable()
export class ItineraryTrackingService {
  constructor(private readonly queryService: ItineraryTrackingQueryService) {}

  // ───────────────────────── Use case steps ─────────────────────────

  /** Bước 1-4: "Bắt đầu" — tạo geofence + visit cho các địa điểm của ngày. */
  async start(dto: StartTrackingDto) {
    const date = this.queryService.resolveDate(dto.date);
    const itinerary = await this.queryService.loadItinerary(dto.itineraryId, dto.touristId);

    if ((itinerary.status ?? '').toLowerCase() !== 'completed') {
      const { error } = await supabase
        .schema('travel')
        .from('itineraries')
        .update({ status: 'ongoing', tracking_active: true })
        .eq('id', dto.itineraryId);
      if (error) this.queryService.dbError(error, 'start.updateStatus');
    }

    const details = await this.queryService.loadDetailsByDay(dto.itineraryId, date);

    const { nextDayDate, nextDayAlarmAt } = this.queryService.nextDayInfo(
      await this.queryService.findNextDay(dto.itineraryId, date),
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

    const placesMap = await this.queryService.loadPlacesMap(details.map((d) => d.place_id));
    const existing = await this.queryService.loadVisitsByDay(dto.itineraryId, date);
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

      if (
        !place ||
        place.latitude == null ||
        place.longitude == null ||
        Number.isNaN(Number(place.latitude)) ||
        Number.isNaN(Number(place.longitude))
      ) {
        continue;
      }

      const geofence = await this.queryService.ensureGeofenceForPlace(place, radius);
      const existingRow = existingByDetail.get(detail.id);

      built.push({
        detail,
        place,
        geofenceId: geofence.id,
        threshold: existingRow?.dwell_threshold_seconds ?? threshold,
        expected: existingRow?.expected_duration_minutes ?? expected,
        status: existingRow?.status ?? DEFAULT_VISIT_STATUS,
      });

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
      if (error) this.queryService.dbError(error, 'start.insertVisits');
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
    const date = this.queryService.resolveDate(query.date);
    await this.queryService.loadItinerary(query.itineraryId);

    const visits = await this.queryService.loadVisitsByDay(query.itineraryId, date);
    const radius = clampGeofenceRadius(query.radiusM);

    const { nextDayDate, nextDayAlarmAt } = this.queryService.nextDayInfo(
      await this.queryService.findNextDay(query.itineraryId, date),
    );

    if (visits.length > 0) {
      const placeIds = visits
        .map((v) => v.geofences?.place_id)
        .filter((id): id is string => !!id);
      const placesMap = await this.queryService.loadPlacesMap(placeIds);

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

    const details = await this.queryService.loadDetailsByDay(query.itineraryId, date);
    const placesMap = await this.queryService.loadPlacesMap(details.map((d) => d.place_id));

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
          geofenceId: '',
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
    const row = await this.queryService.resolveVisitRow(dto);
    if (row.tourist_id && row.tourist_id !== dto.touristId) {
      throw new BadRequestException('touristId không khớp với bản ghi theo dõi');
    }

    const occurredAt = dto.occurredAt ?? new Date().toISOString();
    const name = await this.queryService.placeName(row.geofences?.place_id ?? '');
    const nowIso = new Date().toISOString();

    if (row.status === 'visited') {
      return this.queryService.eventResponse(
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
      updates.entered_at = row.entered_at ?? occurredAt;
      updates.enter_count = row.enter_count + 1;
      const updated = await this.queryService.applyUpdate(row, updates);
      return this.queryService.eventResponse(
        updated,
        name,
        false,
        false,
        null,
        'Đã ghi nhận vào vùng geofence, bắt đầu tính dwell time.',
      );
    }

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
      updates.status = 'visited';
      updates.checked_in_at = occurredAt;
      updates.recorded_at = occurredAt;
      const updated = await this.queryService.applyUpdate(row, updates);
      const notificationMessage = await this.queryService.createVisitNotification(
        dto.touristId,
        name,
      );
      this.queryService.emitVisited(dto.touristId, row.geofences?.place_id ?? null);
      return this.queryService.eventResponse(
        updated,
        name,
        true,
        notificationMessage != null,
        notificationMessage,
        `Dwell time đủ ngưỡng (${newDwell}s ≥ ${row.dwell_threshold_seconds}s) → đánh dấu "Đã ghé".`,
      );
    }

    const updated = await this.queryService.applyUpdate(row, updates);
    return this.queryService.eventResponse(
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
    const row = await this.queryService.resolveVisitRow(dto);
    if (row.tourist_id && row.tourist_id !== dto.touristId) {
      throw new BadRequestException('touristId không khớp với bản ghi theo dõi');
    }
    const name = await this.queryService.placeName(row.geofences?.place_id ?? '');

    if (row.status === 'visited') {
      return this.queryService.eventResponse(
        row,
        name,
        false,
        false,
        null,
        'Địa điểm đã ở trạng thái Đã ghé.',
      );
    }

    const nowIso = new Date().toISOString();
    const updated = await this.queryService.applyUpdate(row, {
      status: 'visited',
      checked_in_at: nowIso,
      recorded_at: nowIso,
      entered_at: row.entered_at ?? nowIso,
      dwell_seconds: Math.max(row.dwell_seconds, row.dwell_threshold_seconds),
      last_event_type: 'MANUAL_CHECKIN',
      updated_at: nowIso,
    });

    const notificationMessage = await this.queryService.createVisitNotification(
      dto.touristId,
      name,
    );
    this.queryService.emitVisited(dto.touristId, row.geofences?.place_id ?? null);

    return this.queryService.eventResponse(
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
    const date = this.queryService.resolveDate(query.date);
    await this.queryService.loadItinerary(query.itineraryId);
    const rows = await this.queryService.loadVisitsByDay(query.itineraryId, date);

    const placeIds = rows
      .map((r) => r.geofences?.place_id)
      .filter((id): id is string => !!id);
    const placesMap = await this.queryService.loadPlacesMap(placeIds);

    const places = rows.map((row) => {
      const placeId = row.geofences?.place_id ?? null;
      const place = placeId ? placesMap.get(placeId) : undefined;
      const sf = this.queryService.statusFields(row.status);
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
      summary: this.queryService.buildSummary(rows),
      places,
    };
  }

  /** Bước 8: kết thúc ngày — gỡ geofence, đánh dấu Bỏ qua, đặt lịch ngày kế. */
  async endDay(dto: EndDayDto) {
    const date = this.queryService.resolveDate(dto.date);
    const itinerary = await this.queryService.loadItinerary(dto.itineraryId);
    const markSkipped = dto.markPendingAsSkipped !== false;
    const nowIso = new Date().toISOString();

    if (markSkipped) {
      const { error } = await supabase
        .schema('tracking')
        .from('geofence_visits')
        .update({ status: 'skipped', recorded_at: nowIso, updated_at: nowIso })
        .eq('itinerary_id', dto.itineraryId)
        .eq('track_date', date)
        .eq('status', 'not_visited');
      if (error) this.queryService.dbError(error, 'endDay.markSkipped');
    }

    const rows = await this.queryService.loadVisitsByDay(dto.itineraryId, date);
    const nextDayDate = await this.queryService.findNextDay(dto.itineraryId, date);

    let itineraryStatus = (itinerary.status ?? 'ongoing').toLowerCase();
    const isExplicitStop = dto.markPendingAsSkipped === false;

    if (!nextDayDate) {
      const { error } = await supabase
        .schema('travel')
        .from('itineraries')
        .update({ status: 'completed', tracking_active: false })
        .eq('id', dto.itineraryId);
      if (error) this.queryService.dbError(error, 'endDay.complete');
      itineraryStatus = 'completed';
    } else if (isExplicitStop) {
      const { error } = await supabase
        .schema('travel')
        .from('itineraries')
        .update({ tracking_active: false })
        .eq('id', dto.itineraryId);
      if (error) this.queryService.dbError(error, 'endDay.stopTracking');
      itineraryStatus = 'ongoing';
    } else {
      itineraryStatus = 'ongoing';
    }

    const { nextDayAlarmAt } = this.queryService.nextDayInfo(nextDayDate);

    return {
      itineraryId: dto.itineraryId,
      date,
      removedGeofenceIds: rows.map((r) => r.geofence_id),
      removedItineraryDetailIds: rows.map((r) => r.itinerary_detail_id),
      removedPlaceIds: rows
        .map((r) => r.geofences?.place_id)
        .filter((id): id is string => !!id),
      summary: this.queryService.buildSummary(rows),
      nextDayDate,
      nextDayAlarmAt,
      itineraryStatus,
      message: nextDayDate
        ? `Đã kết thúc ngày ${date}. Đặt lịch đăng ký lại geofence cho ngày ${nextDayDate}.`
        : `Đã kết thúc ngày cuối ${date}. Lịch trình hoàn thành.`,
    };
  }

}
