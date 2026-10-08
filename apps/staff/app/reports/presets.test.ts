import { describe, expect, it } from 'vitest';
import { presetRange } from './presets';

describe('presetRange', () => {
  it('counts today in the last 7 and 30 days', () => {
    expect(presetRange('last7', '2026-10-08')).toEqual({ from: '2026-10-02', to: '2026-10-08' });
    expect(presetRange('last30', '2026-10-08')).toEqual({ from: '2026-09-09', to: '2026-10-08' });
  });

  it('covers this month so far and the whole of last month', () => {
    expect(presetRange('thisMonth', '2026-10-08')).toEqual({
      from: '2026-10-01',
      to: '2026-10-08',
    });
    expect(presetRange('lastMonth', '2026-10-08')).toEqual({
      from: '2026-09-01',
      to: '2026-09-30',
    });
    expect(presetRange('lastMonth', '2026-01-15')).toEqual({
      from: '2025-12-01',
      to: '2025-12-31',
    });
  });
});
