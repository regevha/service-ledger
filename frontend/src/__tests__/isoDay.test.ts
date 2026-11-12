import { describe, expect, it } from 'vitest';
import { isIsoDay } from '../isoDay';

describe('isIsoDay', () => {
  it('accepts real calendar days, including a leap day', () => {
    expect(isIsoDay('2026-11-12')).toBe(true);
    expect(isIsoDay('2028-02-29')).toBe(true);
  });

  it('rejects days that do not exist and other formats', () => {
    expect(isIsoDay('2026-02-29')).toBe(false);
    expect(isIsoDay('2026-13-01')).toBe(false);
    expect(isIsoDay('2026-04-31')).toBe(false);
    expect(isIsoDay('12/11/2026')).toBe(false);
    expect(isIsoDay('2026-1-2')).toBe(false);
    expect(isIsoDay('')).toBe(false);
  });
});
