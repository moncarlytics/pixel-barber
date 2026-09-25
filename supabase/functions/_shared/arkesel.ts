// supabase/functions/_shared/arkesel.ts
// The one Arkesel SMS call used by staff invites and queue notifications. No Deno APIs and no
// imports, so Vitest can import it. (send-sms, the auth OTP hook, keeps its own copy of
// isArkeselSuccess because its module calls Deno.serve on import.)

export interface ArkeselConfig {
  apiKey?: string;
  senderId?: string;
}

// Arkesel's confirmed v2 success shape is { status: "success", data: {...} }: a non-2xx is always a
// failure, and a 2xx body that explicitly says status !== "success" is also a failure; anything else
// 2xx is treated as success.
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

/** Sends one SMS. Never throws.
 * A timeout means the request never got a response -- Arkesel may or may not have already sent the
 * text -- so it is reported separately as 'unknown_outcome' rather than 'provider_error': callers
 * that retry on 'provider_error' must NOT retry an 'unknown_outcome', or a message that already went
 * out could be sent again. */
export async function sendArkeselSms(
  phone: string,
  message: string,
  config: ArkeselConfig,
  fetchImpl: typeof fetch = fetch,
): Promise<'sent' | 'not_configured' | 'provider_error' | 'unknown_outcome'> {
  if (!config.apiKey || !config.senderId) return 'not_configured';
  try {
    const response = await fetchImpl('https://sms.arkesel.com/api/v2/sms/send', {
      method: 'POST',
      headers: { 'api-key': config.apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({ sender: config.senderId, message, recipients: [phone] }),
      signal: AbortSignal.timeout(10_000),
    });
    const rawBody = await response.text();
    return isArkeselSuccess(response.ok, rawBody) ? 'sent' : 'provider_error';
  } catch (err) {
    // DOMException (the timeout/abort signal) does not extend Error, so name is read structurally.
    const name = (err as { name?: unknown } | null)?.name;
    if (name === 'TimeoutError' || name === 'AbortError') return 'unknown_outcome';
    return 'provider_error';
  }
}
