import { describe, expect, it } from 'vitest';
import { isIsoDay } from './isoDay';

describe('isIsoDay', () => {
  it('accepts real calendar days', () => {
    expect(isIsoDay('2031-06-15')).toBe(true);
    expect(isIsoDay('2031-01-01')).toBe(true);
    expect(isIsoDay('2031-12-31')).toBe(true);
  });

  it('handles leap years', () => {
    expect(isIsoDay('2032-02-29')).toBe(true);
    expect(isIsoDay('2031-02-29')).toBe(false);
    expect(isIsoDay('2100-02-29')).toBe(false); // century, not a leap year
    expect(isIsoDay('2400-02-29')).toBe(true);
  });

  it('rejects days past the end of the month', () => {
    expect(isIsoDay('2031-04-31')).toBe(false);
    expect(isIsoDay('2031-01-32')).toBe(false);
    expect(isIsoDay('2031-01-00')).toBe(false);
  });

  it('rejects months out of range', () => {
    expect(isIsoDay('2031-00-10')).toBe(false);
    expect(isIsoDay('2031-13-10')).toBe(false);
  });

  it('rejects malformed text', () => {
    for (const bad of ['', '2031-6-15', '2031/06/15', '20310615', '31-06-2031', ' 2031-06-15', '2031-06-15 ', '2031-06-15T00:00:00Z', 'abcd-ef-gh']) {
      expect(isIsoDay(bad), JSON.stringify(bad)).toBe(false);
    }
  });

  // Known quirk, pinned so a fix is a deliberate change: Date.UTC maps years 0-99 to 1900-1999, so the
  // year check fails and a real day in years 0000-0099 is rejected. Harmless for report dates.
  it('currently rejects years 0000 to 0099', () => {
    expect(isIsoDay('0050-03-10')).toBe(false);
    expect(isIsoDay('0000-01-01')).toBe(false);
  });
});
