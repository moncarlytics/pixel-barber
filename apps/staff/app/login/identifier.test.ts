// apps/staff/app/login/identifier.test.ts
import { describe, expect, it } from 'vitest';
import { parseLoginIdentifier } from './identifier';

describe('parseLoginIdentifier', () => {
  it('treats anything with @ as an email, lower-cased', () => {
    expect(parseLoginIdentifier('  Kofi@Example.com ')).toEqual({ email: 'kofi@example.com' });
  });

  it('normalizes Ghana phone numbers', () => {
    expect(parseLoginIdentifier('024 412 3456')).toEqual({ phone: '+233244123456' });
    expect(parseLoginIdentifier('+233244123456')).toEqual({ phone: '+233244123456' });
  });

  it('rejects empty input and invalid phone numbers', () => {
    expect(parseLoginIdentifier('   ')).toBeNull();
    expect(parseLoginIdentifier('12345')).toBeNull();
  });
});
