-- Barbers Management: materialize barber_weekly_hours into dated barber_schedule rows for
-- current_date .. current_date + 27. find_eligible_barber is untouched -- it keeps reading the
-- dated rows exactly as before.
--
-- Rules, per barber, per date in the window:
--   1. date is a day off            -> delete any row for that date (hand-edited or not)
--   2. row exists and is_manual      -> leave it
--   3. pattern has that weekday      -> upsert the row from the pattern (is_manual = false)
--   4. pattern says day off          -> delete any non-manual row for that date
-- Dates before current_date are never touched.
--
-- The no-argument (nightly) call only processes barbers who have a pattern, so barbers with no
-- pattern -- every pre-existing fixture, and any row created before this feature -- keep their
-- dated rows. An explicit p_barber_id (trigger/reset) always processes that barber, so removing a
-- barber's whole week still clears their future days.
create or replace function fill_barber_schedule(p_barber_id uuid default null) returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_barber_id uuid;
  v_date date;
  v_pattern record;
begin
  for v_barber_id in
    select b.id
    from barbers b
    join staff_users su on su.id = b.staff_user_id
    where su.is_active
      and (
        (p_barber_id is not null and b.id = p_barber_id)
        or (
          p_barber_id is null
          and exists (select 1 from barber_weekly_hours w where w.barber_id = b.id)
        )
      )
  loop
    for v_date in
      select d::date from generate_series(current_date, current_date + 27, interval '1 day') as d
    loop
      if exists (
        select 1 from barber_days_off where barber_id = v_barber_id and off_date = v_date
      ) then
        delete from barber_schedule where barber_id = v_barber_id and work_date = v_date;
      elsif exists (
        select 1 from barber_schedule
        where barber_id = v_barber_id and work_date = v_date and is_manual
      ) then
        null;
      else
        select * into v_pattern
        from barber_weekly_hours
        where barber_id = v_barber_id and day_of_week = extract(dow from v_date)::smallint;

        if found then
          insert into barber_schedule (barber_id, work_date, branch_id, shift_start, shift_end, is_manual)
          values (v_barber_id, v_date, v_pattern.branch_id, v_pattern.shift_start, v_pattern.shift_end, false)
          on conflict (barber_id, work_date) do update
            set branch_id = excluded.branch_id,
                shift_start = excluded.shift_start,
                shift_end = excluded.shift_end
            where barber_schedule.is_manual = false
              and (barber_schedule.branch_id, barber_schedule.shift_start, barber_schedule.shift_end)
                  is distinct from (excluded.branch_id, excluded.shift_start, excluded.shift_end);
        else
          delete from barber_schedule
          where barber_id = v_barber_id and work_date = v_date and not is_manual;
        end if;
      end if;
    end loop;
  end loop;
end;
$$;

revoke execute on function fill_barber_schedule(uuid) from public, anon, authenticated;
grant execute on function fill_barber_schedule(uuid) to service_role;

-- Refill a barber whenever their pattern or days off change. SECURITY DEFINER because the
-- invoking manager has no EXECUTE on fill_barber_schedule. Branches on TG_OP rather than reading
-- NEW in a DELETE (NEW is null there).
create or replace function trg_refill_barber_schedule() returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if tg_op = 'DELETE' then
    perform fill_barber_schedule(old.barber_id);
  else
    perform fill_barber_schedule(new.barber_id);
    if tg_op = 'UPDATE' and old.barber_id is distinct from new.barber_id then
      perform fill_barber_schedule(old.barber_id);
    end if;
  end if;
  return null;
end;
$$;

create trigger after_barber_weekly_hours_change
  after insert or update or delete on barber_weekly_hours
  for each row execute function trg_refill_barber_schedule();

create trigger after_barber_days_off_change
  after insert or delete on barber_days_off
  for each row execute function trg_refill_barber_schedule();

-- The one client-callable way to restore a single date to the pattern. Checks the caller may
-- manage this barber (same capability + home-branch scope as the tables' RLS), refuses dates
-- outside the window, then clears that date's day off and dated row and refills.
create or replace function reset_barber_schedule_day(p_barber_id uuid, p_date date) returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_home_branch_id uuid;
begin
  select home_branch_id into v_home_branch_id from barbers where id = p_barber_id;
  if v_home_branch_id is null then
    raise exception 'Barber not found' using errcode = 'P0002';
  end if;
  if not (has_capability('manage_barber_schedules') and in_branch_scope(v_home_branch_id)) then
    raise exception 'Not allowed to manage this barber' using errcode = '42501';
  end if;
  if p_date < current_date or p_date > current_date + 27 then
    raise exception 'Date is outside the schedulable window' using errcode = '22023';
  end if;

  delete from barber_days_off where barber_id = p_barber_id and off_date = p_date;
  delete from barber_schedule where barber_id = p_barber_id and work_date = p_date;
  perform fill_barber_schedule(p_barber_id);
end;
$$;

revoke execute on function reset_barber_schedule_day(uuid, date) from public, anon;
grant execute on function reset_barber_schedule_day(uuid, date) to authenticated, service_role;

-- Nightly: extend every patterned barber's window by one day (and repair anything missed).
select cron.schedule(
  'fill-barber-schedules',
  '5 0 * * *',
  $$ select fill_barber_schedule(); $$
);
