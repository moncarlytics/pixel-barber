-- Fix for 20260916150000's trg_barber_current_ticket(): the original only fired on `state`
-- changes, missing the case where a ticket already in_service gets reassigned to a different
-- barber (assigned_barber_id changes) without state itself changing -- staff can do exactly this
-- via tickets_staff_branch_scope RLS. Widened to fire on either column, and the function body now
-- checks whether EITHER changed, not just state, before deciding to set/clear current_ticket_id.

create or replace function trg_barber_current_ticket() returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if new.state = 'in_service' and new.assigned_barber_id is not null
     and (old.state is distinct from new.state or old.assigned_barber_id is distinct from new.assigned_barber_id) then
    update barbers set current_ticket_id = new.id where id = new.assigned_barber_id;
  end if;

  if old.state = 'in_service' and old.assigned_barber_id is not null
     and (new.state is distinct from old.state or new.assigned_barber_id is distinct from old.assigned_barber_id) then
    update barbers set current_ticket_id = null
      where id = old.assigned_barber_id and current_ticket_id = new.id;
  end if;

  return new;
end;
$$;

drop trigger if exists after_ticket_state_change_barber_current_ticket on queue_tickets;
create trigger after_ticket_state_change_barber_current_ticket
  after update of state, assigned_barber_id on queue_tickets
  for each row execute function trg_barber_current_ticket();
