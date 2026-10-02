-- Appointments part 3, Section 3 (Docs/superpowers/specs/2026-10-02-appointments-reminders-checkin-wait-design.md):
-- real wait estimates on waiting tickets, counting appointments that will be served first.

-- Estimate refreshes run every minute and are not a change a customer's versioned write could
-- conflict with, so an update touching only the estimate (and updated_at) keeps the version.
create or replace function bump_ticket_version() returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if (to_jsonb(new) - array['estimated_wait_low_min', 'estimated_wait_high_min', 'updated_at', 'version'])
     = (to_jsonb(old) - array['estimated_wait_low_min', 'estimated_wait_high_min', 'updated_at', 'version']) then
    return new;
  end if;
  new.version := old.version + 1;
  return new;
end;
$$;

-- Expected minutes for one barber doing one branch service: their own average once they have 5
-- completed services of it (historical), otherwise the service's set length.
create or replace function expected_duration_min(p_barber_id uuid, p_branch_service_id uuid)
returns table (minutes int, historical boolean)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select
    case
      when st.completed_count >= 5 and st.avg_duration_seconds is not null
        then round(st.avg_duration_seconds / 60.0)::int
      else coalesce(bs.duration_minutes_override, s.default_duration_minutes)::int
    end,
    coalesce(st.completed_count >= 5 and st.avg_duration_seconds is not null, false)
  from branch_services bs
  join services s on s.id = bs.service_id
  left join barber_service_stats st on st.barber_id = p_barber_id and st.service_id = bs.service_id
  where bs.id = p_branch_service_id;
$$;

revoke execute on function expected_duration_min(uuid, uuid) from public, anon, authenticated;

-- One barber's line, in order: a row per waiting ticket with its estimate, then one row with a null
-- ticket_id -- the estimate for a newcomer joining the end of the line.
create or replace function wait_walk(p_branch_id uuid, p_barber_id uuid)
returns table (ticket_id uuid, low_min int, high_min int)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
#variable_conflict use_column
declare
  v_t numeric := 0;            -- minutes from now until the chair is free for the next person
  v_guess boolean := false;    -- whether any set-length (non-historical) duration was counted
  v_dur record;
  v_tk record;
  v_appt record;
  v_counted uuid[] := '{}';
  v_share bigint;
begin
  -- The chair: what is left of the haircut in progress, plus anyone already called.
  for v_tk in
    select qt.state, qt.branch_service_id, ss.started_at
    from queue_tickets qt
    left join service_sessions ss on ss.ticket_id = qt.id
    where qt.branch_id = p_branch_id
      and qt.assigned_barber_id = p_barber_id
      and qt.state in ('called', 'confirmed', 'grace_period', 'in_service')
  loop
    select * into v_dur from expected_duration_min(p_barber_id, v_tk.branch_service_id);
    if v_tk.state = 'in_service' and v_tk.started_at is not null then
      v_t := v_t + greatest(0, v_dur.minutes - extract(epoch from (now() - v_tk.started_at)) / 60.0);
    else
      v_t := v_t + v_dur.minutes;
    end if;
    v_guess := v_guess or not v_dur.historical;
  end loop;

  for v_tk in
    select w.id, w.branch_service_id
    from (
      select qt.id, qt.branch_service_id, coalesce(qt.position, 2147483646) as ord, qt.created_at
      from queue_tickets qt
      where qt.branch_id = p_branch_id
        and qt.assigned_barber_id = p_barber_id
        and qt.state in ('waiting', 'almost_turn')
      union all
      select null::uuid, null::uuid, 2147483647, null::timestamptz
    ) w
    order by w.ord, w.created_at
  loop
    -- Appointments whose slot arrives before this person's turn are served first.
    loop
      select a.id, a.branch_service_id, a.preferred_barber_id, a.scheduled_start
        into v_appt
      from appointments a
      join branch_services abs_ on abs_.id = a.branch_service_id
      where a.branch_id = p_branch_id
        and a.status in ('scheduled', 'checked_in')
        and a.scheduled_start <= now() + make_interval(secs => (v_t * 60)::double precision)
        and not (a.id = any (v_counted))
        and (
          a.preferred_barber_id = p_barber_id
          or (
            a.preferred_barber_id is null
            and exists (
              select 1 from barber_skills sk
              where sk.barber_id = p_barber_id and sk.service_id = abs_.service_id
            )
          )
        )
      order by a.scheduled_start, a.id
      limit 1;
      exit when not found;

      select * into v_dur from expected_duration_min(p_barber_id, v_appt.branch_service_id);
      if v_appt.preferred_barber_id is null then
        -- "Any barber": shared across the skilled barbers on shift at the slot time.
        select greatest(1, count(*)) into v_share
        from barber_schedule sch
        join barber_skills sk on sk.barber_id = sch.barber_id
        join branch_services bs on bs.id = v_appt.branch_service_id and bs.service_id = sk.service_id
        where sch.branch_id = p_branch_id
          and sch.work_date = (v_appt.scheduled_start at time zone 'UTC')::date
          and (v_appt.scheduled_start at time zone 'UTC')::time between sch.shift_start and sch.shift_end;
        v_t := v_t + v_dur.minutes::numeric / v_share;
      else
        v_t := v_t + v_dur.minutes;
      end if;
      v_guess := v_guess or not v_dur.historical;
      v_counted := v_counted || v_appt.id;
    end loop;

    ticket_id := v_tk.id;
    if v_guess then
      low_min := round(v_t * 0.8);
      high_min := round(v_t * 1.2);
    else
      low_min := round(v_t);
      high_min := low_min;
    end if;
    return next;

    if v_tk.id is not null then
      select * into v_dur from expected_duration_min(p_barber_id, v_tk.branch_service_id);
      v_t := v_t + v_dur.minutes;
      v_guess := v_guess or not v_dur.historical;
    end if;
  end loop;
end;
$$;

revoke execute on function wait_walk(uuid, uuid) from public, anon, authenticated;

-- Writes estimates for one barber's waiting tickets, touching only rows whose numbers changed, and
-- clears any estimate left on that barber's tickets that are no longer waiting.
create or replace function refresh_wait_estimates(p_branch_id uuid, p_barber_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  update queue_tickets qt
    set estimated_wait_low_min = w.low_min,
        estimated_wait_high_min = w.high_min
  from wait_walk(p_branch_id, p_barber_id) w
  where w.ticket_id = qt.id
    and (qt.estimated_wait_low_min is distinct from w.low_min
         or qt.estimated_wait_high_min is distinct from w.high_min);

  update queue_tickets
    set estimated_wait_low_min = null,
        estimated_wait_high_min = null
  where branch_id = p_branch_id
    and assigned_barber_id = p_barber_id
    and state not in ('waiting', 'almost_turn')
    and (estimated_wait_low_min is not null or estimated_wait_high_min is not null);
end;
$$;

revoke execute on function refresh_wait_estimates(uuid, uuid) from public, anon, authenticated;
grant execute on function refresh_wait_estimates(uuid, uuid) to service_role;

-- Every barber line with someone waiting (run every minute: time passing changes estimates).
create or replace function refresh_all_wait_estimates()
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  r record;
begin
  for r in
    select distinct branch_id, assigned_barber_id
    from queue_tickets
    where state in ('waiting', 'almost_turn') and assigned_barber_id is not null
  loop
    perform refresh_wait_estimates(r.branch_id, r.assigned_barber_id);
  end loop;
end;
$$;

revoke execute on function refresh_all_wait_estimates() from public, anon, authenticated;
grant execute on function refresh_all_wait_estimates() to service_role;

-- Join Now preview: the wait a newcomer would get at the end of a barber's line. A null barber
-- means the next available one (find_eligible_barber's fallback). No row when nobody can serve.
create or replace function preview_wait_estimate(p_branch_service_id uuid, p_barber_id uuid)
returns table (low_min int, high_min int)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
#variable_conflict use_column
declare
  v_branch uuid;
  v_barber uuid := p_barber_id;
begin
  select branch_id into v_branch from branch_services where id = p_branch_service_id;
  if v_branch is null then
    return;
  end if;
  if v_barber is null then
    select fallback_barber_id into v_barber
    from find_eligible_barber(v_branch, p_branch_service_id, null);
  end if;
  if v_barber is null then
    return;
  end if;
  return query
    select w.low_min, w.high_min from wait_walk(v_branch, v_barber) w where w.ticket_id is null;
end;
$$;

revoke execute on function preview_wait_estimate(uuid, uuid) from public, anon;
grant execute on function preview_wait_estimate(uuid, uuid) to authenticated;

-- recalculate_positions: identical to 20261001090300_appointment_conversion.sql's definition except
-- it refreshes the barber's wait estimates at the end. create or replace keeps its grants.
create or replace function recalculate_positions(p_branch_id uuid, p_barber_id uuid) returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_reentrant boolean;
  v_ticket record;
  v_new_state ticket_state;
begin
  v_reentrant := coalesce(current_setting('pixelbarber.recalc_in_progress', true), 'false') = 'true';
  if v_reentrant then
    return;
  end if;
  perform set_config('pixelbarber.recalc_in_progress', 'true', true);

  with ranked as (
    select qt.id, row_number() over (
      order by
        case
          when qt.state = 'called' then 0
          when qt.appointment_id is not null and qt.skipped_at is null then 1
          else 2
        end,
        case when qt.skipped_at is null then a.scheduled_start end nulls last,
        coalesce(qt.skipped_at, '-infinity'::timestamptz),
        qt.created_at
    ) as rn
    from queue_tickets qt
    left join appointments a on a.id = qt.appointment_id
    where qt.branch_id = p_branch_id
      and (
        (
          qt.state in ('waiting','almost_turn')
          and (p_barber_id is null or qt.assigned_barber_id = p_barber_id or (qt.assigned_barber_id is null and qt.is_pooled))
        )
        or (qt.state = 'called' and p_barber_id is not null and qt.assigned_barber_id = p_barber_id)
      )
  )
  update queue_tickets qt set position = ranked.rn
  from ranked
  where qt.id = ranked.id
    and qt.position is distinct from ranked.rn;

  if p_barber_id is not null then
    for v_ticket in
      select id, customer_id, state, position
      from queue_tickets
      where branch_id = p_branch_id
        and assigned_barber_id = p_barber_id
        and state in ('waiting','almost_turn','called')
        and position is not null
    loop
      v_new_state := case
        when v_ticket.position = 1 then 'called'
        when v_ticket.position = 2 then 'almost_turn'
        else 'waiting'
      end;
      if v_new_state is distinct from v_ticket.state then
        update queue_tickets
          set state = v_new_state,
              called_at = case when v_new_state = 'called' then now() else called_at end
          where id = v_ticket.id;
        if v_new_state = 'called' then
          insert into notifications (recipient_type, recipient_id, channel, notification_type, related_ticket_id, payload)
            values ('customer', v_ticket.customer_id, 'sms', 'your_turn', v_ticket.id, '{}'::jsonb);
        elsif v_new_state = 'almost_turn' then
          insert into notifications (recipient_type, recipient_id, channel, notification_type, related_ticket_id, payload)
            values ('customer', v_ticket.customer_id, 'sms', 'youre_next', v_ticket.id, '{}'::jsonb)
            on conflict (related_ticket_id) where notification_type = 'youre_next' do nothing;
        end if;
      end if;
    end loop;

    perform refresh_wait_estimates(p_branch_id, p_barber_id);
  end if;

  perform set_config('pixelbarber.recalc_in_progress', 'false', true);
end;
$$;
