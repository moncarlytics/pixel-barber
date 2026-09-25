-- Final-review fix wave for staff invitation & deactivation
-- (Docs/superpowers/plans/2026-09-25-staff-invitation/final-fix-brief.md).
--
-- C1 (Critical): custom_access_token_hook emitted app_role/staff_id/branch_ids for ANY staff_users
-- row, so a pending invitee (or a deactivated account) with a password set could sign in and get a
-- full staff JWT -- invite expiry never limited this. Now the hook refuses sign-in/refresh entirely
-- (Supabase's documented hook error shape) whenever a staff_users row exists and is not an
-- accepted+active account. The Accept flow still works: staff-invite-accept claims the row as
-- 'accepted' before the page ever signs in.
create or replace function custom_access_token_hook(event jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  claims jsonb := event->'claims';
  v_staff record;
  v_branch_ids uuid[];
begin
  select id, role, invite_status, is_active into v_staff
    from staff_users where auth_user_id = (event->>'user_id')::uuid;
  if found then
    if v_staff.invite_status <> 'accepted' or not v_staff.is_active then
      return jsonb_build_object(
        'error', jsonb_build_object(
          'http_code', 403,
          'message', 'This staff account is not active'
        )
      );
    end if;
    select coalesce(array_agg(branch_id), '{}') into v_branch_ids
      from staff_branch_assignments where staff_user_id = v_staff.id;
    claims := jsonb_set(claims, '{app_role}', to_jsonb(v_staff.role::text));
    claims := jsonb_set(claims, '{staff_id}', to_jsonb(v_staff.id::text));
    claims := jsonb_set(claims, '{branch_ids}', to_jsonb(v_branch_ids));
  else
    claims := jsonb_set(claims, '{app_role}', to_jsonb('customer'::text));
  end if;
  return jsonb_set(event, '{claims}', claims);
end;
$$;

grant execute on function custom_access_token_hook(jsonb) to supabase_auth_admin;
revoke execute on function custom_access_token_hook(jsonb) from authenticated, anon, public;

-- I3 (Important): the barber pickers on both apps queried `barbers` directly by home_branch_id,
-- so a pending invitee (barber row created at invite time) or a deactivated barber showed up as
-- bookable/assignable. `barbers` is already public-read, so returning its rows here exposes
-- nothing new -- this just filters the set to accounts that are actually accepted and active.
create or replace function list_bookable_barbers(p_branch_id uuid)
returns setof barbers
language sql stable security definer set search_path = public, pg_temp
as $$
  select b.* from barbers b
  join staff_users su on su.id = b.staff_user_id
  where b.home_branch_id = p_branch_id
    and su.is_active
    and su.invite_status = 'accepted'
  order by b.created_at;
$$;
revoke execute on function list_bookable_barbers(uuid) from public;
grant execute on function list_bookable_barbers(uuid) to anon, authenticated, service_role;

-- I4 (Important): a pending barber (invite not yet accepted) was still schedulable/assignable via
-- find_eligible_barber and PIN-loginable via verify_barber_pin, since neither checked invite_status
-- (only is_active). Identical to their prior definitions plus an invite_status = 'accepted' check
-- everywhere is_active was already checked.
create or replace function find_eligible_barber(
  p_branch_id uuid,
  p_branch_service_id uuid,
  p_preferred_barber_id uuid default null
)
returns table (
  preferred_eligible boolean,
  preferred_scheduled_today boolean,
  fallback_barber_id uuid
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_service_id uuid;
begin
  select service_id into v_service_id
  from branch_services
  where id = p_branch_service_id and branch_id = p_branch_id;

  return query
  with eligible as (
    select b.id as barber_id
    from barbers b
    join staff_users su on su.id = b.staff_user_id and su.is_active and su.invite_status = 'accepted'
    join barber_skills bs on bs.barber_id = b.id and bs.service_id = v_service_id
    join barber_schedule sch on sch.barber_id = b.id
      and sch.work_date = current_date
      and sch.branch_id = p_branch_id
      and now()::time between sch.shift_start and sch.shift_end
    where b.status not in ('offline', 'end_of_shift', 'temporarily_unavailable')
  ),
  ranked as (
    select
      e.barber_id,
      (
        select count(*) from queue_tickets qt
        where qt.assigned_barber_id = e.barber_id
          and qt.branch_id = p_branch_id
          and qt.state in ('waiting', 'almost_turn', 'called', 'confirmed', 'in_service')
      ) as active_count
    from eligible e
  )
  select
    exists (select 1 from eligible where barber_id = p_preferred_barber_id),
    exists (
      select 1
      from barber_schedule sch
      join barber_skills bsk on bsk.barber_id = sch.barber_id and bsk.service_id = v_service_id
      join barbers pb on pb.id = sch.barber_id
      join staff_users psu on psu.id = pb.staff_user_id and psu.is_active and psu.invite_status = 'accepted'
      where sch.barber_id = p_preferred_barber_id
        and sch.work_date = current_date
        and sch.branch_id = p_branch_id
        and sch.shift_end > now()::time
    ),
    (select barber_id from ranked order by active_count asc, barber_id asc limit 1);
end;
$$;

revoke execute on function find_eligible_barber(uuid, uuid, uuid) from public, anon, authenticated;
grant execute on function find_eligible_barber(uuid, uuid, uuid) to authenticated, service_role;

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
    and su.invite_status = 'accepted'
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
      and su.invite_status = 'accepted'
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

revoke execute on function verify_barber_pin(uuid, text) from public, anon, authenticated;
grant execute on function verify_barber_pin(uuid, text) to service_role;
