-- The column-level REVOKE pattern below replaces two broken ones: this migration's own first
-- draft, and the pre-existing staff_users_self_update_profile revoke in
-- 20260911211400_rls_policies.sql. Both were no-ops: `revoke update (col_list) ... from
-- authenticated` only removes column-level ACL entries, and never diminishes the TABLE-WIDE
-- `update` grant Supabase's default privileges give `authenticated` on every public-schema table.
-- Verified via information_schema.role_table_grants and a direct `set role authenticated; update
-- ... where false;` test against real Postgres: both customers.no_show_count and,
-- critically, staff_users.role remained fully updatable by any authenticated session -- a live
-- privilege-escalation bug (any staff member could set their own role to 'owner' directly via the
-- client) and a live data-integrity bug (a customer could zero their own no_show_count), both
-- predating this task. Fixed here for both tables with the correct pattern: revoke the table-wide
-- grant entirely, then grant back only an explicit allow-list of columns a self-update should ever
-- touch.
revoke update on customers from authenticated;
grant update (name, email, avatar_key, preferred_branch_id, push_lead_minutes_primary, push_lead_minutes_secondary, push_enabled, sms_backup_enabled, last_activity_at)
  on customers to authenticated;

revoke update on staff_users from authenticated;
grant update (name, phone_e164, email)
  on staff_users to authenticated;
