-- Final Phase 5 review finding: recalculate_positions rewrote every ranked ticket unconditionally,
-- including ones whose position didn't actually change -- needless version bumps, Realtime noise,
-- and a narrow spurious-conflict window. Only write rows whose position genuinely changed.
create or replace function recalculate_positions(p_branch_id uuid, p_barber_id uuid) returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
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
end;
$$;

-- Final Phase 5 review finding: expire_no_show_grace_periods never incremented
-- customers.no_show_count -- the exact informational signal PRD 21/28 describe, and the natural
-- place to do it now that this function already touches the affected ticket's customer.
create or replace function expire_no_show_grace_periods() returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_ticket record;
begin
  for v_ticket in
    select id, customer_id from queue_tickets
    where state in ('called','grace_period') and grace_period_expires_at < now()
  loop
    update queue_tickets set state = 'no_show', no_show_at = now() where id = v_ticket.id;

    update customers set no_show_count = no_show_count + 1 where id = v_ticket.customer_id;

    insert into queue_events (ticket_id, event_type, actor_type, after_state)
      values (v_ticket.id, 'no_show', 'system', jsonb_build_object('state', 'no_show'));

    insert into notifications (recipient_type, recipient_id, channel, notification_type, related_ticket_id, payload)
      values ('customer', v_ticket.customer_id, 'sms', 'ticket_released', v_ticket.id, '{}'::jsonb);
  end loop;
end;
$$;
