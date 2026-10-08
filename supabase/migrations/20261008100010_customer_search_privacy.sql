-- Masked callers (no message_customers) find a phone only by the full number, so partial digit
-- search cannot rebuild a masked number; and the daily message limit is checked under a lock.

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
            and case
                  when v_full then regexp_replace(coalesce(c.phone_e164, ''), '\D', '', 'g') like '%' || v_digits || '%'
                  else regexp_replace(coalesce(c.phone_e164, ''), '\D', '', 'g') = v_digits
                end)
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
  perform pg_advisory_xact_lock(hashtext(p_customer_id::text || ':' || p_branch_id::text));
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
