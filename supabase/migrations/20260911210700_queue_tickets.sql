-- Backend schema doc section 7: queue_tickets, the core record. Also adds
-- barbers.current_ticket_id here (deferred from the barbers_and_scheduling migration) now that
-- queue_tickets exists for it to reference.

create type ticket_state as enum
  ('created','waiting','almost_turn','called','confirmed','grace_period',
   'in_service','completed','no_show','cancelled');

create type check_in_method as enum ('app_tap','qr_code','staff','geofence');

create table branch_ticket_counters (
  branch_id   uuid not null references branches(id),
  ticket_date date not null,
  last_seq    integer not null default 0,
  primary key (branch_id, ticket_date)
);

create table queue_tickets (
  id                    uuid primary key default gen_random_uuid(),
  ticket_number         text not null unique,
  branch_id             uuid not null references branches(id),
  customer_id           uuid not null references customers(id),
  branch_service_id     uuid not null references branch_services(id),
  preferred_barber_id   uuid references barbers(id),
  assigned_barber_id    uuid references barbers(id),
  appointment_id        uuid references appointments(id),
  state                 ticket_state not null default 'created',
  position              integer,
  estimated_wait_low_min  integer,
  estimated_wait_high_min integer,
  is_pooled             boolean not null default false,
  is_stepped_out        boolean not null default false,
  stepped_out_at        timestamptz,
  check_in_method       check_in_method,
  checked_in_at         timestamptz,
  created_by            ticket_created_by not null,
  created_by_staff_id   uuid references staff_users(id),
  called_at             timestamptz,
  grace_period_expires_at timestamptz,
  confirmed_at          timestamptz,
  service_started_at    timestamptz,
  completed_at          timestamptz,
  no_show_at            timestamptz,
  cancelled_at          timestamptz,
  cancel_reason         cancel_reason,
  version               integer not null default 0,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now()
);
create trigger trg_queue_tickets_updated_at before update on queue_tickets
  for each row execute function set_updated_at();

create unique index one_active_ticket_per_customer_branch
  on queue_tickets (customer_id, branch_id)
  where state not in ('completed','cancelled','no_show');

create index idx_queue_tickets_branch_state on queue_tickets(branch_id, state);
create index idx_queue_tickets_barber_state on queue_tickets(assigned_barber_id, state);

alter table barbers add column current_ticket_id uuid references queue_tickets(id);
