-- backend-schema 15.3's own note: "An actual production version of the first job also needs to
-- write the resulting queue_events row and enqueue the 'your ticket was released' notification for
-- each affected ticket... wrap both jobs' bodies in a single plpgsql function per job... once that
-- additional work is added." This is that real version, for the no-show job specifically (the
-- appointment-activation job is Phase 6's concern, untouched here).
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

    insert into queue_events (ticket_id, event_type, actor_type, after_state)
      values (v_ticket.id, 'no_show', 'system', jsonb_build_object('state', 'no_show'));

    insert into notifications (recipient_type, recipient_id, channel, notification_type, related_ticket_id, payload)
      values ('customer', v_ticket.customer_id, 'sms', 'ticket_released', v_ticket.id, '{}'::jsonb);
  end loop;
end;
$$;

revoke execute on function expire_no_show_grace_periods() from public, anon, authenticated;

-- Controller fix: 'every 30 seconds' is not valid cron.schedule syntax and made the push fail
-- outright (rolled back cleanly, confirmed via `supabase migration list` before this fix -- the
-- original job was untouched). The already-live Phase 1 job (20260911211600_pg_cron_jobs.sql)
-- uses the correct pg_cron sub-minute syntax, '30 seconds' with no "every" prefix -- the "every"
-- wording came from the backend-schema doc's descriptive comment, not the doc's own actual SQL,
-- and this migration mistakenly copied the comment's wording into the literal schedule string.
select cron.unschedule('expire-no-show-grace-periods');
select cron.schedule('expire-no-show-grace-periods', '30 seconds', 'select expire_no_show_grace_periods();');
