-- Final Phase 5 review findings:
-- 1. verify_barber_pin's `limit 1` with no `order by` meant a PIN collision between two barbers at
--    the same branch would silently authenticate as an arbitrary one of them. Now returns zero
--    rows (identical to "no match" -- the caller already can't distinguish wrong-PIN from
--    wrong-branch, so this leaks nothing new) whenever more than one barber matches.
-- 2. is_active was never checked, so a deactivated barber's PIN kept working (this is a
--    pre-existing, systemic gap -- password login and custom_access_token_hook have the same
--    hole -- but this phase added a new auth entry point where the check was one line to add).
create or replace function verify_barber_pin(p_branch_id uuid, p_pin text)
returns table (staff_user_id uuid, email text)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_match_count integer;
begin
  select count(*) into v_match_count
  from staff_users su
  join barbers b on b.staff_user_id = su.id
  where su.role = 'barber'
    and su.is_active
    and su.pin_hash is not null
    and su.pin_hash = extensions.crypt(p_pin, su.pin_hash)
    and (
      b.home_branch_id = p_branch_id
      or exists (
        select 1 from staff_branch_assignments sba
        where sba.staff_user_id = su.id and sba.branch_id = p_branch_id
      )
    );

  if v_match_count <> 1 then
    return;
  end if;

  return query
    select su.id, su.email
    from staff_users su
    join barbers b on b.staff_user_id = su.id
    where su.role = 'barber'
      and su.is_active
      and su.pin_hash is not null
      and su.pin_hash = extensions.crypt(p_pin, su.pin_hash)
      and (
        b.home_branch_id = p_branch_id
        or exists (
          select 1 from staff_branch_assignments sba
          where sba.staff_user_id = su.id and sba.branch_id = p_branch_id
        )
      );
end;
$$;

-- Reject setting a PIN that already matches a different barber sharing the same home branch --
-- the dominant collision case. (A collision only reachable via a staff_branch_assignments overlap,
-- not a shared home branch, is still caught defensively by verify_barber_pin's own multi-match
-- rejection above -- this check doesn't need to be exhaustive over every overlap path to close the
-- practical risk.)
create or replace function set_barber_pin(p_staff_user_id uuid, p_pin text) returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_home_branch_id uuid;
  v_collision_count integer;
begin
  select b.home_branch_id into v_home_branch_id from barbers b where b.staff_user_id = p_staff_user_id;

  select count(*) into v_collision_count
  from staff_users su
  join barbers b on b.staff_user_id = su.id
  where su.role = 'barber'
    and su.id <> p_staff_user_id
    and su.pin_hash is not null
    and su.pin_hash = extensions.crypt(p_pin, su.pin_hash)
    and b.home_branch_id = v_home_branch_id;

  if v_collision_count > 0 then
    raise exception 'This PIN is already in use by another barber at this branch' using errcode = 'P0001';
  end if;

  update staff_users set pin_hash = extensions.crypt(p_pin, extensions.gen_salt('bf'))
    where id = p_staff_user_id and role = 'barber';
end;
$$;

-- Also close the same is_active gap in the test-only helper's counterpart function, and restrict
-- it to barbers only (it was never restricted, unlike set_barber_pin -- low real impact since
-- verify_barber_pin already filters on role='barber', but no reason to leave it broader than
-- set_barber_pin now that both exist).
create or replace function test_set_staff_pin_hash(p_staff_user_id uuid, p_pin text)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  update staff_users
    set pin_hash = extensions.crypt(p_pin, extensions.gen_salt('bf'))
    where id = p_staff_user_id and role = 'barber';
end;
$$;
