import { VisitStatus } from './itinerary-tracking.constants';

export interface ItineraryRow {
  id: string;
  creator_id: string;
  status: string | null;
  start_date: string | null;
  end_date: string | null;
}

export interface DetailRow {
  id: string;
  itinerary_id: string;
  place_id: string;
  visit_date: string | null;
  duration_minutes: number | null;
  arrival_time: string | null;
  sequence_order: number | null;
}

export interface PlaceRow {
  id: string;
  name: string | null;
  latitude: number | null;
  longitude: number | null;
  address: string | null;
  visit_duration: number | null;
}

/** Bản ghi tracking.geofences (đã thêm place_id + radius_m so với bản gốc). */
export interface GeofenceRow {
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
export interface VisitRow {
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
