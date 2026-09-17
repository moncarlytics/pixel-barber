-- Final Phase 4 review finding: Task 7's Barber Board lets any staff user with edit_tickets
-- toggle a barber's status, but the only UPDATE policies on `barbers` were `barbers_staff_write`
-- (gated on manage_barber_schedules, owner/branch_manager only) and `barbers_self_update` (a
-- barber's own row only) -- receptionist, the intended Live Queue operator per App Flow 8.5, has
-- neither, so the toggle silently affected zero rows via RLS. This adds a policy scoped to the
-- same edit_tickets/branch-scope pair tickets_staff_branch_scope already uses for queue_tickets
-- writes, treating barber-status toggling as part of the same Live Queue operational surface. The
-- column-level grant already restricts `authenticated` to (status, home_branch_id) on this table
-- (20260916150000_barbers_self_update_column_restriction.sql) -- this policy governs WHO, not
-- WHICH columns, matching every other bounded staff-write policy in this file. (A receptionist
-- could in principle also reassign a barber's home_branch_id through this same grant -- the exact
-- same latitude `barbers_self_update` already gives a barber over their own row today, not a new
-- risk this policy introduces.)
create policy barbers_staff_status_update on barbers for update
  using (has_capability('edit_tickets') and in_branch_scope(home_branch_id))
  with check (has_capability('edit_tickets') and in_branch_scope(home_branch_id));
