-- Test support for the role/permission coverage guard: the public functions clients can call
-- (EXECUTE granted to authenticated or anon). Service role only.
create or replace function rbac_callable_functions()
returns table (name text)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select distinct p.proname::text
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public'
    and p.prokind = 'f'
    and p.proname <> 'rbac_callable_functions'
    and (has_function_privilege('authenticated', p.oid, 'EXECUTE')
         or has_function_privilege('anon', p.oid, 'EXECUTE'))
  order by 1;
$$;

revoke execute on function rbac_callable_functions() from public, anon, authenticated;
grant execute on function rbac_callable_functions() to service_role;
