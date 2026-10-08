-- Customer list (Docs/superpowers/specs/2026-10-08-customer-list-design.md): staff see the
-- customers of their branches with in-branch numbers and groups, open one customer's history, and
-- send a short service message (a staff_message notification delivered by send-notifications).

insert into capabilities (key, description) values
  ('view_customers', 'View the customer list')
on conflict do nothing;

insert into role_capabilities (role, capability) values
  ('owner', 'view_customers'),
  ('branch_manager', 'view_customers'),
  ('receptionist', 'view_customers'),
  ('analyst', 'view_customers')
on conflict do nothing;

-- 0244123456 for staff who message customers; 024•••3456 for everyone else.
create or replace function staff_phone(p_e164 text, p_full boolean)
returns text
language sql
immutable
set search_path = public, pg_temp
as $$
  select case
    when p_e164 is null then null
    when p_full then l
    else left(l, 3) || '•••' || right(l, 4)
  end
  from (select case when p_e164 like '+233%' then '0' || substr(p_e164, 5) else p_e164 end as l) x;
$$;

revoke execute on function staff_phone(text, boolean) from public, anon, authenticated;

-- Every visible customer (a ticket or appointment at one of p_branch_ids, not anonymized) with
-- numbers counted at those branches only, and the group they fall in. Internal: callers check
-- access first.
create or replace function customer_scope_stats(p_branch_ids uuid[])
returns table (
  customer_id uuid,
  visits integer,
  last_visit_at timestamptz,
  no_shows integer,
  cancellations integer,
  visits_last_90_days integer,
  avg_rating_given numeric,
  customer_group text
)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  with visible as (
    select qt.customer_id from queue_tickets qt where qt.branch_id = any(p_branch_ids)
    union
    select a.customer_id from appointments a where a.branch_id = any(p_branch_ids)
  ),
  t as (
    select
      qt.customer_id,
      count(*) filter (where qt.state = 'completed') as visits,
      max(coalesce(qt.completed_at, qt.updated_at)) filter (where qt.state = 'completed') as last_visit_at,
      count(*) filter (where qt.state = 'no_show') as no_shows,
      count(*) filter (where qt.state = 'cancelled') as cancellations,
      count(*) filter (where qt.state = 'completed'
                         and coalesce(qt.completed_at, qt.updated_at) > now() - interval '90 days') as v90
    from queue_tickets qt
    where qt.branch_id = any(p_branch_ids)
    group by qt.customer_id
  ),
  fb as (
    select f.customer_id, round(avg(f.overall_rating), 2) as avg_rating
    from feedback f
    where f.branch_id = any(p_branch_ids)
    group by f.customer_id
  )
  select
    c.id,
    coalesce(t.visits, 0)::int,
    t.last_visit_at,
    coalesce(t.no_shows, 0)::int,
    coalesce(t.cancellations, 0)::int,
    coalesce(t.v90, 0)::int,
    fb.avg_rating,
    case
      when coalesce(t.visits, 0) = 0 then 'new'
      when t.last_visit_at < now() - interval '90 days' then 'lapsed'
      when coalesce(t.no_shows, 0) >= 3 or c.late_cancellation_count >= 3 then 'at_risk'
      when coalesce(t.v90, 0) >= 3 then 'frequent'
      else 'returning'
    end
  from (select distinct v.customer_id from visible v) v
  join customers c on c.id = v.customer_id and not c.is_anonymized
  left join t on t.customer_id = c.id
  left join fb on fb.customer_id = c.id;
$$;

revoke execute on function customer_scope_stats(uuid[]) from public, anon, authenticated;

-- Shared access check: view_customers, a non-empty branch list, every branch in scope. Returns the
-- de-duplicated branch ids.
create or replace function check_customer_access(p_branch_ids uuid[])
returns uuid[]
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_ids uuid[] := array(select distinct b from unnest(p_branch_ids) as b where b is not null);
  v_branch uuid;
begin
  if cardinality(v_ids) = 0 or not has_capability('view_customers') then
    raise exception 'not_allowed';
  end if;
  foreach v_branch in array v_ids loop
    if not in_branch_scope(v_branch) then
      raise exception 'not_allowed';
    end if;
  end loop;
  return v_ids;
end;
$$;

revoke execute on function check_customer_access(uuid[]) from public, anon, authenticated;

create or replace function list_customers(
  p_branch_ids uuid[],
  p_search text,
  p_group text,
  p_offset integer default 0
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_ids uuid[];
  v_search text := nullif(btrim(coalesce(p_search, '')), '');
  v_digits text;
  v_full boolean := has_capability('message_customers');
  v_offset integer := greatest(coalesce(p_offset, 0), 0);
  v_result jsonb;
begin
  v_ids := check_customer_access(p_branch_ids);
  if p_group is not null and p_group not in ('new', 'returning', 'frequent', 'lapsed', 'at_risk') then
    raise exception 'invalid_group';
  end if;
  v_digits := regexp_replace(coalesce(v_search, ''), '\D', '', 'g');
  if length(v_digits) >= 3 then
    if left(v_digits, 1) = '0' then
      v_digits := '233' || substr(v_digits, 2);
    end if;
  else
    v_digits := null;
  end if;

  with matched as (
    select s.*, c.name, c.phone_e164
    from customer_scope_stats(v_ids) s
    join customers c on c.id = s.customer_id
    where (p_group is null or s.customer_group = p_group)
      and (
        v_search is null
        or (v_digits is not null
            and regexp_replace(coalesce(c.phone_e164, ''), '\D', '', 'g') like '%' || v_digits || '%')
        or (v_digits is null and c.name ilike '%' || v_search || '%')
      )
  ),
  ranked as (
    select m.*, row_number() over (order by m.last_visit_at desc nulls last, m.name, m.customer_id) as rn
    from matched m
  ),
  page as (
    select * from ranked where rn > v_offset and rn <= v_offset + 51
  )
  select jsonb_build_object(
    'rows', coalesce(jsonb_agg(jsonb_build_object(
      'id', p.customer_id,
      'name', p.name,
      'phone', staff_phone(p.phone_e164, v_full),
      'last_visit_at', p.last_visit_at,
      'visits', p.visits,
      'no_shows', p.no_shows,
      'avg_rating_given', p.avg_rating_given,
      'group', p.customer_group
    ) order by p.rn) filter (where p.rn <= v_offset + 50), '[]'::jsonb),
    'has_more', count(*) > 50
  )
  into v_result
  from page p;

  return v_result;
end;
$$;

revoke execute on function list_customers(uuid[], text, text, integer) from public, anon;
grant execute on function list_customers(uuid[], text, text, integer) to authenticated;

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
        left join staff_users su on su.id = (n.payload->>'sent_by_staff_id')::uuid
        where n.recipient_type = 'customer'
          and n.recipient_id = p_customer_id
          and n.notification_type = 'staff_message'
          and (n.payload->>'branch_id')::uuid = any(v_ids)
        order by n.created_at desc
        limit 20
      ) q
    )
  );
end;
$$;

revoke execute on function customer_detail(uuid, uuid[]) from public, anon;
grant execute on function customer_detail(uuid, uuid[]) to authenticated;

create or replace function send_customer_message(p_customer_id uuid, p_branch_id uuid, p_text text)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_text text := btrim(coalesce(p_text, ''));
  v_day_start timestamptz :=
    ((now() at time zone 'Africa/Accra')::date)::timestamp at time zone 'Africa/Accra';
  v_branch_name text;
  v_id uuid;
begin
  if p_branch_id is null
     or not (has_capability('message_customers') and in_branch_scope(p_branch_id)) then
    raise exception 'not_allowed';
  end if;
  if not exists (
    select 1 from customer_scope_stats(array[p_branch_id]) s where s.customer_id = p_customer_id
  ) then
    raise exception 'not_found';
  end if;
  if v_text = '' then
    raise exception 'empty_message';
  end if;
  if char_length(v_text) > 140 then
    raise exception 'message_too_long';
  end if;
  if (
    select count(*) from notifications n
    where n.recipient_type = 'customer'
      and n.recipient_id = p_customer_id
      and n.notification_type = 'staff_message'
      and n.payload->>'branch_id' = p_branch_id::text
      and n.created_at >= v_day_start
  ) >= 5 then
    raise exception 'daily_limit';
  end if;
  select name into v_branch_name from branches where id = p_branch_id;
  insert into notifications (recipient_type, recipient_id, channel, notification_type, payload)
  values (
    'customer',
    p_customer_id,
    'sms',
    'staff_message',
    jsonb_build_object(
      'text', v_text,
      'branch_id', p_branch_id,
      'branch_name', v_branch_name,
      'sent_by_staff_id', auth_staff_id()
    )
  )
  returning id into v_id;
  return v_id;
end;
$$;

revoke execute on function send_customer_message(uuid, uuid, text) from public, anon;
grant execute on function send_customer_message(uuid, uuid, text) to authenticated;
