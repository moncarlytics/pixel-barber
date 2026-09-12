-- Fixes two Phase 1 issues found during the pre-auth-wiring review, before any customer or staff
-- session exists yet to have hit them:
--
-- 1. has_capability() cast `role = auth_role()::staff_role`, but auth_role() returns 'customer' or
--    'anon' for non-staff sessions -- neither is a valid staff_role enum value, so the cast raises
--    "invalid input value for enum staff_role" rather than evaluating to false. Any RLS policy that
--    OR's a staff-capability check against a customer-owned check on the same table (queue_tickets,
--    appointments, feedback, service_sessions) would error for a logged-in customer the moment
--    Postgres evaluates that qual, which breaks Phase 1's own walking-skeleton requirement.
-- 2. role_capabilities only gave analyst `view_branch_reports`; backend-schema section 3.1 is
--    explicit that "Analyst gets every view_* capability."
create or replace function has_capability(cap text) returns boolean
language sql stable
set search_path = public, pg_temp
as $$
  select exists (
    select 1 from role_capabilities
    where capability = cap and role::text = auth_role()
  )
$$;

insert into role_capabilities (role, capability) values
  ('analyst', 'view_business_reports'),
  ('analyst', 'view_audit_log')
on conflict do nothing;

-- Phase 1's onboarding walking skeleton (App Flow section 5, steps 1-3) needs a way for a
-- freshly-OTP-verified customer to create or link their own `customers` row. No RLS insert policy
-- exists for this (customers_staff_register_walkin is staff-only), and backend-schema section 2
-- specifies phone-matched linking (UPDATE an existing walk-in-created row when one exists, INSERT
-- otherwise) rather than an unconditional insert, which a plain client-side insert can't express
-- safely under RLS anyway -- hence a security definer RPC instead of a new RLS policy.
create or replace function link_or_create_customer(p_name text, p_phone_e164 text)
returns customers
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_customer customers;
begin
  if auth.uid() is null then
    raise exception 'authentication required';
  end if;

  select * into v_customer from customers where auth_user_id = auth.uid();
  if found then
    return v_customer;
  end if;

  select * into v_customer from customers where phone_e164 = p_phone_e164 and auth_user_id is null;
  if found then
    update customers
      set auth_user_id = auth.uid(), name = p_name, last_activity_at = now()
      where id = v_customer.id
      returning * into v_customer;
    return v_customer;
  end if;

  insert into customers (auth_user_id, name, phone_e164)
    values (auth.uid(), p_name, p_phone_e164)
    returning * into v_customer;
  return v_customer;
end;
$$;

grant execute on function link_or_create_customer(text, text) to authenticated;
