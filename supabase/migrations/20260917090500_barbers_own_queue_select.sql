-- Preflight finding (Task 5): tickets_barber_own_queue (20260911211400_rls_policies.sql:222-224) was
-- declared `for update` only -- no policy anywhere lets a barber SELECT their own assigned tickets,
-- so Today's Queue's reads would silently return empty for every barber. tickets_staff_branch_scope
-- doesn't cover this either (requires edit_tickets, which the barber role doesn't have -- only
-- manage_own_queue). This adds the missing SELECT policy with the identical USING clause the
-- existing UPDATE policy already uses.
create policy tickets_barber_own_queue_select on queue_tickets for select
  using (assigned_barber_id = (select id from barbers where staff_user_id = auth_staff_id()));
