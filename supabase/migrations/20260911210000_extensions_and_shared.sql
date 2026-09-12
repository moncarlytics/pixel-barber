-- Backend schema doc section 1: extensions and the shared set_updated_at() trigger function.
create extension if not exists pgcrypto;
create extension if not exists pg_cron;
create extension if not exists pg_net;

create or replace function set_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;
