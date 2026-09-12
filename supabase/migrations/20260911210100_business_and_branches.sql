-- Backend schema doc section 4: business, branches, hours, closures, derived status view.
-- Created before identity/RBAC so customers.preferred_branch_id (section 2) has a table to reference.

create table businesses (
  id                uuid primary key default gen_random_uuid(),
  name              text not null,
  default_currency  text not null default 'GHS',
  default_policies  jsonb not null default '{}',
  created_at        timestamptz not null default now()
);
create unique index one_business_only on businesses ((true));

create type branch_status as enum ('open','closed','closing_soon','temporarily_closed');

create table branches (
  id                 uuid primary key default gen_random_uuid(),
  business_id        uuid not null references businesses(id),
  name               text not null,
  branch_code        text not null unique,
  address            text not null,
  latitude           numeric(9,6) not null,
  longitude          numeric(9,6) not null,
  phone_e164         text,
  geofence_radius_m  integer not null default 75,
  no_show_grace_minutes smallint not null default 2,
  max_queue_size     integer,
  is_temporarily_closed boolean not null default false,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);
create trigger trg_branches_updated_at before update on branches
  for each row execute function set_updated_at();

create table branch_hours (
  id          uuid primary key default gen_random_uuid(),
  branch_id   uuid not null references branches(id) on delete cascade,
  day_of_week smallint not null check (day_of_week between 0 and 6),
  opens_at    time,
  closes_at   time,
  is_closed   boolean not null default false,
  unique (branch_id, day_of_week)
);

create table branch_closures (
  id           uuid primary key default gen_random_uuid(),
  branch_id    uuid not null references branches(id) on delete cascade,
  closure_date date not null,
  reason       text,
  unique (branch_id, closure_date)
);

create view branch_status_view as
select
  b.id as branch_id,
  case
    when b.is_temporarily_closed then 'temporarily_closed'
    when bc.branch_id is not null then 'closed'
    when bh.is_closed or bh.id is null then 'closed'
    when now()::time between bh.opens_at and bh.closes_at - interval '30 minutes' then 'open'
    when now()::time between bh.closes_at - interval '30 minutes' and bh.closes_at then 'closing_soon'
    else 'closed'
  end::branch_status as status
from branches b
left join branch_closures bc on bc.branch_id = b.id and bc.closure_date = current_date
left join branch_hours bh on bh.branch_id = b.id and bh.day_of_week = extract(dow from now())::smallint;
