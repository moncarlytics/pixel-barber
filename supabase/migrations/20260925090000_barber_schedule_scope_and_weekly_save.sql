-- Final-review fix wave for Barbers Management (2026-09-24-barbers-management-schedules).
-- Two Important findings fixed here; both already-applied migrations they touch are left as-is.

-- ---------------------------------------------------------------------------
-- Finding 1: barber_schedule_staff_scoped scoped writes only by the row's own branch_id, so a
-- Branch Manager could insert {barber_id: <another branch's barber>, branch_id: <their own
-- branch>, is_manual: true} -- a manual row the nightly refill never removes, and the barber's
-- actual home-branch manager can't even see (their read was also scoped by branch_id only).
-- Split into a read policy scoped by EITHER the barber's home branch or the row's branch (so the
-- home manager can always see hand-edited rows placed elsewhere), and per-command write policies
-- that require BOTH the caller be in scope of the barber's home branch AND of the named work
-- branch -- the same two-sided check barber_weekly_hours already uses.
-- ---------------------------------------------------------------------------

drop policy barber_schedule_staff_scoped on barber_schedule;

create policy barber_schedule_staff_read on barber_schedule for select
  using (
    has_capability('manage_barber_schedules')
    and (
      in_branch_scope((select home_branch_id from barbers where id = barber_id))
      or in_branch_scope(branch_id)
    )
  );

create policy barber_schedule_staff_insert on barber_schedule for insert
  with check (
    has_capability('manage_barber_schedules')
    and in_branch_scope((select home_branch_id from barbers where id = barber_id))
    and in_branch_scope(branch_id)
  );

create policy barber_schedule_staff_update on barber_schedule for update
  using (
    has_capability('manage_barber_schedules')
    and in_branch_scope((select home_branch_id from barbers where id = barber_id))
    and in_branch_scope(branch_id)
  )
  with check (
    has_capability('manage_barber_schedules')
    and in_branch_scope((select home_branch_id from barbers where id = barber_id))
    and in_branch_scope(branch_id)
  );

create policy barber_schedule_staff_delete on barber_schedule for delete
  using (
    has_capability('manage_barber_schedules')
    and in_branch_scope((select home_branch_id from barbers where id = barber_id))
    and in_branch_scope(branch_id)
  );

-- barber_schedule_barber_own_read is untouched.

-- ---------------------------------------------------------------------------
-- Finding 2: RegularWeek.tsx's save deleted off days and upserted working days as two separate
-- requests -- a failed upsert left the deletes committed (DB/UI divergence), and any working day
-- naming a branch outside the caller's scope made the WITH CHECK on barber_weekly_hours reject
-- the whole upsert, on every retry, forever. One RPC call is one transaction: any failure (RLS,
-- the end>start check constraint) rolls back every day in the batch, not just the one that failed.
-- SECURITY INVOKER (the default) so RLS on barber_weekly_hours still applies exactly as if the
-- caller had written the table directly -- this function grants no privilege the caller doesn't
-- already have via that table's own policies.
-- ---------------------------------------------------------------------------

create or replace function set_barber_weekly_hours(p_barber_id uuid, p_days jsonb) returns void
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  v_day jsonb;
begin
  for v_day in select * from jsonb_array_elements(p_days)
  loop
    if (v_day->>'working')::boolean is false then
      delete from barber_weekly_hours
      where barber_id = p_barber_id
        and day_of_week = (v_day->>'day_of_week')::smallint;
    else
      insert into barber_weekly_hours (barber_id, day_of_week, branch_id, shift_start, shift_end)
      values (
        p_barber_id,
        (v_day->>'day_of_week')::smallint,
        (v_day->>'branch_id')::uuid,
        (v_day->>'shift_start')::time,
        (v_day->>'shift_end')::time
      )
      on conflict (barber_id, day_of_week) do update
        set branch_id = excluded.branch_id,
            shift_start = excluded.shift_start,
            shift_end = excluded.shift_end;
    end if;
  end loop;
end;
$$;

revoke execute on function set_barber_weekly_hours(uuid, jsonb) from public, anon;
grant execute on function set_barber_weekly_hours(uuid, jsonb) to authenticated, service_role;
