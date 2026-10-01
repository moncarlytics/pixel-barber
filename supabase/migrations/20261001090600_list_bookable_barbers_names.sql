-- Barber pickers (customer Book flow and branch page, staff Live Queue and Add Walk-in) showed raw
-- barber ids. list_bookable_barbers now also returns each barber's display name
-- (staff_users.name, the name the Owner entered when inviting them) -- and, unlike before, only the
-- barber fields the pickers use, nothing else from barbers or staff_users. Same filter as
-- 20260925120000: active, accepted accounts whose home branch is p_branch_id. The return type
-- changes, so the old function is dropped and recreated.
drop function if exists list_bookable_barbers(uuid);

create function list_bookable_barbers(p_branch_id uuid)
returns table (
  id uuid,
  staff_user_id uuid,
  home_branch_id uuid,
  status barber_status,
  display_name text
)
language sql stable security definer set search_path = public, pg_temp
as $$
  select b.id, b.staff_user_id, b.home_branch_id, b.status, su.name
  from barbers b
  join staff_users su on su.id = b.staff_user_id
  where b.home_branch_id = p_branch_id
    and su.is_active
    and su.invite_status = 'accepted'
  order by b.created_at;
$$;

revoke execute on function list_bookable_barbers(uuid) from public;
grant execute on function list_bookable_barbers(uuid) to anon, authenticated, service_role;
