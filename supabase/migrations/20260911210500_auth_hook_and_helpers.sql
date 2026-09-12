-- Backend schema doc section 3.2: the custom access token hook and the RLS helper functions
-- every policy in this migration set builds on.

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
  select id, role into v_staff from staff_users where auth_user_id = (event->>'user_id')::uuid;
  if found then
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

create or replace function auth_role() returns text
language sql stable as $$ select coalesce(auth.jwt()->>'app_role', 'anon') $$;

create or replace function auth_staff_id() returns uuid
language sql stable as $$ select nullif(auth.jwt()->>'staff_id','')::uuid $$;

create or replace function auth_branch_ids() returns uuid[]
language sql stable as $$
  select coalesce(array(select jsonb_array_elements_text(auth.jwt()->'branch_ids'))::uuid[], '{}')
$$;

create or replace function has_capability(cap text) returns boolean
language sql stable as $$
  select exists (
    select 1 from role_capabilities
    where capability = cap and role = auth_role()::staff_role
  )
$$;

create or replace function in_branch_scope(target_branch uuid) returns boolean
language sql stable as $$
  select auth_role() = 'owner' or target_branch = any(auth_branch_ids())
$$;

-- Grants required for the hook to be callable by the supabase_auth_admin role, and for the
-- Supabase dashboard's Auth Hooks setting (Authentication -> Hooks -> Custom Access Token) to
-- pick it up once wired there per section 3.2's note; this migration creates the function, the
-- dashboard/Management API wiring step is done separately per the implementation plan's phase 1
-- scope ("wired via the Supabase dashboard's Auth Hooks setting").
grant execute on function custom_access_token_hook(jsonb) to supabase_auth_admin;
revoke execute on function custom_access_token_hook(jsonb) from authenticated, anon, public;

grant usage on schema public to supabase_auth_admin;
grant select on staff_users, staff_branch_assignments to supabase_auth_admin;
