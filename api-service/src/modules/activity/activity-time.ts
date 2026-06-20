const VIETNAM_UTC_OFFSET_MS = 7 * 60 * 60 * 1000;

/**
 * Formats an instant as Vietnam wall-clock time for a PostgreSQL
 * `timestamp without time zone` column.
 */
export function toVietnamTimestamp(date: Date = new Date()): string {
  return new Date(date.getTime() + VIETNAM_UTC_OFFSET_MS)
    .toISOString()
    .replace(/Z$/, '');
}
