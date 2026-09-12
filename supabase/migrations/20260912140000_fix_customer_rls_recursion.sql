-- Fixes a critical RLS infinite-recursion bug (Postgres 42P17) discovered while writing Phase 1's
-- cross-branch RLS integration test suite: tickets_customer_own (queue_tickets) and
-- customers_staff_scoped (customers) each subquery the other's table, and Postgres re-applies each
-- table's own RLS policies inside that subquery -- an unbroken mutual-recursion cycle that breaks
-- every select on queue_tickets (and everything that transitively subqueries it: queue_events,
-- feedback_customer_submit, service_sessions) for any non-service-role session. This is a bug in
-- the original policies as literally specified in backend-schema section 14.2's worked example,
-- not something a later migration introduced.
--
-- Fix: a security definer helper that resolves "my own customers.id" without re-triggering
-- customers' own RLS -- the same "security definer breaks an RLS cycle" pattern already used
-- throughout functions_and_triggers.sql -- then repoint every customer-owned-row policy at it
-- instead of an inline subquery against customers. customers_staff_scoped still legitimately
-- subqueries queue_tickets (that hop is necessary, not circular), so it is untouched here.
create or replace function current_customer_id() returns uuid
language sql stable
security definer
set search_path = public, pg_temp
as $$
  select id from customers where auth_user_id = auth.uid()
$$;

grant execute on function current_customer_id() to authenticated;

alter policy queue_events_customer_own_read on queue_events
  using (
    ticket_id in (
      select id from queue_tickets where customer_id = current_customer_id()
    )
  );

alter policy tickets_customer_own on queue_tickets
  using (customer_id = current_customer_id());

alter policy tickets_customer_create on queue_tickets
  with check (customer_id = current_customer_id());

alter policy tickets_customer_cancel on queue_tickets
  using (customer_id = current_customer_id())
  with check (state = 'cancelled');

alter policy appointments_customer_own on appointments
  using (customer_id = current_customer_id());

alter policy appointments_customer_create on appointments
  with check (customer_id = current_customer_id());

alter policy appointments_customer_update_own on appointments
  using (customer_id = current_customer_id())
  with check (customer_id = current_customer_id());

alter policy feedback_customer_own on feedback
  using (customer_id = current_customer_id());

alter policy feedback_customer_submit on feedback
  with check (
    customer_id = current_customer_id()
    and exists (select 1 from queue_tickets qt where qt.id = ticket_id and qt.state = 'completed')
  );

alter policy push_subscriptions_customer_own on push_subscriptions
  using (customer_id = current_customer_id())
  with check (customer_id = current_customer_id());

alter policy consents_customer_own_read on consents
  using (customer_id = current_customer_id());

alter policy consents_customer_own_insert on consents
  with check (customer_id = current_customer_id());

alter policy notifications_customer_own_read on notifications
  using (
    recipient_type = 'customer'
    and recipient_id = current_customer_id()
  );
