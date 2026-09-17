-- Third instance of this project's recurring bug class (Phase 3 Task 1: customers/staff_users;
-- Phase 4 Task 1: barbers): queue_tickets has never had its UPDATE grant to `authenticated`
-- narrowed, so any actor whose row-level policy permits an UPDATE at all can, in principle, also
-- write columns their own policy's WITH CHECK says nothing about (position, assigned_barber_id,
-- estimated_wait_*, version -- the last of which must stay fully unwritable by any client now that
-- it is exclusively trigger-maintained per Phase 4's final review). This grants exactly the union
-- of columns any actor legitimately writes via an existing or this-phase policy; RLS continues to
-- govern WHO and under WHICH value (customer's state must equal 'cancelled', etc.) -- this governs
-- WHICH columns, matching every other bounded table in this schema.
revoke update on queue_tickets from authenticated;
grant update (
  state, cancel_reason, cancelled_at, called_at, confirmed_at,
  service_started_at, completed_at, grace_period_expires_at, skipped_at
) on queue_tickets to authenticated;
revoke update on queue_tickets from anon;
