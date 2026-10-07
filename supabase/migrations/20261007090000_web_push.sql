-- Web push notifications (Docs/superpowers/specs/2026-10-07-web-push-notifications-design.md):
-- customers save/remove each device's push subscription, and claim_sms_notifications hands the
-- sender each customer's push flag and subscriptions so it can try push before SMS.

-- Saves this device's subscription for the calling customer. An endpoint already saved for someone
-- else moves to the caller (the latest sign-in on a device wins). Saving also turns push on.
-- Only https endpoints are accepted, so the sender never posts to arbitrary URLs.
create or replace function save_push_subscription(
  p_endpoint text,
  p_p256dh text,
  p_auth text,
  p_user_agent text
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_customer_id uuid;
begin
  select id into v_customer_id from customers where auth_user_id = auth.uid();
  if v_customer_id is null then
    raise exception 'not_a_customer';
  end if;
  if coalesce(p_endpoint, '') not like 'https://%'
     or coalesce(p_p256dh, '') = ''
     or coalesce(p_auth, '') = '' then
    raise exception 'invalid_subscription';
  end if;

  insert into push_subscriptions (customer_id, endpoint, p256dh_key, auth_key, user_agent, last_seen_at)
  values (v_customer_id, p_endpoint, p_p256dh, p_auth, p_user_agent, now())
  on conflict (endpoint) do update
    set customer_id = excluded.customer_id,
        p256dh_key = excluded.p256dh_key,
        auth_key = excluded.auth_key,
        user_agent = excluded.user_agent,
        last_seen_at = now();

  update customers set push_enabled = true where id = v_customer_id and not push_enabled;
end;
$$;

revoke execute on function save_push_subscription(text, text, text, text) from public, anon;
grant execute on function save_push_subscription(text, text, text, text) to authenticated;

-- Removes the calling customer's subscription for this endpoint (no error when absent or not theirs).
create or replace function remove_push_subscription(p_endpoint text)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  delete from push_subscriptions
  where endpoint = p_endpoint
    and customer_id = (select id from customers where auth_user_id = auth.uid());
end;
$$;

revoke execute on function remove_push_subscription(text) from public, anon;
grant execute on function remove_push_subscription(text) to authenticated;

-- claim_sms_notifications: identical to 20261002090200_claim_reminder_notifications.sql's definition
-- except it also returns the customer's push flag and subscriptions. Its return columns change, so
-- it is dropped and recreated.
drop function claim_sms_notifications(text[], int);

create function claim_sms_notifications(p_types text[], p_limit int)
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
  branch_name text,
  appointment_id uuid,
  appointment_status appointment_status,
  appointment_slot timestamptz,
  payload_slot text,
  push_enabled boolean,
  push_subscriptions jsonb
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
              n.related_ticket_id, n.related_appointment_id, n.payload
  )
  select c.id, c.notification_type, c.created_at, c.dispatch_attempts, c.recipient_id,
         cu.phone_e164, cu.sms_backup_enabled, t.id, t.state, t.ticket_number,
         coalesce(b.name, ab.name),
         a.id, a.status, a.scheduled_start, c.payload->>'slot',
         cu.push_enabled,
         coalesce(
           (select jsonb_agg(
                     jsonb_build_object('endpoint', ps.endpoint, 'p256dh', ps.p256dh_key, 'auth', ps.auth_key)
                     order by ps.created_at)
            from push_subscriptions ps
            where ps.customer_id = c.recipient_id),
           '[]'::jsonb)
  from claimed c
  left join customers cu on cu.id = c.recipient_id
  left join queue_tickets t on t.id = c.related_ticket_id
  left join branches b on b.id = t.branch_id
  left join appointments a on a.id = c.related_appointment_id
  left join branches ab on ab.id = a.branch_id;
$$;

revoke execute on function claim_sms_notifications(text[], int) from public, anon, authenticated;
grant execute on function claim_sms_notifications(text[], int) to service_role;
