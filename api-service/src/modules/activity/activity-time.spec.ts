import { toVietnamTimestamp } from './activity-time';

describe('toVietnamTimestamp', () => {
  it('converts UTC to Vietnam wall-clock time without a timezone suffix', () => {
    expect(toVietnamTimestamp(new Date('2026-06-20T04:15:32.436Z'))).toBe(
      '2026-06-20T11:15:32.436',
    );
  });

  it('rolls over to the next day when needed', () => {
    expect(toVietnamTimestamp(new Date('2026-06-20T20:00:00.000Z'))).toBe(
      '2026-06-21T03:00:00.000',
    );
  });
});
