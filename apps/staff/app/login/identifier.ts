// apps/staff/app/login/identifier.ts
// Staff sign in with an email or a Ghana phone number (SMS-invited staff have phone-only logins).
import { normalizeGhanaPhone } from '@pixel-barber/shared';

export type LoginIdentifier = { email: string } | { phone: string };

export function parseLoginIdentifier(input: string): LoginIdentifier | null {
  const trimmed = input.trim();
  if (!trimmed) return null;
  if (trimmed.includes('@')) return { email: trimmed.toLowerCase() };
  const phone = normalizeGhanaPhone(trimmed);
  return phone ? { phone } : null;
}
