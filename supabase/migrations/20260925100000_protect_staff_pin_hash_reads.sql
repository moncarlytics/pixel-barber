-- staff_users.pin_hash is a bcrypt hash of a 4-6 digit PIN, which is brute-forceable offline in
-- seconds, so no client session may ever read it. The row policies (staff_users_self_read,
-- staff_users_branch_scoped_read) are correct about WHICH rows staff may see, but Supabase's
-- default table-wide SELECT grant exposed every column of those rows -- including colleagues'
-- PIN hashes to anyone at the same branch. As with the UPDATE boundary
-- (20260913160000_narrow_customer_staff_update_grants.sql), the grant is the real boundary:
-- drop the table-wide SELECT and grant it back column by column, leaving pin_hash out.
--
-- Unaffected: PIN verification/setting (verify_barber_pin, set_barber_pin -- security definer),
-- the auth hook (supabase_auth_admin has its own grant), and service_role.
-- NOTE: a column added to staff_users later is NOT client-readable until it is added here.
-- A client `select('*')` on staff_users now fails (permission denied for pin_hash); name columns.

revoke select on staff_users from anon, authenticated;

grant select (
  id,
  auth_user_id,
  name,
  phone_e164,
  email,
  role,
  is_active,
  invite_status,
  invited_by_staff_id,
  invited_at,
  invite_accepted_at,
  created_at,
  updated_at
) on staff_users to authenticated;
