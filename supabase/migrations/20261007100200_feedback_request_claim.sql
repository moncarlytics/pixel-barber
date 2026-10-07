-- After-visit feedback: claim_sms_notifications also says whether the ticket has been rated, so a
-- feedback_request that's already answered is skipped. Return columns change, so it is dropped and
-- recreated; otherwise identical to 20261007090100_web_push_hardening.sql.

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
  push_subscriptions jsonb,
  ticket_has_feedback boolean
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
                     jsonb_build_object('endpoint', s.endpoint, 'p256dh', s.p256dh_key, 'auth', s.auth_key)
                     order by s.last_seen_at desc)
            from (select endpoint, p256dh_key, auth_key, last_seen_at
                  from push_subscriptions ps
                  where ps.customer_id = c.recipient_id
                  order by ps.last_seen_at desc
                  limit 10) s),
           '[]'::jsonb)
         , exists (select 1 from feedback fb where fb.ticket_id = c.related_ticket_id)
  from claimed c
  left join customers cu on cu.id = c.recipient_id
  left join queue_tickets t on t.id = c.related_ticket_id
  left join branches b on b.id = t.branch_id
  left join appointments a on a.id = c.related_appointment_id
  left join branches ab on ab.id = a.branch_id;
$$;

revoke execute on function claim_sms_notifications(text[], int) from public, anon, authenticated;
grant execute on function claim_sms_notifications(text[], int) to service_role;
