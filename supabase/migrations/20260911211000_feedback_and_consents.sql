-- Backend schema doc section 11.
create table feedback (
  id                          uuid primary key default gen_random_uuid(),
  ticket_id                   uuid not null unique references queue_tickets(id),
  customer_id                 uuid not null references customers(id),
  branch_id                   uuid not null references branches(id),
  barber_id                   uuid not null references barbers(id),
  overall_rating              smallint not null check (overall_rating between 1 and 5),
  service_quality_rating      smallint check (service_quality_rating between 1 and 5),
  barber_professionalism_rating smallint check (barber_professionalism_rating between 1 and 5),
  waiting_experience_rating   smallint check (waiting_experience_rating between 1 and 5),
  cleanliness_rating          smallint check (cleanliness_rating between 1 and 5),
  value_rating                smallint check (value_rating between 1 and 5),
  comment                     text,
  gemini_themes               text[],
  gemini_processed_at         timestamptz,
  created_at                  timestamptz not null default now()
);
create index idx_feedback_low_rating on feedback(branch_id) where overall_rating < 3;

create type consent_type as enum ('transactional','marketing');

create table consents (
  id            uuid primary key default gen_random_uuid(),
  customer_id   uuid not null references customers(id),
  consent_type  consent_type not null,
  granted       boolean not null,
  source        text not null,
  created_at    timestamptz not null default now()
);
create index idx_consents_customer_type on consents(customer_id, consent_type, created_at desc);
