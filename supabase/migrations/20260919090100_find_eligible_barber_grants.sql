-- Fix: revoke public/anon execute on find_eligible_barber and grant service_role
-- The previous migration did not explicitly revoke the default PostgreSQL execute grant
-- to public and anon, and did not grant service_role as specified in the brief.
revoke execute on function find_eligible_barber(uuid, uuid, uuid) from public, anon, authenticated;
grant execute on function find_eligible_barber(uuid, uuid, uuid) to authenticated, service_role;
