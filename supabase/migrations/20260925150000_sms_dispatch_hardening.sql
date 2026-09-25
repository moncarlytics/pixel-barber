-- Queue SMS notifications: final-review hardening
-- (Docs/superpowers/specs/2026-09-25-queue-sms-notifications-design.md, Amendments section).
--
-- 1. claim_sms_notifications: the reclaim window widens from 5 to 10 minutes -- exactly the
--    per-notification expiry (MAX_NOTIFICATION_AGE_MINUTES in
--    _shared/notification-sms-core.ts). A row a crashed run left claimed can now only be reclaimed
--    once it is already 'expired' by the time it is decided again, so a slow-but-alive run and a
--    reclaim can never both text the same customer.
-- 2. The 30-second cron job is re-scheduled with an explicit 60-second pg_net timeout, matching the
--    sender's own RUN_DEADLINE_MS, so a hung HTTP call is never left to block indefinitely.
-- 3. A partial index speeds up claim_sms_notifications' scan for pending SMS rows.

-- claim_sms_notifications: identical to 20260925130000_youre_next_notifications.sql's definition
-- except the reclaim condition is now 'dispatch_claimed_at < now() - interval '10 minutes''.
create or replace function claim_sms_notifications(p_types text[], p_limit int)
returns table (
  notification_id uuid,
  notification_type text,
  created_at timestamptz,
  dispatch_attempts smallint,
  customer_id uuid,
  phone_e164 text,
  sms_backup_enabled boolean,
  ticket_id uuid,
  ticket_state ticket_state,
  ticket_number text,
  branch_name text
)
language sql
security definer
set search_path = public, pg_temp
as $$
  with claimed as (
    update notifications n
    set dispatch_claimed_at = now(),
        dispatch_attempts = n.dispatch_attempts + 1
    where n.id in (
      select id from notifications
      where channel = 'sms'
        and status = 'pending'
        and notification_type = any(p_types)
        and (dispatch_claimed_at is null or dispatch_claimed_at < now() - interval '10 minutes')
      order by created_at
      limit p_limit
      for update skip locked
    )
    returning n.id, n.notification_type, n.created_at, n.dispatch_attempts, n.recipient_id,
              n.related_ticket_id
  )
  select c.id, c.notification_type, c.created_at, c.dispatch_attempts, c.recipient_id,
         cu.phone_e164, cu.sms_backup_enabled, t.id, t.state, t.ticket_number, b.name
  from claimed c
  left join customers cu on cu.id = c.recipient_id
  left join queue_tickets t on t.id = c.related_ticket_id
  left join branches b on b.id = t.branch_id;
$$;

revoke execute on function claim_sms_notifications(text[], int) from public, anon, authenticated;
grant execute on function claim_sms_notifications(text[], int) to service_role;

-- Re-schedule the send-notifications job under the same name (replacing the previous schedule from
-- 20260925140000_send_notifications_cron.sql), now passing an explicit 60-second pg_net timeout.
select cron.schedule(
  'send-notifications',
  '30 seconds',
  $$
  select net.http_post(
    url := (select decrypted_secret from vault.decrypted_secrets where name = 'project_url')
           || '/functions/v1/send-notifications',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'notifications_dispatch_key')
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 60000
  );
  $$
);

-- Speeds up claim_sms_notifications' scan for pending SMS rows.
create index if not exists idx_notifications_pending_sms
  on notifications (created_at) where status = 'pending' and channel = 'sms';
