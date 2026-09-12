-- Backend schema doc sections 2, 3.1, 3.4: customer/staff profile tables, capabilities table,
-- role_capabilities table, and the staff-invite columns (folded into the initial create table
-- rather than a later alter, since this is a fresh schema with no existing staff_users rows yet).

create table customers (
  id                          uuid primary key default gen_random_uuid(),
  auth_user_id                uuid unique references auth.users(id) on delete set null,
  name                        text not null,
  phone_e164                  text unique,
  email                       text,
  avatar_key                  text,
  preferred_branch_id         uuid references branches(id),
  push_lead_minutes_primary   smallint not null default 10,
  push_lead_minutes_secondary smallint not null default 5,
  push_enabled                boolean not null default true,
  sms_backup_enabled          boolean not null default true,
  no_show_count               integer not null default 0,
  late_cancellation_count     integer not null default 0,
  requires_confirmation_call  boolean not null default false,
  is_anonymized               boolean not null default false,
  anonymized_at               timestamptz,
  last_activity_at            timestamptz not null default now(),
  created_at                  timestamptz not null default now(),
  updated_at                  timestamptz not null default now()
);
create trigger trg_customers_updated_at before update on customers
  for each row execute function set_updated_at();
create index idx_customers_last_activity on customers(last_activity_at) where is_anonymized = false;

create type staff_role as enum ('owner','branch_manager','receptionist','barber','analyst');
create type staff_invite_status as enum ('pending','accepted','revoked','expired');

create table staff_users (
  id                    uuid primary key default gen_random_uuid(),
  auth_user_id          uuid not null unique references auth.users(id) on delete restrict,
  name                  text not null,
  phone_e164            text unique,
  email                 text unique,
  role                  staff_role not null,
  pin_hash              text,
  is_active             boolean not null default true,
  invite_status         staff_invite_status not null default 'accepted',
  invited_by_staff_id   uuid references staff_users(id),
  invited_at            timestamptz,
  invite_accepted_at    timestamptz,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now()
);
create trigger trg_staff_users_updated_at before update on staff_users
  for each row execute function set_updated_at();
create index idx_staff_users_invite_status on staff_users(invite_status) where invite_status = 'pending';

create table capabilities (
  key         text primary key,
  description text not null
);

create table role_capabilities (
  role       staff_role not null,
  capability text not null references capabilities(key),
  primary key (role, capability)
);

insert into capabilities (key, description) values
  ('manage_branches',          'Create and configure branches (business-wide)'),
  ('manage_staff',             'Create, invite, and manage staff accounts (business-wide)'),
  ('edit_pricing',             'Edit service pricing'),
  ('edit_hours',               'Edit branch hours and closures'),
  ('view_business_reports',    'View business-wide reports and the business-wide dashboard'),
  ('view_branch_reports',      'View reports scoped to assigned branch(es)'),
  ('manage_barber_schedules',  'Manage barber shift schedules'),
  ('handle_escalations',       'Handle no-show and low-rating escalations'),
  ('register_walkins',         'Register a walk-in customer and ticket'),
  ('edit_tickets',             'Edit an in-progress queue ticket'),
  ('cancel_tickets',           'Cancel a queue ticket'),
  ('check_in_customers',       'Manually check in a customer'),
  ('message_customers',        'Message an individual customer'),
  ('broadcast_messages',       'Send a segment broadcast message'),
  ('manage_own_queue',         'A barber acknowledging/flagging/completing their own current ticket only'),
  ('view_audit_log',           'View the administrative audit log');

-- Mapping below follows PRD section 32's role table as closely as its prose permits; the PRD
-- itself only specifies capabilities at the product-feature level (leaving the exact key-to-role
-- matrix to implementation), so this is this migration's concrete interpretation of that table:
-- Owner = every capability except manage_own_queue (which is meaningless without a barbers row,
-- and section 3.1 of the backend schema doc gives "Barber gets only manage_own_queue" as its own
-- explicit example); Branch Manager = everything PRD 32 states plus the day-to-day ticket
-- operations an escalation-handling manager needs; Receptionist/Barber/Analyst map directly.
insert into role_capabilities (role, capability) values
  ('owner', 'manage_branches'),
  ('owner', 'manage_staff'),
  ('owner', 'edit_pricing'),
  ('owner', 'edit_hours'),
  ('owner', 'view_business_reports'),
  ('owner', 'view_branch_reports'),
  ('owner', 'manage_barber_schedules'),
  ('owner', 'handle_escalations'),
  ('owner', 'register_walkins'),
  ('owner', 'edit_tickets'),
  ('owner', 'cancel_tickets'),
  ('owner', 'check_in_customers'),
  ('owner', 'message_customers'),
  ('owner', 'broadcast_messages'),
  ('owner', 'view_audit_log'),

  ('branch_manager', 'edit_pricing'),
  ('branch_manager', 'edit_hours'),
  ('branch_manager', 'view_branch_reports'),
  ('branch_manager', 'manage_barber_schedules'),
  ('branch_manager', 'handle_escalations'),
  ('branch_manager', 'message_customers'),
  ('branch_manager', 'broadcast_messages'),
  ('branch_manager', 'register_walkins'),
  ('branch_manager', 'edit_tickets'),
  ('branch_manager', 'cancel_tickets'),
  ('branch_manager', 'check_in_customers'),

  ('receptionist', 'register_walkins'),
  ('receptionist', 'edit_tickets'),
  ('receptionist', 'cancel_tickets'),
  ('receptionist', 'check_in_customers'),
  ('receptionist', 'message_customers'),

  ('barber', 'manage_own_queue'),

  ('analyst', 'view_branch_reports');
