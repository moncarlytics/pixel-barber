-- Barber Assignment & Queue Progression design, decisions 6-7. Extends the existing
-- recalculate_positions (already fired by after_ticket_state_change on every state change) to
-- also derive called/almost_turn/waiting from a ticket's position and notify on first entry into
-- called.
--
-- Reentrancy guard: the state-derivation loop below writes queue_tickets.state, which re-fires
-- after_ticket_state_change (`after update of state`), which calls this same function again
-- before the original call's loop finishes. Without a guard, that recursive call would re-derive
-- and re-write the same transitions and insert a second 'your_turn' notification for the same
-- ticket. A transaction-local custom setting makes the recursive re-entry a no-op; the outermost
-- call is always the one that finishes the derivation.
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
      and state in ('waiting','almost_turn')
      and (p_barber_id is null or assigned_barber_id = p_barber_id or (assigned_barber_id is null and is_pooled))
  )
  update queue_tickets qt set position = ranked.rn
  from ranked
  where qt.id = ranked.id
    and qt.position is distinct from ranked.rn;

  if p_barber_id is not null then
    for v_ticket in
      select id, customer_id, state, position
      from queue_tickets
      where assigned_barber_id = p_barber_id
        and state in ('waiting','almost_turn','called')
    loop
      v_new_state := case
        when v_ticket.position = 1 then 'called'
        when v_ticket.position = 2 then 'almost_turn'
        else 'waiting'
      end;
      if v_new_state is distinct from v_ticket.state then
        update queue_tickets set state = v_new_state where id = v_ticket.id;
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
