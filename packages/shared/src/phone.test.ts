import { describe, expect, it } from 'vitest';
import { normalizeGhanaPhone } from './phone';

describe('normalizeGhanaPhone', () => {
  it('normalizes a plain 10-digit local number', () => {
    expect(normalizeGhanaPhone('0244123456')).toBe('+233244123456');
  });

  it('normalizes a number already carrying +233', () => {
    expect(normalizeGhanaPhone('+233244123456')).toBe('+233244123456');
  });

  it('strips spaces and dashes before normalizing', () => {
    expect(normalizeGhanaPhone('024 412-3456')).toBe('+233244123456');
  });

  it('returns null for a too-short number', () => {
    expect(normalizeGhanaPhone('024412')).toBeNull();
  });

  it('returns null for a non-Ghana country code', () => {
    expect(normalizeGhanaPhone('+15551234567')).toBeNull();
  });
});
