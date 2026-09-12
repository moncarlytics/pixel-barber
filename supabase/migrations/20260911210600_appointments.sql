-- Backend schema doc section 8. Created before queue_tickets so queue_tickets.appointment_id
-- (section 7) has a table to reference.

create type appointment_status as enum
  ('scheduled','checked_in','converted','completed','cancelled','no_show');

create type ticket_created_by as enum ('customer','staff','appointment_conversion');
create type cancel_reason as enum
  ('wait_too_long','cant_make_it','changed_plans','found_another_barber','emergency','other');

create table appointments (
  id                  uuid primary key default gen_random_uuid(),
  customer_id         uuid not null references customers(id),
  branch_id           uuid not null references branches(id),
  branch_service_id   uuid not null references branch_services(id),
  preferred_barber_id uuid references barbers(id),
  scheduled_start     timestamptz not null,
  scheduled_end       timestamptz not null,
  status              appointment_status not null default 'scheduled',
  created_by          ticket_created_by not null,
  created_by_staff_id uuid references staff_users(id),
  cancel_reason       cancel_reason,
  cancelled_at        timestamptz,
  version             integer not null default 0,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);
create trigger trg_appointments_updated_at before update on appointments
  for each row execute function set_updated_at();
create index idx_appointments_branch_time on appointments(branch_id, scheduled_start);
