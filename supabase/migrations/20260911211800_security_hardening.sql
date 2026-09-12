-- Fixes for findings the Supabase security advisor raised immediately after the Phase 1 schema
-- was applied (mcp__supabase__get_advisors, type=security). Addressed now rather than deferred to
-- Phase 10, since capabilities/role_capabilities had RLS disabled outright -- a real
-- privilege-escalation hole, not a style nit -- and the rest are one-line fixes while the schema
-- is still fresh.

-- 1. rls_disabled_in_public (ERROR): capabilities/role_capabilities are the RBAC source of truth
-- has_capability() reads from; without RLS, any authenticated client could rewrite role grants
-- directly via PostgREST. Both are static reference data -- public read, no client write.
alter table capabilities enable row level security;
create policy capabilities_public_read on capabilities for select using (true);

alter table role_capabilities enable row level security;
create policy role_capabilities_public_read on role_capabilities for select using (true);

-- 2. security_definer_view (ERROR): by default a view runs with its creator's privileges, not
-- the querying user's -- meaning customer_segments in particular would leak every customer's
-- segment to any role with select on the view, regardless of that customer's/staff member's own
-- RLS scope. security_invoker makes each view re-check RLS on its underlying tables as the
-- calling user, exactly as a direct query would.
alter view branch_status_view set (security_invoker = true);
alter view current_branch_service_price set (security_invoker = true);
alter view customer_segments set (security_invoker = true);

-- 3. function_search_path_mutable (WARN): pin search_path on every function that didn't already
-- get one in the functions_and_triggers / auth_hook_and_helpers migrations.
alter function set_updated_at() set search_path = public, pg_temp;
alter function check_notification_recipient() set search_path = public, pg_temp;
alter function auth_role() set search_path = public, pg_temp;
alter function auth_staff_id() set search_path = public, pg_temp;
alter function auth_branch_ids() set search_path = public, pg_temp;
alter function has_capability(text) set search_path = public, pg_temp;
alter function in_branch_scope(uuid) set search_path = public, pg_temp;

-- 4. anon/authenticated_security_definer_function_executable (WARN): these six are either
-- trigger functions (never meant to be called directly -- Postgres invokes them via the trigger
-- mechanism regardless of grants) or system-internal helpers (next_ticket_number,
-- recalculate_positions) meant to be called only from trusted server-side code under the
-- service-role key, never directly by a client over PostgREST RPC.
revoke execute on function bump_customer_last_activity() from public, anon, authenticated;
revoke execute on function next_ticket_number(uuid) from public, anon, authenticated;
revoke execute on function recalculate_positions(uuid, uuid) from public, anon, authenticated;
revoke execute on function trg_feedback_updates_barber_rating() from public, anon, authenticated;
revoke execute on function trg_service_session_completed() from public, anon, authenticated;
revoke execute on function trg_ticket_state_changed() from public, anon, authenticated;
