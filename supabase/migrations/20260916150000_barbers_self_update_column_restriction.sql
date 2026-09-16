-- Mirrors the exact pattern from 20260913150000/20260913160000: a column-level REVOKE cannot
-- diminish Supabase's default table-wide UPDATE grant to `authenticated`, so `barbers_self_update`
-- (20260911211400_rls_policies.sql:87-89, row-scoped only, no column restriction) has silently let
-- any barber overwrite their own average_rating, current_ticket_id, or home_branch_id since Phase 1
-- -- none of which that policy's own comment ("status, e.g. available/busy/on_break") ever intended.
-- Also removes current_ticket_id from human control entirely: it becomes trigger-maintained off
-- queue_tickets state transitions, matching how position/average_rating/barber_service_stats are
-- already trigger-maintained rather than client-writable, so the Barber Board (Task 7) can trust it.

revoke update on barbers from authenticated;
grant update (status, home_branch_id) on barbers to authenticated;
revoke update on barbers from anon;

-- current_ticket_id now follows the ticket, not the other way around: set when a ticket enters
-- in_service, cleared when it leaves in_service for any terminal or non-serving state.
create or replace function trg_barber_current_ticket() returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if new.state is distinct from old.state then
    if new.state = 'in_service' and new.assigned_barber_id is not null then
      update barbers set current_ticket_id = new.id where id = new.assigned_barber_id;
    elsif old.state = 'in_service' and old.assigned_barber_id is not null then
      update barbers set current_ticket_id = null
        where id = old.assigned_barber_id and current_ticket_id = new.id;
    end if;
  end if;
  return new;
end;
$$;

create trigger after_ticket_state_change_barber_current_ticket
  after update of state on queue_tickets
  for each row execute function trg_barber_current_ticket();
