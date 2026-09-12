-- Backend schema doc section 9.
create table service_sessions (
  id                     uuid primary key default gen_random_uuid(),
  ticket_id              uuid not null unique references queue_tickets(id),
  barber_id              uuid not null references barbers(id),
  started_at             timestamptz not null,
  ended_at               timestamptz,
  actual_duration_seconds integer generated always as
    (case when ended_at is not null then extract(epoch from (ended_at - started_at))::integer end) stored,
  created_at             timestamptz not null default now()
);
