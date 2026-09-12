-- Fixes a critical authorization gap in link_or_create_customer (20260912030000): the function
-- trusted a client-supplied p_phone_e164 parameter as if it were verified, letting any
-- authenticated user hijack another customer's walk-in record by passing a phone number they
-- don't own. The phone must come from the session's own JWT (populated only by a real Supabase
-- Auth OTP verification), never from client input -- so the parameter is dropped entirely rather
-- than merely validated, since keeping an unused/distrusted parameter around invites the same
-- mistake again.
drop function if exists link_or_create_customer(text, text);

create or replace function link_or_create_customer(p_name text)
returns customers
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_customer customers;
  v_verified_phone text;
begin
  if auth.uid() is null then
    raise exception 'authentication required';
  end if;

  v_verified_phone := auth.jwt()->>'phone';
  if v_verified_phone is null or v_verified_phone = '' then
    raise exception 'a verified phone number is required';
  end if;
  v_verified_phone := '+' || ltrim(v_verified_phone, '+');

  select * into v_customer from customers where auth_user_id = auth.uid();
  if found then
    return v_customer;
  end if;

  select * into v_customer from customers where phone_e164 = v_verified_phone and auth_user_id is null;
  if found then
    update customers
      set auth_user_id = auth.uid(), name = p_name, last_activity_at = now()
      where id = v_customer.id
      returning * into v_customer;
    return v_customer;
  end if;

  begin
    insert into customers (auth_user_id, name, phone_e164)
      values (auth.uid(), p_name, v_verified_phone)
      returning * into v_customer;
  exception when unique_violation then
    raise exception 'this phone number is already linked to another account';
  end;

  return v_customer;
end;
$$;

grant execute on function link_or_create_customer(text) to authenticated;
