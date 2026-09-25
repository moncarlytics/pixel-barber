// supabase/functions/_shared/staff-invite-core.ts
// Pure logic shared by the staff-invite, staff-manage and staff-invite-accept Edge Functions.
// No Deno APIs and no imports, so Vitest can import it directly
// (tests/unit/staff-invite-core.test.ts). Deno-only glue (env, clients) lives in the functions and
// in _shared/staff-auth.ts / _shared/staff-invite-env.ts.

export const STAFF_ROLES = [
  'owner',
  'branch_manager',
  'receptionist',
  'barber',
  'analyst',
] as const;
export type StaffRole = (typeof STAFF_ROLES)[number];

/** Roles tied to one branch: barbers (home branch) and branch_manager/receptionist (assignment). */
export const BRANCH_ROLES: readonly StaffRole[] = ['barber', 'branch_manager', 'receptionist'];

export const ROLE_LABELS: Record<StaffRole, string> = {
  owner: 'Owner',
  branch_manager: 'Branch Manager',
  receptionist: 'Receptionist',
  barber: 'Barber',
  analyst: 'Analyst',
};

export const INVITE_VALID_DAYS = 7;
export const MIN_PASSWORD_LENGTH = 8;
export const CONTACT_IN_USE_MESSAGE = 'That phone number or email is already used by an account';

export function inviteExpiry(now: Date = new Date()): Date {
  return new Date(now.getTime() + INVITE_VALID_DAYS * 24 * 60 * 60 * 1000);
}

/** 32 random bytes as unpadded base64url (43 characters, 256 bits). */
export function generateInviteToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** Hex SHA-256 of the token's UTF-8 bytes — the only form ever stored. */
export async function hashInviteToken(token: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token));
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

export function inviteLink(baseUrl: string, token: string): string {
  return `${baseUrl.replace(/\/+$/, '')}/invite/${token}`;
}

// Copy of packages/shared/src/phone.ts normalizeGhanaPhone -- Edge Function bundles can't import
// from packages/. Keep the two in sync.
export function normalizeGhanaPhone(input: string): string | null {
  const digitsOnly = input.replace(/[\s-]/g, '');
  if (/^\+233\d{9}$/.test(digitsOnly)) return digitsOnly;
  if (/^0\d{9}$/.test(digitsOnly)) return `+233${digitsOnly.slice(1)}`;
  return null;
}

export function normalizeEmail(input: string): string | null {
  const email = input.trim().toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : null;
}

export interface InviteRequest {
  name: string;
  role: StaffRole;
  branchId: string | null;
  phone: string | null;
  email: string | null;
}

export function parseInviteRequest(
  body: unknown,
): { ok: true; value: InviteRequest } | { ok: false; error: string } {
  const fail = (error: string) => ({ ok: false as const, error });
  if (typeof body !== 'object' || body === null) return fail('Invalid request body');
  const b = body as Record<string, unknown>;

  const name = typeof b.name === 'string' ? b.name.trim() : '';
  if (!name) return fail('Name is required');

  const role = b.role;
  if (typeof role !== 'string' || !(STAFF_ROLES as readonly string[]).includes(role)) {
    return fail('Role is not valid');
  }

  const hasPhone = typeof b.phone === 'string' && b.phone.trim() !== '';
  const hasEmail = typeof b.email === 'string' && b.email.trim() !== '';
  if (hasPhone === hasEmail) return fail('Provide exactly one of phone or email');

  let phone: string | null = null;
  let email: string | null = null;
  if (hasPhone) {
    phone = normalizeGhanaPhone(b.phone as string);
    if (!phone) return fail('Phone number is not a valid Ghana number');
  } else {
    email = normalizeEmail(b.email as string);
    if (!email) return fail('Email address is not valid');
  }

  const needsBranch = BRANCH_ROLES.includes(role as StaffRole);
  const branchId = typeof b.branch_id === 'string' && b.branch_id !== '' ? b.branch_id : null;
  if (needsBranch && !branchId) return fail('A branch is required for this role');

  return {
    ok: true,
    value: { name, role: role as StaffRole, branchId: needsBranch ? branchId : null, phone, email },
  };
}

export interface InviteMessage {
  sms: string;
  emailSubject: string;
  emailText: string;
  emailHtml: string;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function buildInviteMessage(input: {
  name: string;
  role: StaffRole;
  link: string;
}): InviteMessage {
  const roleLabel = ROLE_LABELS[input.role];
  const firstName = input.name.split(/\s+/)[0];
  const sms =
    `Hi ${firstName}, you've been invited to Pixel Barber as ${roleLabel}. ` +
    `Set your password: ${input.link} (valid ${INVITE_VALID_DAYS} days)`;
  const emailText =
    `Hi ${input.name},\n\nYou've been invited to join Pixel Barber as ${roleLabel}.\n\n` +
    `Set your password here: ${input.link}\n\nThis link is valid for ${INVITE_VALID_DAYS} days.`;
  const emailHtml =
    `<p>Hi ${escapeHtml(input.name)},</p>` +
    `<p>You've been invited to join Pixel Barber as ${escapeHtml(roleLabel)}.</p>` +
    `<p><a href="${escapeHtml(input.link)}">Set your password</a></p>` +
    `<p>This link is valid for ${INVITE_VALID_DAYS} days.</p>`;
  return { sms, emailSubject: "You're invited to Pixel Barber", emailText, emailHtml };
}

export interface InviteDeliveryConfig {
  arkeselApiKey?: string;
  arkeselSenderId?: string;
  resendApiKey?: string;
  emailFrom?: string;
}

export type DeliveryFailureReason =
  'undeliverable_test_address' | 'email_not_configured' | 'sms_not_configured' | 'provider_error';

export type DeliveryResult =
  { delivered: true } | { delivered: false; reason: DeliveryFailureReason };

export type InviteTarget = { phone: string } | { email: string };

// Copy of supabase/functions/send-sms/index.ts isArkeselSuccess (that module calls Deno.serve on
// import, so it can't be imported here). Arkesel's confirmed v2 success shape is
// { status: "success", data: {...} }: a non-2xx is always a failure, and a 2xx body that explicitly
// says status !== "success" is also a failure; anything else 2xx is treated as success.
export function isArkeselSuccess(httpOk: boolean, rawBody: string): boolean {
  if (!httpOk) return false;
  try {
    const parsed = JSON.parse(rawBody) as { status?: string };
    if (parsed.status === undefined) return true;
    return parsed.status === 'success';
  } catch {
    return true;
  }
}

/**
 * Sends the invite by SMS (Arkesel) or email (Resend). Never throws.
 * Email addresses ending in ".local" are reserved and never deliverable -- automated tests use
 * them, so they are skipped rather than sent (and bounced) through Resend.
 */
export async function sendInvite(
  target: InviteTarget,
  message: InviteMessage,
  config: InviteDeliveryConfig,
  fetchImpl: typeof fetch = fetch,
): Promise<DeliveryResult> {
  try {
    if ('email' in target) {
      if (target.email.endsWith('.local')) {
        return { delivered: false, reason: 'undeliverable_test_address' };
      }
      if (!config.resendApiKey || !config.emailFrom) {
        return { delivered: false, reason: 'email_not_configured' };
      }
      const response = await fetchImpl('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${config.resendApiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          from: config.emailFrom,
          to: [target.email],
          subject: message.emailSubject,
          text: message.emailText,
          html: message.emailHtml,
        }),
        signal: AbortSignal.timeout(10_000),
      });
      return response.ok ? { delivered: true } : { delivered: false, reason: 'provider_error' };
    }

    if (!config.arkeselApiKey || !config.arkeselSenderId) {
      return { delivered: false, reason: 'sms_not_configured' };
    }
    const response = await fetchImpl('https://sms.arkesel.com/api/v2/sms/send', {
      method: 'POST',
      headers: { 'api-key': config.arkeselApiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sender: config.arkeselSenderId,
        message: message.sms,
        recipients: [target.phone],
      }),
      signal: AbortSignal.timeout(10_000),
    });
    const rawBody = await response.text();
    return isArkeselSuccess(response.ok, rawBody)
      ? { delivered: true }
      : { delivered: false, reason: 'provider_error' };
  } catch {
    return { delivered: false, reason: 'provider_error' };
  }
}
