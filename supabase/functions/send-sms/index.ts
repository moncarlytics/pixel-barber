// supabase/functions/send-sms/index.ts
import { Webhook } from 'standardwebhooks';

const ARKESEL_API_KEY = Deno.env.get('ARKESEL_API_KEY');
const ARKESEL_SENDER_ID = Deno.env.get('ARKESEL_SENDER_ID');
const SEND_SMS_HOOK_SECRET = Deno.env.get('SEND_SMS_HOOK_SECRET');

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function errorResponse(httpCode: number, message: string): Response {
  return jsonResponse(httpCode, { error: { http_code: httpCode, message } });
}

interface SendSmsHookPayload {
  user: { phone?: string };
  sms: { otp?: string };
}

export function extractRecipient(payload: SendSmsHookPayload): string | null {
  const phone = payload.user?.phone;
  if (!phone) return null;
  return phone.startsWith('+') ? phone : `+${phone}`;
}

export function buildOtpMessage(otp: string): string {
  return `Your Pixel Barber verification code is ${otp}`;
}

// Arkesel's confirmed v2 success shape is { status: "success", data: {...} }. Its exact error-body
// field names are not fully documented, so this only trusts what's confirmed: a non-2xx HTTP status
// is always a failure, and a 2xx body that explicitly says status !== "success" is also a failure.
// Anything else 2xx is treated as success rather than guessing at undocumented error fields.
export function isArkeselSuccess(httpOk: boolean, rawBody: string): boolean {
  if (!httpOk) return false;
  try {
    const parsed = JSON.parse(rawBody) as { status?: string };
    return parsed.status === undefined || parsed.status === 'success';
  } catch {
    return true;
  }
}

Deno.serve(async (req) => {
  if (req.method !== 'POST') {
    return errorResponse(405, 'Method not allowed');
  }

  if (!SEND_SMS_HOOK_SECRET || !ARKESEL_API_KEY || !ARKESEL_SENDER_ID) {
    console.error('send-sms function is missing required secrets');
    return errorResponse(500, 'send-sms function is not configured');
  }

  const payload = await req.text();
  const headers = Object.fromEntries(req.headers);
  const base64Secret = SEND_SMS_HOOK_SECRET.replace('v1,whsec_', '');
  const wh = new Webhook(base64Secret);

  let verified: SendSmsHookPayload;
  try {
    verified = wh.verify(payload, headers) as SendSmsHookPayload;
  } catch (err) {
    console.error('Send SMS Hook signature verification failed', err);
    return errorResponse(401, 'Invalid signature');
  }

  const recipient = extractRecipient(verified);
  const otp = verified.sms?.otp;
  if (!recipient || !otp) {
    return errorResponse(400, 'Malformed hook payload');
  }

  let arkeselResponse: Response;
  try {
    arkeselResponse = await fetch('https://sms.arkesel.com/api/v2/sms/send', {
      method: 'POST',
      headers: {
        'api-key': ARKESEL_API_KEY,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        sender: ARKESEL_SENDER_ID,
        message: buildOtpMessage(otp),
        recipients: [recipient],
      }),
    });
  } catch (err) {
    console.error('Failed to reach Arkesel', err);
    return errorResponse(502, 'Failed to reach SMS provider');
  }

  const arkeselBody = await arkeselResponse.text();

  if (!isArkeselSuccess(arkeselResponse.ok, arkeselBody)) {
    console.error('Arkesel reported failure', arkeselResponse.status, arkeselBody);
    return errorResponse(502, `SMS provider returned ${arkeselResponse.status}`);
  }

  return jsonResponse(200, {});
});
