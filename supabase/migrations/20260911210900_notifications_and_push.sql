-- Backend schema doc section 10.
create type notification_channel as enum ('sms','push');
create type notification_recipient_type as enum ('customer','staff');
create type notification_status as enum ('pending','sent','delivered','failed','fallback_sent');

create table notifications (
  id              uuid primary key default gen_random_uuid(),
  recipient_type  notification_recipient_type not null,
  recipient_id    uuid not null,
  channel         notification_channel not null,
  notification_type text not null,
  related_ticket_id      uuid references queue_tickets(id),
  related_appointment_id uuid references appointments(id),
  payload         jsonb not null default '{}',
  status          notification_status not null default 'pending',
  failed_reason   text,
  sent_at         timestamptz,
  delivered_at    timestamptz,
  created_at      timestamptz not null default now()
);
create index idx_notifications_ticket on notifications(related_ticket_id);

-- recipient_id points at customers.id or staff_users.id depending on recipient_type; enforced by
-- trigger rather than a polymorphic two-nullable-FK-column workaround, per the doc's own note.
create or replace function check_notification_recipient() returns trigger
language plpgsql as $$
begin
  if new.recipient_type = 'customer' then
    if not exists (select 1 from customers where id = new.recipient_id) then
      raise exception 'recipient_id % does not exist in customers', new.recipient_id;
    end if;
  else
    if not exists (select 1 from staff_users where id = new.recipient_id) then
      raise exception 'recipient_id % does not exist in staff_users', new.recipient_id;
    end if;
  end if;
  return new;
end;
$$;
create trigger trg_notifications_check_recipient before insert or update on notifications
  for each row execute function check_notification_recipient();

create table push_subscriptions (
  id           uuid primary key default gen_random_uuid(),
  customer_id  uuid not null references customers(id) on delete cascade,
  endpoint     text not null unique,
  p256dh_key   text not null,
  auth_key     text not null,
  user_agent   text,
  created_at   timestamptz not null default now(),
  last_seen_at timestamptz not null default now()
);
