-- Backend schema doc section 15.1, 15.2, 15.4 (15.3's pg_cron jobs are their own migration).

-- Every function below that writes rows the calling user doesn't themselves own (recalculating
-- another customer's ticket position, incrementing a shared counter, rolling up stats) is marked
-- security definer so RLS on the underlying tables can't silently turn its writes into no-ops —
-- these are system-maintained derived data, not writes a client should need its own grant for.

-- 15.1 Ticket number generation
create or replace function next_ticket_number(p_branch_id uuid) returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_code text;
  v_seq  integer;
begin
  select branch_code into v_code from branches where id = p_branch_id;

  insert into branch_ticket_counters (branch_id, ticket_date, last_seq)
    values (p_branch_id, current_date, 1)
  on conflict (branch_id, ticket_date)
    do update set last_seq = branch_ticket_counters.last_seq + 1
  returning last_seq into v_seq;

  return format('PB-%s-%s', v_code, v_seq);
end;
$$;

-- 15.2 Queue position
create or replace function recalculate_positions(p_branch_id uuid, p_barber_id uuid) returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  with ranked as (
    select id, row_number() over (order by created_at) as rn
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
set search_path = public
as $$
begin
  if new.state is distinct from old.state then
    perform recalculate_positions(new.branch_id, new.assigned_barber_id);
  end if;
  return new;
end;
$$;

create trigger after_ticket_state_change after update of state on queue_tickets
  for each row execute function trg_ticket_state_changed();

-- 15.4 barber_service_stats and barbers.average_rating rollups
create or replace function trg_service_session_completed() returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_service_id uuid;
begin
  if new.ended_at is not null and old.ended_at is null then
    select service_id into v_service_id from branch_services bs
      join queue_tickets qt on qt.branch_service_id = bs.id
      where qt.id = new.ticket_id;

    insert into barber_service_stats (barber_id, service_id, completed_count, avg_duration_seconds)
      values (new.barber_id, v_service_id, 1, new.actual_duration_seconds)
    on conflict (barber_id, service_id) do update set
      avg_duration_seconds = (
        (barber_service_stats.avg_duration_seconds * barber_service_stats.completed_count + new.actual_duration_seconds)
        / (barber_service_stats.completed_count + 1)
      ),
      completed_count = barber_service_stats.completed_count + 1,
      updated_at = now();
  end if;
  return new;
end;
$$;

create trigger after_service_session_update after update on service_sessions
  for each row execute function trg_service_session_completed();

create or replace function trg_feedback_updates_barber_rating() returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  update barbers set average_rating = (
    select avg(overall_rating)::numeric(3,2) from feedback where barber_id = new.barber_id
  )
  where id = new.barber_id;
  return new;
end;
$$;

create trigger after_feedback_insert after insert on feedback
  for each row execute function trg_feedback_updates_barber_rating();

-- last_activity_at bump (section 18): keeps the 3-year retention clock tied to real activity.
create or replace function bump_customer_last_activity() returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  update customers set last_activity_at = now() where id = new.customer_id;
  return new;
end;
$$;

create trigger after_ticket_insert_bump_activity after insert on queue_tickets
  for each row execute function bump_customer_last_activity();

create trigger after_appointment_insert_bump_activity after insert on appointments
  for each row execute function bump_customer_last_activity();
