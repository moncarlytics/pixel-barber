import { describe, expect, it } from 'vitest';
import {
  EMPTY,
  formatCount,
  formatDay,
  formatHour,
  formatMinutes,
  formatMoney,
  formatPercent,
  formatRating,
  formatTime,
} from './format';

describe('report formatting', () => {
  it('formats minutes, money, percentages and ratings, with a dash for missing values', () => {
    expect(formatMinutes(18)).toBe('18 min');
    expect(formatMinutes(null)).toBe(EMPTY);
    expect(formatMoney(1250)).toBe('GHS 1,250.00');
    expect(formatMoney(0)).toBe('GHS 0.00');
    expect(formatMoney(undefined)).toBe(EMPTY);
    expect(formatPercent(37.5)).toBe('37.5%');
    expect(formatPercent(20)).toBe('20.0%');
    expect(formatPercent(null)).toBe(EMPTY);
    expect(formatRating(3.5)).toBe('3.50');
    expect(formatRating(null)).toBe(EMPTY);
    expect(formatCount(0)).toBe('0');
    expect(formatCount(null)).toBe(EMPTY);
  });

  it('formats hours, days and times in Ghana time', () => {
    expect(formatHour(9)).toBe('09:00');
    expect(formatHour(15)).toBe('15:00');
    expect(formatDay('2026-09-28')).toBe('Mon 28 Sep');
    expect(formatTime('2026-10-08T10:42:00Z')).toBe('10:42');
  });
});
