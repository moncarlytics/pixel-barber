-- Backend schema doc section 12. Immutability is enforced at the grant level, not a trigger.
create table queue_events (
  id           uuid primary key default gen_random_uuid(),
  ticket_id    uuid not null references queue_tickets(id),
  event_type   text not null,
  actor_type   text not null check (actor_type in ('customer','staff','system')),
  actor_id     uuid,
  before_state jsonb,
  after_state  jsonb,
  metadata     jsonb not null default '{}',
  created_at   timestamptz not null default now()
);
create index idx_queue_events_ticket on queue_events(ticket_id, created_at);

revoke update, delete on queue_events from authenticated, anon;

create table audit_log (
  id               uuid primary key default gen_random_uuid(),
  actor_staff_id   uuid references staff_users(id),
  actor_type       text not null check (actor_type in ('staff','system')),
  action           text not null,
  entity_type      text not null,
  entity_id        uuid not null,
  before_value     jsonb,
  after_value      jsonb,
  result           text not null check (result in ('success','failure')),
  created_at       timestamptz not null default now()
);
create index idx_audit_log_entity on audit_log(entity_type, entity_id, created_at);

revoke update, delete on audit_log from authenticated, anon;
