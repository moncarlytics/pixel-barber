-- Final whole-branch review of the barber-assignment plan found two real gaps in
-- find_eligible_barber and one in recalculate_positions. All three are fixed here in one new
-- migration (the two already-applied migrations for these functions are left untouched).
--
-- find_eligible_barber fixes:
-- 1. preferred_scheduled_today only checked a barber_schedule row existed for today -- it never
--    checked the barber has the skill for the requested service, or that the shift hasn't
--    already ended. Both are now required, so "wait for this barber" is only ever offered for a
--    barber who can genuinely become eligible again later today.
-- 2. p_branch_service_id was never validated against p_branch_id -- a mismatch silently produced
--    a nonsense answer instead of correctly reporting no barbers available.
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
  select service_id into v_service_id
  from branch_services
  where id = p_branch_service_id and branch_id = p_branch_id;

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
      select 1
      from barber_schedule sch
      join barber_skills bsk on bsk.barber_id = sch.barber_id and bsk.service_id = v_service_id
      where sch.barber_id = p_preferred_barber_id
        and sch.work_date = current_date
        and sch.branch_id = p_branch_id
        and sch.shift_end > now()::time
    ),
    (select barber_id from ranked order by active_count asc, barber_id asc limit 1);
end;
$$;

revoke execute on function find_eligible_barber(uuid, uuid, uuid) from public, anon, authenticated;
grant execute on function find_eligible_barber(uuid, uuid, uuid) to authenticated, service_role;

-- recalculate_positions fix: a ticket promoted to 'called' by position never got called_at set
-- (only the manual staff Acknowledge action set it). Set it here too, for consistency and so
-- future wait-accuracy/no-show analytics has the real timestamp regardless of how a ticket
-- reached 'called'.
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
    select id, row_number() over (
      order by coalesce(skipped_at, '-infinity'::timestamptz), created_at
    ) as rn
    from queue_tickets
    where branch_id = p_branch_id
      and (
        (
          state in ('waiting','almost_turn')
          and (p_barber_id is null or assigned_barber_id = p_barber_id or (assigned_barber_id is null and is_pooled))
        )
        or (state = 'called' and p_barber_id is not null and assigned_barber_id = p_barber_id)
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
        end if;
      end if;
    end loop;
  end if;

  perform set_config('pixelbarber.recalc_in_progress', 'false', true);
end;
$$;
