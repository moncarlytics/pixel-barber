import { describe, expect, it } from 'vitest';
import { safeNextPath } from './nextPath';

describe('safeNextPath', () => {
  it('keeps a same-site path, including its query string', () => {
    expect(safeNextPath('/branches/abc')).toBe('/branches/abc');
    expect(safeNextPath('/book?branch=abc')).toBe('/book?branch=abc');
  });

  it('falls back to Home when there is no path', () => {
    expect(safeNextPath(null)).toBe('/');
    expect(safeNextPath('')).toBe('/');
  });

  it('refuses anything that could leave the site', () => {
    expect(safeNextPath('https://evil.example')).toBe('/');
    expect(safeNextPath('//evil.example')).toBe('/');
    expect(safeNextPath('/\\evil.example')).toBe('/');
    expect(safeNextPath('javascript:alert(1)')).toBe('/');
  });

  it('never sends a customer back to the login page itself', () => {
    expect(safeNextPath('/login')).toBe('/');
    expect(safeNextPath('/login?next=/profile')).toBe('/');
  });
});
