-- Backend schema doc section 5: services, branch-service linkage, effective-dated pricing.
-- barber_skills (also section 5) is deferred to the barbers_and_scheduling migration since it
-- references barbers(id), which doesn't exist until that migration.

create table services (
  id                      uuid primary key default gen_random_uuid(),
  business_id             uuid not null references businesses(id),
  name                    text not null,
  description             text,
  category                text,
  default_duration_minutes smallint not null,
  image_url               text,
  is_active               boolean not null default true,
  created_at              timestamptz not null default now(),
  updated_at              timestamptz not null default now()
);
create trigger trg_services_updated_at before update on services
  for each row execute function set_updated_at();

create table branch_services (
  id                       uuid primary key default gen_random_uuid(),
  branch_id                uuid not null references branches(id) on delete cascade,
  service_id               uuid not null references services(id),
  duration_minutes_override smallint,
  is_active                boolean not null default true,
  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now(),
  unique (branch_id, service_id)
);
create trigger trg_branch_services_updated_at before update on branch_services
  for each row execute function set_updated_at();

create table branch_service_prices (
  id                uuid primary key default gen_random_uuid(),
  branch_service_id uuid not null references branch_services(id) on delete cascade,
  price_ghs         numeric(10,2) not null check (price_ghs >= 0),
  is_promo          boolean not null default false,
  effective_from    date not null,
  effective_until   date,
  created_at        timestamptz not null default now()
);
create index idx_branch_service_prices_lookup
  on branch_service_prices(branch_service_id, effective_from desc);

create view current_branch_service_price as
select distinct on (branch_service_id)
  branch_service_id, price_ghs, is_promo
from branch_service_prices
where effective_from <= current_date
  and (effective_until is null or effective_until >= current_date)
order by branch_service_id, is_promo desc, effective_from desc;
