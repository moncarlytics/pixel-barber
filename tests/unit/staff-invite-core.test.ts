// tests/unit/staff-invite-core.test.ts
// @vitest-environment node
// Pure logic behind the staff invite Edge Functions: token format, hashing (must match the SQL
// test helper's encode(sha256(convert_to(token,'UTF8')),'hex')), request validation, message
// building, and SMS/email delivery with a stubbed fetch.
import { describe, expect, it, vi } from 'vitest';
import {
  buildInviteMessage,
  generateInviteToken,
  hashInviteToken,
  inviteExpiry,
  inviteLink,
  normalizeGhanaPhone,
  parseInviteRequest,
  sendInvite,
  type InviteMessage,
} from '../../supabase/functions/_shared/staff-invite-core';

const MESSAGE: InviteMessage = {
  sms: 'sms text',
  emailSubject: 'subject',
  emailText: 'text',
  emailHtml: '<p>html</p>',
};

function stubFetch(status: number, body: string) {
  return vi.fn(async () => new Response(body, { status }));
}

describe('tokens', () => {
  it('generates 43-character base64url tokens that differ each time', () => {
    const a = generateInviteToken();
    const b = generateInviteToken();
    expect(a).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(a).not.toBe(b);
  });

  it('hashes as hex SHA-256 of the UTF-8 bytes', async () => {
    expect(await hashInviteToken('abc')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
  });

  it('builds the link without a doubled slash', () => {
    expect(inviteLink('https://staff.example.com/', 'tok')).toBe(
      'https://staff.example.com/invite/tok',
    );
    expect(inviteLink('http://localhost:3001', 'tok')).toBe('http://localhost:3001/invite/tok');
  });

  it('expires 7 days after now', () => {
    const now = new Date('2026-09-25T10:00:00Z');
    expect(inviteExpiry(now).toISOString()).toBe('2026-10-02T10:00:00.000Z');
  });
});

describe('normalizeGhanaPhone', () => {
  it('normalizes local and international formats and rejects others', () => {
    expect(normalizeGhanaPhone('024 412 3456')).toBe('+233244123456');
    expect(normalizeGhanaPhone('+233244123456')).toBe('+233244123456');
    expect(normalizeGhanaPhone('12345')).toBeNull();
  });
});

describe('parseInviteRequest', () => {
  const base = { name: 'Kofi', role: 'barber', branch_id: 'branch-1', email: 'Kofi@Example.com' };

  it('accepts a valid barber invite and normalizes the email', () => {
    const r = parseInviteRequest(base);
    expect(r).toEqual({
      ok: true,
      value: {
        name: 'Kofi',
        role: 'barber',
        branchId: 'branch-1',
        phone: null,
        email: 'kofi@example.com',
      },
    });
  });

  it('normalizes a phone number', () => {
    const r = parseInviteRequest({
      name: 'Ama',
      role: 'receptionist',
      branch_id: 'b',
      phone: '0244123456',
    });
    expect(r.ok && r.value.phone).toBe('+233244123456');
  });

  it('drops the branch for business-wide roles', () => {
    const r = parseInviteRequest({
      name: 'Esi',
      role: 'analyst',
      branch_id: 'b',
      email: 'e@x.com',
    });
    expect(r.ok && r.value.branchId).toBeNull();
  });

  it.each([
    [{ ...base, name: '  ' }, 'Name is required'],
    [{ ...base, role: 'janitor' }, 'Role is not valid'],
    [{ ...base, phone: '0244123456' }, 'Provide exactly one of phone or email'],
    [{ name: 'Kofi', role: 'barber', branch_id: 'b' }, 'Provide exactly one of phone or email'],
    [{ ...base, email: 'not-an-email' }, 'Email address is not valid'],
    [
      { name: 'Kofi', role: 'barber', branch_id: 'b', phone: '123' },
      'Phone number is not a valid Ghana number',
    ],
    [{ name: 'Kofi', role: 'barber', email: 'k@x.com' }, 'A branch is required for this role'],
  ])('rejects %j', (body, error) => {
    expect(parseInviteRequest(body)).toEqual({ ok: false, error });
  });
});

describe('buildInviteMessage', () => {
  it('includes the link and role label, and escapes the name in HTML', () => {
    const m = buildInviteMessage({
      name: 'Kofi <b>',
      role: 'branch_manager',
      link: 'https://x/invite/t',
    });
    expect(m.sms).toContain('https://x/invite/t');
    expect(m.sms).toContain('Branch Manager');
    expect(m.emailText).toContain('https://x/invite/t');
    expect(m.emailHtml).toContain('Kofi &lt;b&gt;');
    expect(m.emailHtml).not.toContain('Kofi <b>');
  });
});

describe('sendInvite', () => {
  const config = {
    arkeselApiKey: 'ak',
    arkeselSenderId: 'PixelBarbr',
    resendApiKey: 'rk',
    emailFrom: 'Pixel Barber <no-reply@x.com>',
  };

  it('skips reserved .local test addresses without calling out', async () => {
    const fetchImpl = stubFetch(200, '{}');
    const r = await sendInvite({ email: 'a@test.pixelbarber.local' }, MESSAGE, config, fetchImpl);
    expect(r).toEqual({ delivered: false, reason: 'undeliverable_test_address' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('reports email_not_configured without a Resend key', async () => {
    const r = await sendInvite(
      { email: 'a@x.com' },
      MESSAGE,
      { ...config, resendApiKey: undefined },
      stubFetch(200, '{}'),
    );
    expect(r).toEqual({ delivered: false, reason: 'email_not_configured' });
  });

  it('sends email through Resend', async () => {
    const fetchImpl = stubFetch(200, '{"id":"e1"}');
    const r = await sendInvite({ email: 'a@x.com' }, MESSAGE, config, fetchImpl);
    expect(r).toEqual({ delivered: true });
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://api.resend.com/emails');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer rk');
    expect(JSON.parse(init.body as string)).toMatchObject({ to: ['a@x.com'], subject: 'subject' });
  });

  it('reports provider_error when Resend fails', async () => {
    const r = await sendInvite({ email: 'a@x.com' }, MESSAGE, config, stubFetch(500, 'boom'));
    expect(r).toEqual({ delivered: false, reason: 'provider_error' });
  });

  it('reports sms_not_configured without Arkesel secrets', async () => {
    const r = await sendInvite(
      { phone: '+233244123456' },
      MESSAGE,
      { ...config, arkeselApiKey: undefined },
      stubFetch(200, '{}'),
    );
    expect(r).toEqual({ delivered: false, reason: 'sms_not_configured' });
  });

  it('sends SMS through Arkesel', async () => {
    const fetchImpl = stubFetch(200, '{"status":"success","data":[]}');
    const r = await sendInvite({ phone: '+233244123456' }, MESSAGE, config, fetchImpl);
    expect(r).toEqual({ delivered: true });
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://sms.arkesel.com/api/v2/sms/send');
    expect(JSON.parse(init.body as string)).toMatchObject({
      sender: 'PixelBarbr',
      message: 'sms text',
      recipients: ['+233244123456'],
    });
  });

  it('reports provider_error when Arkesel says so or the call throws', async () => {
    expect(
      await sendInvite(
        { phone: '+233244123456' },
        MESSAGE,
        config,
        stubFetch(200, '{"status":"error"}'),
      ),
    ).toEqual({ delivered: false, reason: 'provider_error' });
    const throwing = vi.fn(async () => {
      throw new Error('network');
    });
    expect(await sendInvite({ phone: '+233244123456' }, MESSAGE, config, throwing)).toEqual({
      delivered: false,
      reason: 'provider_error',
    });
  });
});
