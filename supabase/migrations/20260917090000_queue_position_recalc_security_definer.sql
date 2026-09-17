-- Preflight finding: recalculate_positions()/trg_ticket_state_changed() (20260911211300) were
-- never declared SECURITY DEFINER, so their internal bulk UPDATE across an entire branch/barber
-- queue runs under RLS as whichever actor's action triggered them -- a customer cancelling their
-- own ticket, or a barber completing theirs, can only ever reposition rows their OWN narrow RLS
-- policy covers (their one ticket), silently leaving every other ticket in that queue stale. This
-- has almost certainly been true since Phase 1; it was never caught because every Phase 4 test
-- that exercised recalculation did so via a staff action (whose branch-scoped policy happens to
-- cover the whole queue) or checked only the single ticket a customer/barber can see. Matches the
-- exact SECURITY DEFINER pattern already used correctly by trg_barber_current_ticket,
-- bump_ticket_version, trg_feedback_updates_barber_rating, and trg_service_session_completed.
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
  from ranked where qt.id = ranked.id;
end;
$$;

create or replace function trg_ticket_state_changed() returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if new.state is distinct from old.state then
    perform recalculate_positions(new.branch_id, new.assigned_barber_id);
  end if;
  return new;
end;
$$;

-- PRD 12.3's Skip action: a ticket returns to Waiting without restarting the no-show escalation,
-- but shouldn't jump back to the front of the line ahead of customers who arrived after it was
-- skipped. skipped_at is null until a barber taps Skip; recalculate_positions above now orders by
-- it (treating "never skipped" as the earliest possible time, so unskipped tickets keep their
-- normal created_at-order), then by created_at as the tiebreaker/default. This is this app's only
-- form of "position staff can adjust" (PRD 12.3) -- automatic reordering, not manual dragging,
-- consistent with there being no manual-reorder control anywhere else in the app.
alter table queue_tickets add column skipped_at timestamptz;

create or replace function trg_ticket_state_changed_or_skip() returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if new.state is distinct from old.state or new.skipped_at is distinct from old.skipped_at then
    perform recalculate_positions(new.branch_id, new.assigned_barber_id);
  end if;
  return new;
end;
$$;

drop trigger if exists after_ticket_state_change on queue_tickets;
create trigger after_ticket_state_change_or_skip after update of state, skipped_at on queue_tickets
  for each row execute function trg_ticket_state_changed_or_skip();

revoke execute on function recalculate_positions(uuid, uuid) from public, anon, authenticated;
revoke execute on function trg_ticket_state_changed_or_skip() from public, anon, authenticated;
