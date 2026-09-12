-- Backend schema doc section 14: RLS enabled on every table, no exceptions. Section 14.2's
-- worked examples (branches, customers, staff_users, queue_tickets, feedback, audit_log) are
-- used verbatim; every other table applies one of section 14.1's four shapes mechanically:
-- public read-only reference data, customer-owned data, staff-internal operational data, and
-- append-only logs (UPDATE/DELETE revoked outright, stronger than a policy that returns no rows).

-- ---------------------------------------------------------------------------
-- Businesses, and other tables section 14.1's four named shapes don't explicitly list but
-- section 14.1's "no exceptions" still covers.
-- ---------------------------------------------------------------------------

-- Single-row business config; public read (branch status/currency display needs it), Owner-only
-- write -- there's no dedicated capability for business-wide settings, so this uses the same
-- hard-coded Owner shortcut in_branch_scope() itself documents (section 3.2's note).
alter table businesses enable row level security;
create policy businesses_public_read on businesses for select using (true);
create policy businesses_owner_write on businesses for all
  using (auth_role() = 'owner')
  with check (auth_role() = 'owner');

-- Purely an internal per-branch/per-day counter; written only by next_ticket_number(), which is
-- security definer and so bypasses RLS entirely -- no client policy needed or wanted.
alter table branch_ticket_counters enable row level security;

alter table service_sessions enable row level security;
create policy service_sessions_staff_branch_scope on service_sessions for all
  using (
    has_capability('edit_tickets')
    and in_branch_scope((select branch_id from queue_tickets where id = ticket_id))
  )
  with check (
    has_capability('edit_tickets')
    and in_branch_scope((select branch_id from queue_tickets where id = ticket_id))
  );
create policy service_sessions_barber_own on service_sessions for all
  using (barber_id = (select id from barbers where staff_user_id = auth_staff_id()))
  with check (barber_id = (select id from barbers where staff_user_id = auth_staff_id()));

alter table branches enable row level security;
create policy branches_public_read on branches for select using (true);
create policy branches_staff_write on branches for all
  using (has_capability('manage_branches') and in_branch_scope(id))
  with check (has_capability('manage_branches') and in_branch_scope(id));

alter table branch_hours enable row level security;
create policy branch_hours_public_read on branch_hours for select using (true);
create policy branch_hours_staff_write on branch_hours for all
  using (has_capability('edit_hours') and in_branch_scope(branch_id))
  with check (has_capability('edit_hours') and in_branch_scope(branch_id));

alter table branch_closures enable row level security;
create policy branch_closures_public_read on branch_closures for select using (true);
create policy branch_closures_staff_write on branch_closures for all
  using (has_capability('edit_hours') and in_branch_scope(branch_id))
  with check (has_capability('edit_hours') and in_branch_scope(branch_id));

alter table services enable row level security;
create policy services_public_read on services for select using (true);
create policy services_staff_write on services for all
  using (has_capability('edit_pricing'))
  with check (has_capability('edit_pricing'));

alter table branch_services enable row level security;
create policy branch_services_public_read on branch_services for select using (true);
create policy branch_services_staff_write on branch_services for all
  using (has_capability('edit_pricing') and in_branch_scope(branch_id))
  with check (has_capability('edit_pricing') and in_branch_scope(branch_id));

alter table branch_service_prices enable row level security;
create policy branch_service_prices_public_read on branch_service_prices for select using (true);
create policy branch_service_prices_staff_write on branch_service_prices for all
  using (
    has_capability('edit_pricing')
    and in_branch_scope((select branch_id from branch_services where id = branch_service_id))
  )
  with check (
    has_capability('edit_pricing')
    and in_branch_scope((select branch_id from branch_services where id = branch_service_id))
  );

alter table barbers enable row level security;
create policy barbers_public_read on barbers for select using (true);
create policy barbers_staff_write on barbers for all
  using (has_capability('manage_barber_schedules') and in_branch_scope(home_branch_id))
  with check (has_capability('manage_barber_schedules') and in_branch_scope(home_branch_id));
-- A barber can update their own operational row (status, e.g. available/busy/on_break) directly.
create policy barbers_self_update on barbers for update
  using (staff_user_id = auth_staff_id())
  with check (staff_user_id = auth_staff_id());

alter table barber_skills enable row level security;
create policy barber_skills_public_read on barber_skills for select using (true);
create policy barber_skills_staff_write on barber_skills for all
  using (
    has_capability('manage_barber_schedules')
    and in_branch_scope((select home_branch_id from barbers where id = barber_id))
  )
  with check (
    has_capability('manage_barber_schedules')
    and in_branch_scope((select home_branch_id from barbers where id = barber_id))
  );

-- ---------------------------------------------------------------------------
-- Identity
-- ---------------------------------------------------------------------------

alter table customers enable row level security;

create policy customers_self_read on customers for select
  using (auth_user_id = auth.uid());

create policy customers_self_update on customers for update
  using (auth_user_id = auth.uid())
  with check (auth_user_id = auth.uid());

create policy customers_staff_scoped on customers for select
  using (
    auth_role() = 'owner'
    or exists (
      select 1 from queue_tickets qt
      where qt.customer_id = customers.id and qt.branch_id = any(auth_branch_ids())
    )
  );

create policy customers_staff_register_walkin on customers for insert
  with check (has_capability('register_walkins'));

alter table staff_users enable row level security;

create policy staff_users_self_read on staff_users for select
  using (auth_user_id = auth.uid());

create policy staff_users_self_update_profile on staff_users for update
  using (auth_user_id = auth.uid())
  with check (auth_user_id = auth.uid());
-- Column-level privilege revoke: a self-update can never change role, invite_status, pin_hash,
-- or the invite-tracking columns — those change only through service-role code (invite Edge
-- Functions, or an Owner action) per the doc's own note alongside this policy.
revoke update (role, invite_status, pin_hash, invited_by_staff_id, invited_at, invite_accepted_at)
  on staff_users from authenticated;

create policy staff_users_branch_scoped_read on staff_users for select
  using (
    auth_role() = 'owner'
    or exists (
      select 1 from staff_branch_assignments sba
      where sba.staff_user_id = staff_users.id and sba.branch_id = any(auth_branch_ids())
    )
  );
-- No insert or delete policy for staff_users: every row is created/removed by the service-role
-- staff-invite Edge Functions or the one-time manual bootstrap, never a client request.

alter table staff_branch_assignments enable row level security;
create policy staff_branch_assignments_staff_read on staff_branch_assignments for select
  using (auth_role() = 'owner' or branch_id = any(auth_branch_ids()));
-- No client write policy: assignment changes happen through Owner/Branch-Manager staff
-- management screens backed by service-role code, per the same reasoning as staff_users above.

-- ---------------------------------------------------------------------------
-- Staff-internal operational data
-- ---------------------------------------------------------------------------

alter table barber_schedule enable row level security;
create policy barber_schedule_staff_scoped on barber_schedule for all
  using (has_capability('manage_barber_schedules') and in_branch_scope(branch_id))
  with check (has_capability('manage_barber_schedules') and in_branch_scope(branch_id));
create policy barber_schedule_barber_own_read on barber_schedule for select
  using (barber_id = (select id from barbers where staff_user_id = auth_staff_id()));

alter table barber_service_stats enable row level security;
create policy barber_service_stats_staff_read on barber_service_stats for select
  using (
    has_capability('view_branch_reports')
    and in_branch_scope((select home_branch_id from barbers where id = barber_id))
  );
-- No client write policy: only the security-definer trigger in the functions_and_triggers
-- migration writes this table.

alter table audit_log enable row level security;
create policy audit_log_read on audit_log for select
  using (has_capability('view_audit_log'));
-- No insert/update/delete policy for authenticated/anon: every row is written by trusted
-- server-side code using the service-role key, which bypasses RLS entirely by design.

alter table queue_events enable row level security;
create policy queue_events_staff_read on queue_events for select
  using (
    has_capability('view_branch_reports')
    and in_branch_scope((select branch_id from queue_tickets where id = ticket_id))
  );
create policy queue_events_customer_own_read on queue_events for select
  using (
    ticket_id in (
      select id from queue_tickets
      where customer_id in (select id from customers where auth_user_id = auth.uid())
    )
  );
-- Insert-only for authenticated/anon per the append-only shape; in practice every row is written
-- by server-side code (service role) or the security-definer trigger functions above, but the
-- table itself only ever needs INSERT to stay open to a client if a client writes it directly.

-- ---------------------------------------------------------------------------
-- Customer-owned data
-- ---------------------------------------------------------------------------

alter table queue_tickets enable row level security;

create policy tickets_customer_own on queue_tickets for select
  using (customer_id in (select id from customers where auth_user_id = auth.uid()));

create policy tickets_customer_create on queue_tickets for insert
  with check (customer_id in (select id from customers where auth_user_id = auth.uid()));

create policy tickets_customer_cancel on queue_tickets for update
  using (customer_id in (select id from customers where auth_user_id = auth.uid()))
  with check (state = 'cancelled');

create policy tickets_staff_branch_scope on queue_tickets for all
  using (in_branch_scope(branch_id) and has_capability('edit_tickets'))
  with check (in_branch_scope(branch_id) and has_capability('edit_tickets'));

create policy tickets_barber_own_queue on queue_tickets for update
  using (assigned_barber_id = (select id from barbers where staff_user_id = auth_staff_id()))
  with check (assigned_barber_id = (select id from barbers where staff_user_id = auth_staff_id()));

alter table appointments enable row level security;

create policy appointments_customer_own on appointments for select
  using (customer_id in (select id from customers where auth_user_id = auth.uid()));

create policy appointments_customer_create on appointments for insert
  with check (customer_id in (select id from customers where auth_user_id = auth.uid()));

create policy appointments_customer_update_own on appointments for update
  using (customer_id in (select id from customers where auth_user_id = auth.uid()))
  with check (customer_id in (select id from customers where auth_user_id = auth.uid()));

create policy appointments_staff_branch_scope on appointments for all
  using (in_branch_scope(branch_id) and has_capability('edit_tickets'))
  with check (in_branch_scope(branch_id) and has_capability('edit_tickets'));

alter table feedback enable row level security;

create policy feedback_customer_own on feedback for select
  using (customer_id in (select id from customers where auth_user_id = auth.uid()));

create policy feedback_customer_submit on feedback for insert
  with check (
    customer_id in (select id from customers where auth_user_id = auth.uid())
    and exists (select 1 from queue_tickets qt where qt.id = ticket_id and qt.state = 'completed')
  );

create policy feedback_staff_read on feedback for select
  using (in_branch_scope(branch_id) and has_capability('view_branch_reports'));

alter table push_subscriptions enable row level security;
create policy push_subscriptions_customer_own on push_subscriptions for all
  using (customer_id in (select id from customers where auth_user_id = auth.uid()))
  with check (customer_id in (select id from customers where auth_user_id = auth.uid()));

alter table consents enable row level security;
create policy consents_customer_own_read on consents for select
  using (customer_id in (select id from customers where auth_user_id = auth.uid()));
create policy consents_customer_own_insert on consents for insert
  with check (customer_id in (select id from customers where auth_user_id = auth.uid()));
create policy consents_staff_read on consents for select
  using (
    has_capability('view_branch_reports')
    or has_capability('broadcast_messages')
  );
-- Append-only per section 14.1's fourth shape: no update, no delete, for anyone but service role.
revoke update, delete on consents from authenticated, anon;

alter table notifications enable row level security;
create policy notifications_customer_own_read on notifications for select
  using (
    recipient_type = 'customer'
    and recipient_id in (select id from customers where auth_user_id = auth.uid())
  );
create policy notifications_staff_own_read on notifications for select
  using (recipient_type = 'staff' and recipient_id = auth_staff_id());
-- No client insert/update/delete policy: every notification row is written by server-side code
-- (the ticket-lifecycle/feedback webhooks and the Join/Walk-in endpoints), never a direct client
-- write, since notification_status is a delivery fact the client must never be able to fabricate.
