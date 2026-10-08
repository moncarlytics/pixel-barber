-- Hardening for the staff customer page.
-- 1) Index for per-customer staff_message lookups (customer_detail 'messages').
-- 2) customer_detail compared payload ids with ::uuid casts. A cast fails the
--    whole query if any notification row for the customer has a non-uuid
--    value in that payload key, so a future notification type could break the
--    customer page. Compare as text instead; no cast can raise.

create index if not exists idx_notifications_staff_message_recipient
  on notifications (recipient_id, created_at desc)
  where notification_type = 'staff_message';

create or replace function customer_detail(p_customer_id uuid, p_branch_ids uuid[])
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_ids uuid[];
  v_full boolean := has_capability('message_customers');
  v_stats record;
  v_c customers%rowtype;
  v_marketing boolean;
begin
  v_ids := check_customer_access(p_branch_ids);
  select * into v_stats from customer_scope_stats(v_ids) s where s.customer_id = p_customer_id;
  if not found then
    raise exception 'not_found';
  end if;
  select * into v_c from customers where id = p_customer_id;
  select granted into v_marketing
  from consents
  where customer_id = p_customer_id and consent_type = 'marketing'
  order by created_at desc
  limit 1;

  return jsonb_build_object(
    'customer', jsonb_build_object(
      'id', v_c.id,
      'name', v_c.name,
      'phone', staff_phone(v_c.phone_e164, v_full),
      'email', v_c.email,
      'requires_confirmation_call', v_c.requires_confirmation_call,
      'push_enabled', v_c.push_enabled,
      'sms_backup_enabled', v_c.sms_backup_enabled,
      'marketing_allowed', coalesce(v_marketing, false)
    ),
    'stats', jsonb_build_object(
      'visits', v_stats.visits,
      'last_visit_at', v_stats.last_visit_at,
      'appointments', (
        select count(*) from appointments a
        where a.customer_id = p_customer_id and a.branch_id = any(v_ids)
      ),
      'no_shows', v_stats.no_shows,
      'cancellations', v_stats.cancellations,
      'late_cancellations', v_c.late_cancellation_count,
      'avg_rating_given', v_stats.avg_rating_given,
      'visits_last_90_days', v_stats.visits_last_90_days
    ),
    'group', v_stats.customer_group,
    'branch_ids', (
      select coalesce(jsonb_agg(b order by b), '[]'::jsonb)
      from unnest(v_ids) as b
      where exists (select 1 from queue_tickets qt where qt.customer_id = p_customer_id and qt.branch_id = b)
         or exists (select 1 from appointments a where a.customer_id = p_customer_id and a.branch_id = b)
    ),
    'visits', (
      select coalesce(jsonb_agg(q.x order by q.at desc), '[]'::jsonb)
      from (
        select t.created_at as at, jsonb_build_object(
          'ticket_id', t.id,
          'created_at', t.created_at,
          'branch_name', b.name,
          'service_name', s.name,
          'barber_name', su.name,
          'state', t.state,
          'cancel_reason', t.cancel_reason
        ) as x
        from queue_tickets t
        join branches b on b.id = t.branch_id
        join branch_services bs on bs.id = t.branch_service_id
        join services s on s.id = bs.service_id
        left join barbers br on br.id = t.assigned_barber_id
        left join staff_users su on su.id = br.staff_user_id
        where t.customer_id = p_customer_id and t.branch_id = any(v_ids)
        order by t.created_at desc
        limit 50
      ) q
    ),
    'feedback', (
      select coalesce(jsonb_agg(q.x order by q.at desc), '[]'::jsonb)
      from (
        select f.created_at as at, jsonb_build_object(
          'created_at', f.created_at,
          'branch_name', b.name,
          'barber_name', su.name,
          'overall_rating', f.overall_rating,
          'comment', f.comment
        ) as x
        from feedback f
        join branches b on b.id = f.branch_id
        left join barbers br on br.id = f.barber_id
        left join staff_users su on su.id = br.staff_user_id
        where f.customer_id = p_customer_id and f.branch_id = any(v_ids)
        order by f.created_at desc
        limit 20
      ) q
    ),
    'messages', (
      select coalesce(jsonb_agg(q.x order by q.at desc), '[]'::jsonb)
      from (
        select n.created_at as at, jsonb_build_object(
          'id', n.id,
          'created_at', n.created_at,
          'branch_name', n.payload->>'branch_name',
          'sent_by_name', su.name,
          'text', n.payload->>'text',
          'status', n.status,
          'failed_reason', n.failed_reason
        ) as x
        from notifications n
        left join staff_users su on su.id::text = n.payload->>'sent_by_staff_id'
        where n.recipient_type = 'customer'
          and n.recipient_id = p_customer_id
          and n.notification_type = 'staff_message'
          and n.payload->>'branch_id' = any(v_ids::text[])
        order by n.created_at desc
        limit 20
      ) q
    )
  );
end;
$$;

revoke execute on function customer_detail(uuid, uuid[]) from public, anon;
grant execute on function customer_detail(uuid, uuid[]) to authenticated;
