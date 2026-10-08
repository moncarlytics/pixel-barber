-- Reports (Docs/superpowers/specs/2026-10-08-reports-dashboard-design.md, Section 2): one call
-- returns every report section for a Ghana-date range over one branch, or several branches for
-- business-wide viewers. A ticket belongs to the Africa/Accra date it joined the queue.

create index if not exists idx_queue_tickets_customer_created on queue_tickets (customer_id, created_at);

create or replace function branch_report(p_branch_ids uuid[], p_from date, p_to date)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_branch uuid;
  v_start timestamptz;
  v_end timestamptz;
  v_days integer;
  v_result jsonb;
begin
  p_branch_ids := array(select distinct b from unnest(p_branch_ids) as b where b is not null);
  if cardinality(p_branch_ids) = 0 or not has_capability('view_branch_reports') then
    raise exception 'not_allowed';
  end if;
  foreach v_branch in array p_branch_ids loop
    if not in_branch_scope(v_branch) then
      raise exception 'not_allowed';
    end if;
  end loop;
  if cardinality(p_branch_ids) > 1 and not has_capability('view_business_reports') then
    raise exception 'not_allowed';
  end if;
  if p_from is null or p_to is null or p_from > p_to or p_to - p_from > 91 then
    raise exception 'invalid_range';
  end if;

  v_start := p_from::timestamp at time zone 'Africa/Accra';
  v_end := (p_to + 1)::timestamp at time zone 'Africa/Accra';
  v_days := p_to - p_from + 1;

  with tix as (
    select
      t.id,
      t.branch_id,
      t.customer_id,
      t.state,
      t.appointment_id,
      t.assigned_barber_id,
      t.branch_service_id,
      t.cancel_reason,
      (t.created_at at time zone 'Africa/Accra')::date as visit_date,
      extract(hour from t.created_at at time zone 'Africa/Accra')::int as visit_hour,
      t.state = 'completed' as served,
      case when t.state = 'completed' and t.service_started_at is not null
        then extract(epoch from t.service_started_at - t.created_at) / 60 end as wait_min,
      case when t.state = 'completed' and t.service_started_at is not null
            and t.completed_at is not null
        then extract(epoch from t.completed_at - t.service_started_at) / 60 end as service_min,
      case when t.state = 'completed' then coalesce((
        select p.price_ghs
        from branch_service_prices p
        where p.branch_service_id = t.branch_service_id
          and p.effective_from <= (t.created_at at time zone 'Africa/Accra')::date
          and (p.effective_until is null
               or p.effective_until >= (t.created_at at time zone 'Africa/Accra')::date)
        order by p.is_promo desc, p.effective_from desc
        limit 1
      ), 0) else 0 end as takings,
      f.overall_rating,
      t.state = 'completed' and exists (
        select 1 from queue_tickets prev
        where prev.customer_id = t.customer_id
          and prev.state = 'completed'
          and prev.created_at < v_start
      ) as is_returning
    from queue_tickets t
    left join feedback f on f.ticket_id = t.id
    where t.branch_id = any(p_branch_ids) and t.created_at >= v_start and t.created_at < v_end
  ),
  summaries as (
    -- One row for the whole selection (is_total) plus one per requested branch; the left join
    -- keeps branches without visits, so every aggregate counts x.id rather than rows.
    select
      rb.branch_id,
      grouping(rb.branch_id) = 1 as is_total,
      jsonb_build_object(
        'served', count(x.id) filter (where x.served),
        'walk_ins', count(x.id) filter (where x.served and x.appointment_id is null),
        'appointments', count(x.id) filter (where x.served and x.appointment_id is not null),
        'no_shows', count(x.id) filter (where x.state = 'no_show'),
        'no_show_rate', round(100.0 * count(x.id) filter (where x.state = 'no_show')
          / nullif(count(x.id) filter (where x.served or x.state = 'no_show'), 0), 1),
        'cancellations', count(x.id) filter (where x.state = 'cancelled'),
        'cancellation_rate', round(100.0 * count(x.id) filter (where x.state = 'cancelled')
          / nullif(count(x.id), 0), 1),
        'avg_wait_min', round(avg(x.wait_min))::int,
        'median_wait_min', round((percentile_cont(0.5) within group (order by x.wait_min))::numeric)::int,
        'avg_service_min', round(avg(x.service_min))::int,
        'rating_count', count(x.overall_rating),
        'rating_average', round(avg(x.overall_rating), 2),
        'est_takings_ghs', coalesce(round(sum(x.takings), 2), 0),
        'returning_rate', round(100.0 * count(distinct x.customer_id) filter (where x.is_returning)
          / nullif(count(distinct x.customer_id) filter (where x.served), 0), 1)
      ) as data
    from unnest(p_branch_ids) as rb(branch_id)
    left join tix x on x.branch_id = rb.branch_id
    group by grouping sets ((), (rb.branch_id))
  ),
  daily as (
    select
      d.day::date as day,
      count(x.id) filter (where x.served) as served,
      count(x.id) filter (where x.served and x.appointment_id is null) as walk_ins,
      count(x.id) filter (where x.served and x.appointment_id is not null) as appointments,
      count(x.id) filter (where x.state = 'no_show') as no_shows,
      count(x.id) filter (where x.state = 'cancelled') as cancellations,
      round(avg(x.wait_min))::int as avg_wait_min,
      round(avg(x.service_min))::int as avg_service_min,
      round(avg(x.overall_rating), 2) as rating_average,
      coalesce(round(sum(x.takings), 2), 0) as est_takings_ghs
    from generate_series(p_from::timestamp, p_to::timestamp, interval '1 day') as d(day)
    left join tix x on x.visit_date = d.day::date
    group by d.day
  ),
  hours as (
    select
      x.visit_hour as hour,
      round(count(*)::numeric / v_days, 1) as avg_joined_per_day,
      round(avg(x.wait_min))::int as avg_wait_min
    from tix x
    group by x.visit_hour
  ),
  barber_rows as (
    select
      b.id as barber_id,
      su.name,
      count(*) filter (where x.served) as served,
      round(avg(x.service_min))::int as avg_service_min,
      count(*) filter (where x.state = 'no_show') as no_shows,
      round(avg(x.overall_rating), 2) as rating_average,
      coalesce(round(sum(x.takings), 2), 0) as est_takings_ghs
    from tix x
    join barbers b on b.id = x.assigned_barber_id
    join staff_users su on su.id = b.staff_user_id
    group by b.id, su.name
  ),
  service_rows as (
    select
      s.name,
      count(*) filter (where x.served) as served,
      round(avg(x.service_min))::int as avg_service_min,
      max(coalesce(bs.duration_minutes_override, s.default_duration_minutes)) as listed_duration_min,
      coalesce(round(sum(x.takings), 2), 0) as est_takings_ghs
    from tix x
    join branch_services bs on bs.id = x.branch_service_id
    join services s on s.id = bs.service_id
    group by s.id, s.name
  ),
  reason_rows as (
    select coalesce(x.cancel_reason::text, 'other') as reason, count(*) as n
    from tix x
    where x.state = 'cancelled'
    group by 1
  )
  select jsonb_build_object(
    'summary', (select s.data from summaries s where s.is_total),
    'daily', (
      select coalesce(jsonb_agg(jsonb_build_object(
        'date', d.day,
        'served', d.served,
        'walk_ins', d.walk_ins,
        'appointments', d.appointments,
        'no_shows', d.no_shows,
        'cancellations', d.cancellations,
        'avg_wait_min', d.avg_wait_min,
        'avg_service_min', d.avg_service_min,
        'rating_average', d.rating_average,
        'est_takings_ghs', d.est_takings_ghs
      ) order by d.day), '[]'::jsonb)
      from daily d
    ),
    'hours', (
      select coalesce(jsonb_agg(jsonb_build_object(
        'hour', h.hour,
        'avg_joined_per_day', h.avg_joined_per_day,
        'avg_wait_min', h.avg_wait_min
      ) order by h.hour), '[]'::jsonb)
      from hours h
    ),
    'barbers', (
      select coalesce(jsonb_agg(jsonb_build_object(
        'barber_id', br.barber_id,
        'name', br.name,
        'served', br.served,
        'avg_service_min', br.avg_service_min,
        'no_shows', br.no_shows,
        'rating_average', br.rating_average,
        'est_takings_ghs', br.est_takings_ghs
      ) order by br.served desc, br.name), '[]'::jsonb)
      from barber_rows br
    ),
    'services', (
      select coalesce(jsonb_agg(jsonb_build_object(
        'name', sv.name,
        'served', sv.served,
        'share', sv.share,
        'avg_service_min', sv.avg_service_min,
        'listed_duration_min', sv.listed_duration_min,
        'est_takings_ghs', sv.est_takings_ghs
      ) order by sv.served desc, sv.name), '[]'::jsonb)
      from (
        select service_rows.*,
          round(100.0 * served / nullif(sum(served) over (), 0), 1) as share
        from service_rows
      ) sv
    ),
    'cancel_reasons', (
      select coalesce(jsonb_agg(jsonb_build_object('reason', rr.reason, 'count', rr.n)
        order by rr.n desc, rr.reason), '[]'::jsonb)
      from reason_rows rr
    ),
    'branches', case when cardinality(p_branch_ids) > 1 then (
      select coalesce(jsonb_agg(
        s.data || jsonb_build_object('branch_id', s.branch_id, 'name', b.name)
        order by b.name), '[]'::jsonb)
      from summaries s
      join branches b on b.id = s.branch_id
      where not s.is_total
    ) end
  )
  into v_result;

  return v_result;
end;
$$;

revoke execute on function branch_report(uuid[], date, date) from public, anon;
grant execute on function branch_report(uuid[], date, date) to authenticated;
