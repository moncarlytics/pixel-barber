-- Staff invitation & deactivation (Docs/superpowers/specs/2026-09-25-staff-invitation-design.md).
-- Invite state stays on staff_users (backend-schema 3.4: an invite is a stage of a staff account,
-- not a separate entity). Adds the token hash + expiry, the Owner's staff list, the inactive-barber
-- skip in find_eligible_barber, and a service-role-only test helper.

alter table staff_users
  add column invite_token_hash text,
  add column invite_expires_at timestamptz;

-- The accept lookup is by hash; one live token per row, never shared between rows.
create unique index staff_users_invite_token_hash_key
  on staff_users (invite_token_hash) where invite_token_hash is not null;

-- NOTE: deliberately NOT added to the column-level client SELECT grant on staff_users
-- (20260925100000_protect_staff_pin_hash_reads.sql). Only service-role code reads these.

-- The Owner's Staff & Roles table. SECURITY DEFINER because the table needs values clients can't
-- read (the expiry, for the derived status) and branch names from two sources (barbers' home
-- branch vs everyone else's branch assignment). Returns rows only for manage_staff (the Owner).
create or replace function list_staff_accounts()
returns table (
  staff_user_id uuid,
  name text,
  role staff_role,
  email text,
  phone_e164 text,
  branch_id uuid,
  branch_name text,
  status text,
  invited_at timestamptz,
  is_self boolean
)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select
    su.id,
    su.name,
    su.role,
    su.email,
    su.phone_e164,
    coalesce(b.home_branch_id, sba.branch_id),
    br.name,
    case
      when su.invite_status = 'revoked' then 'revoked'
      when su.invite_status = 'expired' then 'invite_expired'
      when su.invite_status = 'pending' and su.invite_expires_at < now() then 'invite_expired'
      when su.invite_status = 'pending' then 'invite_pending'
      when not su.is_active then 'deactivated'
      else 'active'
    end,
    su.invited_at,
    su.id = auth_staff_id()
  from staff_users su
  left join barbers b on b.staff_user_id = su.id
  left join lateral (
    select a.branch_id from staff_branch_assignments a
    where a.staff_user_id = su.id
    order by a.branch_id
    limit 1
  ) sba on true
  left join branches br on br.id = coalesce(b.home_branch_id, sba.branch_id)
  where has_capability('manage_staff')
  order by su.name;
$$;

revoke execute on function list_staff_accounts() from public, anon;
grant execute on function list_staff_accounts() to authenticated, service_role;

-- find_eligible_barber: identical to 20260923090000_final_review_fixes.sql except that a barber
-- whose staff account is deactivated (staff_users.is_active = false) is never eligible, never the
-- fallback, and never offered as "scheduled later today".
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
    join staff_users su on su.id = b.staff_user_id and su.is_active
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
      join staff_users psu on psu.id = pb.staff_user_id and psu.is_active
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

-- Test-only: set a KNOWN invite token so automated tests can open an invite link (the real token
-- only ever exists in the sent SMS/email). Same pattern as test_set_staff_pin_hash: service_role
-- only, never granted to clients. The hash must match _shared/staff-invite-core.ts
-- hashInviteToken(): hex SHA-256 of the token's UTF-8 bytes.
create or replace function test_set_staff_invite_token(
  p_staff_user_id uuid,
  p_token text,
  p_expires_at timestamptz
) returns void
language sql
security definer
set search_path = public, pg_temp
as $$
  update staff_users
  set invite_token_hash = encode(sha256(convert_to(p_token, 'UTF8')), 'hex'),
      invite_expires_at = p_expires_at
  where id = p_staff_user_id;
$$;

revoke execute on function test_set_staff_invite_token(uuid, text, timestamptz)
  from public, anon, authenticated;
grant execute on function test_set_staff_invite_token(uuid, text, timestamptz) to service_role;
