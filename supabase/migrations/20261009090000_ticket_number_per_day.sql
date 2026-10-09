-- Ticket numbers are unique per branch per Ghana day, not across all time.
-- next_ticket_number() keeps a per-(branch, date) counter and formats PB-<branch code>-<n>, so the
-- counter restarts at 1 every day -- but queue_tickets.ticket_number was globally unique, so a
-- branch's second day of business tried to issue PB-<code>-1 again and every join failed with
-- 23505 until the count passed the previous day's. The short daily number customers see stays the
-- same; uniqueness moves to (branch, ticket day, number).

alter table queue_tickets add column if not exists ticket_date date;

update queue_tickets
  set ticket_date = (created_at at time zone 'Africa/Accra')::date
  where ticket_date is null;

-- The ticket's Ghana day, taken from created_at so back-dated rows (tests, imports) land on the
-- right day.
create or replace function set_ticket_date()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  new.ticket_date := (coalesce(new.created_at, now()) at time zone 'Africa/Accra')::date;
  return new;
end;
$$;

revoke execute on function set_ticket_date() from public, anon, authenticated;

drop trigger if exists trg_queue_tickets_ticket_date on queue_tickets;
create trigger trg_queue_tickets_ticket_date
  before insert or update of created_at on queue_tickets
  for each row execute function set_ticket_date();

alter table queue_tickets alter column ticket_date set not null;

alter table queue_tickets drop constraint if exists queue_tickets_ticket_number_key;

create unique index if not exists queue_tickets_branch_day_number
  on queue_tickets (branch_id, ticket_date, ticket_number);
