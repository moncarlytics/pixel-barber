// supabase/functions/send-notifications/index.ts
// Queue and appointment-reminder sender: web push first, SMS as fallback (Docs/superpowers/specs/2026-09-25-queue-sms-notifications-design.md;
// reminders: Docs/superpowers/specs/2026-10-02-appointments-reminders-checkin-wait-design.md; push: Docs/superpowers/specs/2026-10-07-web-push-notifications-design.md). Called
// every 30 seconds by the send-notifications pg_cron job (and by tests) with the service role key;
// never by the apps. Claims pending SMS notifications, decides each (stale / expired / opted out /
// no phone / live sending off), texts the rest through Arkesel, and records sent or failed.
// Texts go out ONLY when SMS_NOTIFICATIONS_LIVE=true -- this project is shared with automated tests
// whose made-up Ghana numbers may belong to real people. Auth is verified through the database:
// only service_role tokens can call claim_sms_notifications; anon and user tokens are revoked.
import { createClient } from '@supabase/supabase-js';
import { corsHeaders } from '../_shared/cors.ts';
import { json } from '../_shared/http.ts';
import { sendArkeselSms } from '../_shared/arkesel.ts';
import {
  PUSH_TTL_SECONDS,
  buildPushPayload,
  goneEndpoints,
  pushDelivered,
  pushTargets,
  pushUrgency,
  shouldAttemptPush,
  smsSentStatus,
} from '../_shared/notification-push-core.ts';
import { loadPushConfig, sendWebPush } from '../_shared/web-push.ts';
import {
  DISPATCH_BATCH_SIZE,
  RUN_DEADLINE_MS,
  SMS_NOTIFICATION_TYPES,
  afterProviderError,
  buildNotificationSms,
  decideNotification,
  isUsableCustomerAppUrl,
  parseAllowlist,
  precheckNotification,
  ticketLink,
  type ClaimedNotification,
  type SmsNotificationType,
} from '../_shared/notification-sms-core.ts';

async function isServiceRoleCaller(authHeader: string | null): Promise<boolean> {
  if (!authHeader || !authHeader.startsWith('Bearer ')) return false;

  const envKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
  // Fast path: exact match with env key (legacy .env.local behavior)
  if (authHeader === `Bearer ${envKey}`) return true;

  // Database-verified check: create client as the caller and attempt claim
  const caller = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_ANON_KEY')!, {
    global: { headers: { Authorization: authHeader } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { error } = await caller.rpc('claim_sms_notifications', { p_types: [], p_limit: 0 });
  return !error;
}

Deno.serve(async (req) => {
  const startedAt = Date.now();
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: corsHeaders });
  if (req.method !== 'POST') return json(405, { error: 'Method not allowed' });

  if (!(await isServiceRoleCaller(req.headers.get('Authorization')))) {
    return json(401, { error: 'Unauthorized' });
  }

  const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

  const admin = createClient(Deno.env.get('SUPABASE_URL')!, serviceRoleKey);
  const live = Deno.env.get('SMS_NOTIFICATIONS_LIVE') === 'true';
  const customerAppUrl = Deno.env.get('CUSTOMER_APP_URL') ?? '';
  const allowlist = parseAllowlist(Deno.env.get('SMS_NOTIFICATIONS_ALLOWLIST') ?? undefined);
  const arkesel = {
    apiKey: Deno.env.get('ARKESEL_API_KEY') ?? undefined,
    senderId: Deno.env.get('ARKESEL_SENDER_ID') ?? undefined,
  };
  const pushConfig = loadPushConfig();

  const { data, error } = await admin.rpc('claim_sms_notifications', {
    p_types: [...SMS_NOTIFICATION_TYPES],
    p_limit: DISPATCH_BATCH_SIZE,
  });
  if (error) {
    console.error('send-notifications: claim failed', error);
    return json(500, { error: 'Could not claim notifications' });
  }
  const rows = (data ?? []) as ClaimedNotification[];
  const summary = {
    claimed: rows.length,
    pushed: 0,
    sent: 0,
    retried: 0,
    failed: 0,
    deferred: 0,
    skipped: {} as Record<string, number>,
  };

  const fail = async (id: string, reason: string) => {
    const { error: updateError } = await admin
      .from('notifications')
      .update({ status: 'failed', failed_reason: reason, dispatch_claimed_at: null })
      .eq('id', id);
    if (updateError)
      console.error('send-notifications: could not record failure', { id, reason, updateError });
  };

  const release = async (id: string) => {
    const { error: releaseError } = await admin
      .from('notifications')
      .update({ dispatch_claimed_at: null })
      .eq('id', id);
    if (releaseError)
      console.error('send-notifications: could not release claim', { id, releaseError });
  };

  for (const n of rows) {
    // Past the per-run deadline, stop sending and give this row (and every row after it) back to the
    // queue rather than hold a stale claim until the next run's reclaim window passes.
    if (Date.now() - startedAt > RUN_DEADLINE_MS) {
      await release(n.notification_id);
      summary.deferred++;
      continue;
    }

    const now = new Date();
    const pre = precheckNotification(n, now);
    if (pre.action === 'skip') {
      await fail(n.notification_id, pre.reason);
      summary.skipped[pre.reason] = (summary.skipped[pre.reason] ?? 0) + 1;
      continue;
    }
    // precheckNotification already rejected types outside SMS_NOTIFICATION_TYPES as stale.
    const type = n.notification_type as SmsNotificationType;

    // Push first: every saved device; any device accepting it means delivered (no SMS).
    let pushAttempted = false;
    if (pushConfig && shouldAttemptPush(n)) {
      pushAttempted = true;
      const payload = buildPushPayload(type, n);
      const targets = pushTargets(n);
      const results = await Promise.all(
        targets.map((target) =>
          sendWebPush(pushConfig, target, payload, {
            ttl: PUSH_TTL_SECONDS,
            urgency: pushUrgency(type),
          }),
        ),
      );
      const gone = goneEndpoints(targets, results);
      if (gone.length > 0) {
        const { error: goneError } = await admin
          .from('push_subscriptions')
          .delete()
          .in('endpoint', gone);
        if (goneError)
          console.error('send-notifications: could not delete gone subscriptions', goneError);
      }
      if (pushDelivered(results)) {
        const { error: pushedError } = await admin
          .from('notifications')
          .update({
            channel: 'push',
            status: 'sent',
            sent_at: new Date().toISOString(),
            failed_reason: null,
            dispatch_claimed_at: null,
          })
          .eq('id', n.notification_id);
        if (pushedError)
          console.error('send-notifications: could not record push', {
            id: n.notification_id,
            pushedError,
          });
        summary.pushed++;
        continue;
      }
    }

    // SMS: no push attempt, or every device failed.
    const decision = decideNotification(n, now, live, allowlist);
    if (decision.action === 'skip') {
      await fail(n.notification_id, decision.reason);
      summary.skipped[decision.reason] = (summary.skipped[decision.reason] ?? 0) + 1;
      continue;
    }
    // decision.action === 'send' only when live sending is on (decideNotification), so this is the
    // live-only "no localhost link" guard as well as the plain missing-URL guard.
    if (!customerAppUrl || (live && !isUsableCustomerAppUrl(customerAppUrl))) {
      await fail(n.notification_id, 'not_configured');
      summary.failed++;
      continue;
    }

    const message = buildNotificationSms(type, {
      branchName: n.branch_name ?? 'Pixel Barber',
      ticketNumber: n.ticket_number ?? '',
      link: n.ticket_id ? ticketLink(customerAppUrl, n.ticket_id) : '',
      slot: n.appointment_slot ?? undefined,
    });
    const result = await sendArkeselSms(n.phone_e164!, message, arkesel);

    if (result === 'sent') {
      const { error: updateError } = await admin
        .from('notifications')
        .update({
          status: smsSentStatus(pushAttempted),
          sent_at: new Date().toISOString(),
          failed_reason: null,
          dispatch_claimed_at: null,
        })
        .eq('id', n.notification_id);
      if (updateError)
        console.error('send-notifications: could not record send', {
          id: n.notification_id,
          updateError,
        });
      summary.sent++;
    } else if (result === 'not_configured') {
      await fail(n.notification_id, 'not_configured');
      summary.failed++;
    } else if (result === 'unknown_outcome') {
      // The request timed out: Arkesel may already have sent this text, so it is never retried.
      console.error('send-notifications: unknown outcome (timeout), not retrying', {
        id: n.notification_id,
      });
      await fail(n.notification_id, 'unknown_outcome');
      summary.failed++;
    } else if (afterProviderError(n.dispatch_attempts) === 'retry') {
      console.error('send-notifications: provider error, will retry', {
        id: n.notification_id,
        attempts: n.dispatch_attempts,
      });
      await release(n.notification_id);
      summary.retried++;
    } else {
      console.error('send-notifications: provider error, giving up', { id: n.notification_id });
      await fail(n.notification_id, 'provider_error');
      summary.failed++;
    }
  }

  return json(200, summary);
});
