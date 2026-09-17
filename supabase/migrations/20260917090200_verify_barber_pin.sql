-- Backend schema section 3.3 (pin-login). pgcrypto is already enabled in
-- 20260911210000_extensions_and_shared.sql, so crypt() is available here without re-adding it.
--
-- Looks up staff_users where role='barber', pin_hash matches via crypt(), and the barber is
-- legitimately assigned to p_branch_id -- via home_branch_id (this schema's actual column; the
-- backend-schema doc's own reference to `barbers.today_branch_id` does not exist anywhere in this
-- schema, confirmed by grep across every migration) or an explicit staff_branch_assignments row
-- (a barber covering a second branch). Returns the matching staff_user's id/email for pin-login to
-- generate a magic link against, or null on any mismatch -- wrong PIN and wrong branch both return
-- null identically, so a caller learns nothing about which one failed.
create or replace function verify_barber_pin(p_branch_id uuid, p_pin text)
returns table (staff_user_id uuid, email text)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  return query
    select su.id, su.email
    from staff_users su
    join barbers b on b.staff_user_id = su.id
    where su.role = 'barber'
      and su.pin_hash is not null
      and su.pin_hash = crypt(p_pin, su.pin_hash)
      and (
        b.home_branch_id = p_branch_id
        or exists (
          select 1 from staff_branch_assignments sba
          where sba.staff_user_id = su.id and sba.branch_id = p_branch_id
        )
      )
    limit 1;
end;
$$;

revoke execute on function verify_barber_pin(uuid, text) from public, anon, authenticated;
grant execute on function verify_barber_pin(uuid, text) to service_role;

-- Test-only helper: sets a bcrypt pin_hash directly via crypt()/gen_salt('bf') so
-- tests/db/pin-login.test.ts can isolate pin-login's own logic from Task 3's not-yet-built
-- barber-pin-set Edge Function. service_role-only, exactly like verify_barber_pin above -- pin_hash
-- must never be settable except through a server-side bcrypt path. Task 3 should replace calls to
-- this helper with its real `barber-pin-set` function once that lands; this function can then be
-- dropped.
create or replace function test_set_staff_pin_hash(p_staff_user_id uuid, p_pin text)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  update staff_users
    set pin_hash = crypt(p_pin, gen_salt('bf'))
    where id = p_staff_user_id;
end;
$$;

revoke execute on function test_set_staff_pin_hash(uuid, text) from public, anon, authenticated;
grant execute on function test_set_staff_pin_hash(uuid, text) to service_role;
