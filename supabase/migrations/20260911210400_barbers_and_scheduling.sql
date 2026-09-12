-- Backend schema doc section 6 (plus barber_skills from section 5): barbers and everything that
-- schedules/scopes them. barbers.current_ticket_id (references queue_tickets) is added later, by
-- the queue_tickets migration, once that table exists.

create type barber_status as enum
  ('offline','scheduled','available','busy','on_break','temporarily_unavailable','end_of_shift');

create table barbers (
  id                 uuid primary key default gen_random_uuid(),
  staff_user_id      uuid not null unique references staff_users(id) on delete cascade,
  home_branch_id     uuid not null references branches(id),
  status             barber_status not null default 'offline',
  average_rating     numeric(3,2),
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);
create trigger trg_barbers_updated_at before update on barbers
  for each row execute function set_updated_at();

create table barber_skills (
  barber_id  uuid not null references barbers(id) on delete cascade,
  service_id uuid not null references services(id) on delete cascade,
  primary key (barber_id, service_id)
);

create table barber_schedule (
  id           uuid primary key default gen_random_uuid(),
  barber_id    uuid not null references barbers(id) on delete cascade,
  work_date    date not null,
  branch_id    uuid not null references branches(id),
  shift_start  time not null,
  shift_end    time not null,
  break_start  time,
  break_end    time,
  unique (barber_id, work_date)
);

create table barber_service_stats (
  barber_id             uuid not null references barbers(id) on delete cascade,
  service_id            uuid not null references services(id) on delete cascade,
  completed_count       integer not null default 0,
  avg_duration_seconds  integer,
  updated_at            timestamptz not null default now(),
  primary key (barber_id, service_id)
);

create table staff_branch_assignments (
  staff_user_id uuid not null references staff_users(id) on delete cascade,
  branch_id     uuid not null references branches(id) on delete cascade,
  primary key (staff_user_id, branch_id)
);
