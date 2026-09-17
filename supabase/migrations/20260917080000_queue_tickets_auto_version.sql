-- Final Phase 4 review finding: queue_tickets.version was only ever incremented by
-- updateTicketWithVersion() in application code (packages/shared/src/ticket-updates.ts). The
-- expire-no-show-grace-periods cron job (20260911211600_pg_cron_jobs.sql), running every 30
-- seconds since Phase 1, updates queue_tickets directly and never touches version -- so a customer
-- holding a stale version could still successfully overwrite a cron-driven no_show transition,
-- exactly the "silently overwritten" outcome PRD 34 exists to forbid. Moving the bump into the
-- database makes it authoritative for every writer, not just the ones that go through the helper.
create or replace function bump_ticket_version() returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  new.version := old.version + 1;
  return new;
end;
$$;

create trigger trg_queue_tickets_bump_version before update on queue_tickets
  for each row execute function bump_ticket_version();
