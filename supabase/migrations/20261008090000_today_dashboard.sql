-- Today dashboard (Docs/superpowers/specs/2026-10-08-reports-dashboard-design.md, Section 1): a
-- per-branch snapshot of right now and so far today (Ghana date), today's ratings for report
-- viewers, and a long-wait warning with a per-branch limit.

insert into capabilities (key, description) values
  ('view_branch_dashboard', 'View the branch Today dashboard')
on conflict do nothing;

insert into role_capabilities (role, capability) values
  ('owner', 'view_branch_dashboard'),
  ('branch_manager', 'view_branch_dashboard'),
  ('receptionist', 'view_branch_dashboard'),
  ('analyst', 'view_branch_dashboard')
on conflict do nothing;

alter table branches
  add column if not exists long_wait_warning_minutes smallint not null default 20
    constraint branches_long_wait_warning_minutes_range
      check (long_wait_warning_minutes between 5 and 180);

create index if not exists idx_queue_tickets_branch_created on queue_tickets (branch_id, created_at);

-- branches' RLS only lets manage_branches (owner) update rows; the long-wait limit belongs with
-- the other day-to-day settings branch managers may change (edit_hours).
create or replace function set_long_wait_warning(p_branch_id uuid, p_minutes integer)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if not (has_capability('edit_hours') and in_branch_scope(p_branch_id)) then
    raise exception 'not_allowed';
  end if;
  if p_minutes is null or p_minutes < 5 or p_minutes > 180 then
    raise exception 'invalid_minutes';
  end if;
  update branches set long_wait_warning_minutes = p_minutes where id = p_branch_id;
  if not found then
    raise exception 'not_found';
  end if;
end;
$$;

revoke execute on function set_long_wait_warning(uuid, integer) from public, anon;
grant execute on function set_long_wait_warning(uuid, integer) to authenticated;

create or replace function branch_today(p_branch_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_today date := (now() at time zone 'Africa/Accra')::date;
  v_start timestamptz := v_today::timestamp at time zone 'Africa/Accra';
  v_end timestamptz := (v_today + 1)::timestamp at time zone 'Africa/Accra';
  v_threshold smallint;
  v_now jsonb;
  v_current integer;
  v_day jsonb;
  v_ratings jsonb := null;
begin
  if not (has_capability('view_branch_dashboard') and in_branch_scope(p_branch_id)) then
    raise exception 'not_allowed';
  end if;
  select long_wait_warning_minutes into v_threshold from branches where id = p_branch_id;
  if v_threshold is null then
    raise exception 'not_found';
  end if;

  select
    jsonb_build_object(
      'waiting', count(*) filter (where t.state in ('created', 'waiting', 'almost_turn')),
      'called', count(*) filter (where t.state in ('called', 'confirmed', 'grace_period')),
      'in_service', count(*) filter (where t.state = 'in_service')
    ),
    round(avg(extract(epoch from now() - t.created_at) / 60) filter (
      where t.state in ('created', 'waiting', 'almost_turn', 'called', 'confirmed', 'grace_period')
    ))::int
  into v_now, v_current
  from queue_tickets t
  where t.branch_id = p_branch_id and t.state not in ('completed', 'no_show', 'cancelled');

  v_now := v_now || jsonb_build_object(
    'appointments_to_come', (
      select count(*) from appointments a
      where a.branch_id = p_branch_id
        and a.status in ('scheduled', 'checked_in')
        and a.scheduled_start >= v_start and a.scheduled_start < v_end
    ),
    'barbers_available', (
      select count(*) from barbers b join staff_users su on su.id = b.staff_user_id
      where b.home_branch_id = p_branch_id and su.is_active and b.status = 'available'
    ),
    'barbers_busy', (
      select count(*) from barbers b join staff_users su on su.id = b.staff_user_id
      where b.home_branch_id = p_branch_id and su.is_active and b.status = 'busy'
    )
  );

  select jsonb_build_object(
    'served', count(*) filter (where t.state = 'completed'),
    'walk_ins', count(*) filter (where t.state = 'completed' and t.appointment_id is null),
    'appointments', count(*) filter (where t.state = 'completed' and t.appointment_id is not null),
    'no_shows', count(*) filter (where t.state = 'no_show'),
    'cancellations', count(*) filter (where t.state = 'cancelled'),
    'avg_wait_min', round(avg(extract(epoch from t.service_started_at - t.created_at) / 60) filter (
      where t.state = 'completed' and t.service_started_at is not null
    ))::int,
    'avg_service_min', round(avg(extract(epoch from t.completed_at - t.service_started_at) / 60) filter (
      where t.state = 'completed' and t.service_started_at is not null and t.completed_at is not null
    ))::int
  )
  into v_day
  from queue_tickets t
  where t.branch_id = p_branch_id and t.created_at >= v_start and t.created_at < v_end;

  if has_capability('view_branch_reports') then
    select jsonb_build_object('count', count(f.id), 'average', round(avg(f.overall_rating), 2))
    into v_ratings
    from feedback f
    join queue_tickets t on t.id = f.ticket_id
    where t.branch_id = p_branch_id and t.created_at >= v_start and t.created_at < v_end;
  end if;

  return jsonb_build_object(
    'now', v_now,
    'today', v_day,
    'ratings', v_ratings,
    'long_wait', jsonb_build_object(
      'threshold_min', v_threshold,
      'current_avg_wait_min', v_current,
      'alert', coalesce(v_current > v_threshold, false)
    ),
    'updated_at', now()
  );
end;
$$;

revoke execute on function branch_today(uuid) from public, anon;
grant execute on function branch_today(uuid) to authenticated;
