-- Task 2 post-push finding: verify_barber_pin/test_set_staff_pin_hash failed live with
-- "function gen_salt(unknown) does not exist" despite pgcrypto being enabled
-- (20260911210000_extensions_and_shared.sql). Supabase's default behavior for an unqualified
-- `create extension if not exists X;` is to install into the `extensions` schema, not `public` --
-- this project's SECURITY DEFINER convention (`set search_path = public, pg_temp`, established
-- since 20260911211800_security_hardening.sql) deliberately keeps that search_path minimal for
-- security, which means it never resolves pgcrypto's functions. Fixed by schema-qualifying the
-- extension calls directly (extensions.crypt/extensions.gen_salt) rather than widening the
-- search_path -- keeps the minimal-search-path security convention intact for every other object
-- these functions can still resolve, and is the standard, Supabase-documented way to call an
-- extension function from a security definer function.
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
      and su.pin_hash = extensions.crypt(p_pin, su.pin_hash)
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

create or replace function test_set_staff_pin_hash(p_staff_user_id uuid, p_pin text)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  update staff_users
    set pin_hash = extensions.crypt(p_pin, extensions.gen_salt('bf'))
    where id = p_staff_user_id;
end;
$$;
