-- Task 3 (barber-pin-set Edge Function): counterpart to Task 2's verify_barber_pin -- this is how
-- a barber's pin_hash actually gets set/rotated by an authorized Branch Manager or Owner in the
-- first place. Same shape as verify_barber_pin/test_set_staff_pin_hash (20260917090200/090300),
-- so it carries the identical pgcrypto fix from the start: pgcrypto's crypt()/gen_salt() live in
-- the `extensions` schema on this project, not `public`, and this function's SECURITY DEFINER
-- search_path is deliberately kept minimal (`public, pg_temp`, this project's established
-- convention since 20260911211800_security_hardening.sql) and never resolves `extensions` --
-- so the calls below are schema-qualified (extensions.crypt/extensions.gen_salt) rather than
-- widening the search_path, matching the fix 20260917090300_fix_pgcrypto_search_path.sql already
-- established and had independently verified as correct and minimal.
--
-- Restricted to role = 'barber' rows only, same as the brief -- the caller (barber-pin-set) has
-- already verified via has_capability/in_branch_scope that the target is a barber the caller
-- manages; this WHERE clause is a second, defense-in-depth guard against ever setting a pin_hash
-- on a non-barber staff_users row.
create or replace function set_barber_pin(p_staff_user_id uuid, p_pin text) returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  update staff_users set pin_hash = extensions.crypt(p_pin, extensions.gen_salt('bf'))
    where id = p_staff_user_id and role = 'barber';
end;
$$;

revoke execute on function set_barber_pin(uuid, text) from public, anon, authenticated;
grant execute on function set_barber_pin(uuid, text) to service_role;
