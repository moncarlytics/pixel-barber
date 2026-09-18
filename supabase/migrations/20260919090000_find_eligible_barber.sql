-- Barber Assignment & Queue Progression design (Docs/superpowers/specs/2026-09-18-barber-
-- assignment-queue-progression-design.md), decisions 3-4. Single source of truth for "which
-- barber does this customer get" -- called as a pre-check from the client (BookFlow, the walk-in
-- modal) and again inside createTicketAtomic at insert time (Task 2), so the actual assignment
-- always re-derives fresh rather than trusting the earlier pre-check's answer.
create or replace function find_eligible_barber(
  p_branch_id uuid,
  p_branch_service_id uuid,
  p_preferred_barber_id uuid default null
)
returns table (
  preferred_eligible boolean,
  preferred_scheduled_today boolean,
  fallback_barber_id uuid
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_service_id uuid;
begin
  select service_id into v_service_id from branch_services where id = p_branch_service_id;

  return query
  with eligible as (
    select b.id as barber_id
    from barbers b
    join barber_skills bs on bs.barber_id = b.id and bs.service_id = v_service_id
    join barber_schedule sch on sch.barber_id = b.id
      and sch.work_date = current_date
      and sch.branch_id = p_branch_id
      and now()::time between sch.shift_start and sch.shift_end
    where b.status not in ('offline', 'end_of_shift', 'temporarily_unavailable')
  ),
  ranked as (
    select
      e.barber_id,
      (
        select count(*) from queue_tickets qt
        where qt.assigned_barber_id = e.barber_id
          and qt.branch_id = p_branch_id
          and qt.state in ('waiting', 'almost_turn', 'called', 'confirmed', 'in_service')
      ) as active_count
    from eligible e
  )
  select
    exists (select 1 from eligible where barber_id = p_preferred_barber_id),
    exists (
      select 1 from barber_schedule
      where barber_id = p_preferred_barber_id
        and work_date = current_date
        and branch_id = p_branch_id
    ),
    (select barber_id from ranked order by active_count asc, barber_id asc limit 1);
end;
$$;

grant execute on function find_eligible_barber(uuid, uuid, uuid) to authenticated;
