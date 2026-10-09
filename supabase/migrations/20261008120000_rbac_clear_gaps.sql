-- Role/permission check (Docs/superpowers/specs/2026-10-08-role-permission-check-design.md): fixes
-- for the clear gaps the matrix confirmed.

-- G-consents-scope: staff read consents only for customers of their branches, and only with
-- broadcast_messages (owner, branch_manager). Analysts see "Promotions" through customer_detail.
create or replace function customer_in_my_branches(p_customer_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (select 1 from queue_tickets t where t.customer_id = p_customer_id and in_branch_scope(t.branch_id))
      or exists (select 1 from appointments a where a.customer_id = p_customer_id and in_branch_scope(a.branch_id));
$$;
revoke execute on function customer_in_my_branches(uuid) from public, anon;
grant execute on function customer_in_my_branches(uuid) to authenticated;

drop policy if exists consents_staff_read on consents;
create policy consents_staff_read on consents for select
  using (has_capability('broadcast_messages') and customer_in_my_branches(customer_id));

-- G-ticket-delete: staff keep select/insert/update on their branch's tickets; no deletes.
drop policy if exists tickets_staff_branch_scope on queue_tickets;
create policy tickets_staff_branch_select on queue_tickets for select
  using (in_branch_scope(branch_id) and has_capability('edit_tickets'));
create policy tickets_staff_branch_insert on queue_tickets for insert
  with check (in_branch_scope(branch_id) and has_capability('edit_tickets'));
create policy tickets_staff_branch_update on queue_tickets for update
  using (in_branch_scope(branch_id) and has_capability('edit_tickets'))
  with check (in_branch_scope(branch_id) and has_capability('edit_tickets'));

-- G-session-delete: barbers and staff keep select/insert/update on service sessions; no deletes.
drop policy if exists service_sessions_barber_own on service_sessions;
drop policy if exists service_sessions_staff_branch_scope on service_sessions;
create policy service_sessions_barber_own_select on service_sessions for select
  using (barber_id = (select b.id from barbers b where b.staff_user_id = auth_staff_id()));
create policy service_sessions_barber_own_insert on service_sessions for insert
  with check (barber_id = (select b.id from barbers b where b.staff_user_id = auth_staff_id()));
create policy service_sessions_barber_own_update on service_sessions for update
  using (barber_id = (select b.id from barbers b where b.staff_user_id = auth_staff_id()))
  with check (barber_id = (select b.id from barbers b where b.staff_user_id = auth_staff_id()));
create policy service_sessions_staff_select on service_sessions for select
  using (has_capability('edit_tickets')
         and in_branch_scope((select t.branch_id from queue_tickets t where t.id = service_sessions.ticket_id)));
create policy service_sessions_staff_insert on service_sessions for insert
  with check (has_capability('edit_tickets')
              and in_branch_scope((select t.branch_id from queue_tickets t where t.id = service_sessions.ticket_id)));
create policy service_sessions_staff_update on service_sessions for update
  using (has_capability('edit_tickets')
         and in_branch_scope((select t.branch_id from queue_tickets t where t.id = service_sessions.ticket_id)))
  with check (has_capability('edit_tickets')
              and in_branch_scope((select t.branch_id from queue_tickets t where t.id = service_sessions.ticket_id)));

-- G-barbers-insert-delete: managers keep updating their branch's barbers; creating or removing a
-- barber row is staff management (owner, manage_staff).
drop policy if exists barbers_staff_write on barbers;
create policy barbers_staff_update on barbers for update
  using (has_capability('manage_barber_schedules') and in_branch_scope(home_branch_id))
  with check (has_capability('manage_barber_schedules') and in_branch_scope(home_branch_id));
create policy barbers_owner_insert on barbers for insert
  with check (has_capability('manage_staff'));
create policy barbers_owner_delete on barbers for delete
  using (has_capability('manage_staff'));

-- G-ticket-customer-forge: a customer may insert only a realistic own ticket (joining the queue).
-- The customer app joins through the tickets-join Edge Function (service role), so this policy is
-- a backstop against direct client inserts of finished or staff-created tickets.
drop policy if exists tickets_customer_create on queue_tickets;
create policy tickets_customer_create on queue_tickets for insert
  with check (
    customer_id = current_customer_id()
    and state in ('created', 'waiting')
    and created_by = 'customer'
    and assigned_barber_id is null
    and service_started_at is null
    and completed_at is null
    and no_show_at is null
    and cancelled_at is null
    and called_at is null
    and confirmed_at is null
  );
