-- Appointments: let the slot list ignore the caller's own appointment, so rescheduling can offer
-- other times on the same day (the one-appointment-per-day rule would otherwise block them all).
-- Only an appointment owned by the caller is ignored; any other id is treated as null.

drop function if exists list_appointment_slots(uuid, uuid, date);

create or replace function list_appointment_slots(
  p_branch_service_id uuid,
  p_barber_id uuid,
  p_date date,
  p_ignore_appointment_id uuid default null
) returns setof timestamptz
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_customer_id uuid;
  v_ignore uuid;
begin
  select id into v_customer_id from customers where auth_user_id = auth.uid();
  v_ignore := (
    select a.id from appointments a
    where a.id = p_ignore_appointment_id and a.customer_id = v_customer_id
  );
  return query
    select slot
    from generate_series(
      p_date::timestamp at time zone 'UTC',
      (p_date::timestamp + interval '23 hours 30 minutes') at time zone 'UTC',
      interval '30 minutes'
    ) as slot
    where appointment_slot_problem(p_branch_service_id, p_barber_id, slot, v_customer_id, v_ignore) is null
    order by slot;
end;
$$;

revoke execute on function list_appointment_slots(uuid, uuid, date, uuid) from public, anon;
grant execute on function list_appointment_slots(uuid, uuid, date, uuid) to authenticated;
