-- Closes two narrowing gaps found in this security-critical fix's own review
-- (20260913150000_customers_self_update_column_restriction.sql):
--
-- 1. last_activity_at was included in the customers allow-list, but nothing client-side writes
--    it -- its only writers (bump_customer_last_activity, link_or_create_customer) are both
--    security definer. It's the 3-year retention clock; a customer freezing/backdating their own
--    retention signal is the same class of self-serving manipulation this fix exists to prevent.
revoke update (last_activity_at) on customers from authenticated;

-- 2. `anon` still held a table-wide UPDATE grant on both tables (dormant today, since every
--    relevant RLS policy keys off auth.uid() which is NULL for anon -- but the whole premise of
--    this fix is that the grant itself is the real boundary, not policy correctness alone).
--    Matches the existing precedent at 20260911211400_rls_policies.sql:272
--    ("revoke update, delete on consents from authenticated, anon;").
revoke update on customers from anon;
revoke update on staff_users from anon;

-- Permanent, safe introspection function so a future accidental `grant all on all tables in
-- schema public to authenticated` (a common Supabase snippet) is caught by an automated
-- regression test instead of being rediscovered by hand. Exposes exactly the one
-- information_schema query needed to assert on the column-UPDATE grant boundary; callable only
-- by service_role.
create or replace function public.get_update_grants(p_table text, p_grantee text)
returns table(column_name text)
security definer
set search_path = public, pg_temp
language sql
as $$
  select column_name::text
  from information_schema.role_column_grants
  where table_name = p_table
    and grantee = p_grantee
    and privilege_type = 'UPDATE';
$$;

revoke execute on function public.get_update_grants(text, text) from public, anon, authenticated;
grant execute on function public.get_update_grants(text, text) to service_role;
