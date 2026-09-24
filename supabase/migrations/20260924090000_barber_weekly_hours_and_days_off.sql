-- Barbers Management (Docs/superpowers/specs/2026-09-24-barbers-management-schedules-design.md).
-- A barber's regular week (barber_weekly_hours) and one-off days off (barber_days_off). Both are
-- materialized into the existing dated barber_schedule rows by fill_barber_schedule (next
-- migration), so find_eligible_barber keeps reading exactly what it reads today.

create table barber_weekly_hours (
  id           uuid primary key default gen_random_uuid(),
  barber_id    uuid not null references barbers(id) on delete cascade,
  day_of_week  smallint not null check (day_of_week between 0 and 6),
  branch_id    uuid not null references branches(id),
  shift_start  time not null,
  shift_end    time not null,
  check (shift_end > shift_start),
  unique (barber_id, day_of_week)
);

create table barber_days_off (
  barber_id  uuid not null references barbers(id) on delete cascade,
  off_date   date not null,
  primary key (barber_id, off_date)
);

-- true for rows a manager edited by hand; the refill never overwrites these.
alter table barber_schedule add column is_manual boolean not null default false;

-- RLS: scoped by the BARBER's home branch (same as barber_skills_staff_write), never by a
-- client-supplied column. The pattern's write check additionally requires the named work branch
-- to be in scope: fill_barber_schedule writes barber_schedule as definer, so without this a
-- manager could schedule a barber at a branch outside their own scope via the pattern.
alter table barber_weekly_hours enable row level security;
create policy barber_weekly_hours_staff_scoped on barber_weekly_hours for all
  using (
    has_capability('manage_barber_schedules')
    and in_branch_scope((select home_branch_id from barbers where id = barber_id))
  )
  with check (
    has_capability('manage_barber_schedules')
    and in_branch_scope((select home_branch_id from barbers where id = barber_id))
    and in_branch_scope(branch_id)
  );
create policy barber_weekly_hours_barber_own_read on barber_weekly_hours for select
  using (barber_id = (select id from barbers where staff_user_id = auth_staff_id()));

alter table barber_days_off enable row level security;
create policy barber_days_off_staff_scoped on barber_days_off for all
  using (
    has_capability('manage_barber_schedules')
    and in_branch_scope((select home_branch_id from barbers where id = barber_id))
  )
  with check (
    has_capability('manage_barber_schedules')
    and in_branch_scope((select home_branch_id from barbers where id = barber_id))
  );
create policy barber_days_off_barber_own_read on barber_days_off for select
  using (barber_id = (select id from barbers where staff_user_id = auth_staff_id()));

-- Barber names for the management screens. staff_users can't be widened for this: it has no
-- column-level read protection on pin_hash, so any broader select policy would also expose
-- barbers' PIN hashes. This returns only what the screens need, only for barbers the caller may
-- manage (Owner: all; Branch Manager: their branches' home barbers).
create or replace function list_manageable_barbers()
returns table (
  barber_id uuid,
  staff_user_id uuid,
  name text,
  status barber_status,
  home_branch_id uuid,
  home_branch_name text
)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select b.id, b.staff_user_id, su.name, b.status, b.home_branch_id, br.name
  from barbers b
  join staff_users su on su.id = b.staff_user_id
  join branches br on br.id = b.home_branch_id
  where has_capability('manage_barber_schedules')
    and in_branch_scope(b.home_branch_id)
  order by su.name;
$$;

revoke execute on function list_manageable_barbers() from public, anon;
grant execute on function list_manageable_barbers() to authenticated, service_role;
