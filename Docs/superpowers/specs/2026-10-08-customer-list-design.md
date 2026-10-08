# Design: Customer List and Message Customer

**Date:** 2026-10-08
**Status:** Approved in brainstorming, awaiting written-spec review
**Origin:** PRD sections 28 (Customer database / CRM), 32 (RBAC); App Flow 8.10 (Customers) and 8.11
(Message Customer); implementation plan Phase 8. Builds on the notification sender (push first, SMS
fallback — `Docs/superpowers/specs/2026-10-07-web-push-notifications-design.md`).

## Goal

Front-desk and management staff find any customer of their branches by name or phone, see their
visits, reliability, feedback and preferences at a glance, and send them a short service message
that arrives as a push notification (SMS backup once live).

## Current state

- `customers`: `name`, `phone_e164` (unique), `email`, `push_enabled`, `sms_backup_enabled`,
  `no_show_count`, `late_cancellation_count` (customer-wide totals), `requires_confirmation_call`,
  `is_anonymized`, `last_activity_at`.
- `consents` (`customer_id`, `consent_type` `transactional|marketing`, `granted`, `created_at`):
  the latest `marketing` row is the customer's "Send me promotions and offers" choice (Profile).
- `customer_segments` view (security invoker) defines groups: new (no completed visit), dormant
  (last visit > 90 days), at_risk (no-shows ≥ 3 or late cancellations ≥ 3), frequent (≥ 3 completed
  visits in 90 days), returning (else).
- RLS `customers_staff_scoped`: owner sees all; other staff see customers with a ticket at one of
  their branches.
- Capabilities: `message_customers` (owner, branch_manager, receptionist). Analyst and barber don't
  have it.
- `notifications` (`recipient_type`, `recipient_id`, `channel`, `notification_type`, `payload`,
  `status` `pending|sent|delivered|failed|fallback_sent`, `failed_reason`, `sent_at`); the
  `send-notifications` Edge Function claims pending `channel = 'sms'` rows of known types via
  `claim_sms_notifications` and delivers push first, SMS as fallback (SMS live sending is off until
  the Arkesel sender ID is approved; rows then end `failed` with reason `sms_disabled` or
  `not_allowlisted`).

## Decisions

1. **Who:** owner, branch manager, receptionist and analyst see the customer list for their
   branches (owner: all); only `message_customers` holders send messages; barbers see nothing.
2. **Messages:** individual service messages need no marketing permission; the compose box says
   they are for service messages, not promotions. Group promotions (broadcasts) are a later feature
   that will require marketing permission.
3. **Approach:** database functions for listing, detail and sending; the existing sender delivers.

## Section 1 — Access and the customer list

### Access and scope

- New capability `view_customers` ("View the customer list"), granted to owner, branch_manager,
  receptionist, analyst.
- **Scope:** a customer is visible when they have a ticket or appointment at one of the requested
  branches, every requested branch must be in the caller's scope (`in_branch_scope`), and
  anonymized customers are never shown. All numbers, groups and history count only tickets,
  appointments and feedback at the requested branches.
- **Phone masking:** callers with `message_customers` see the full number in local format
  (`0244123456`); others (analysts) see `024•••4567` (first three and last four digits of the local
  number).

### `list_customers(p_branch_ids uuid[], p_search text, p_group text, p_offset integer) returns jsonb`

- Requires `view_customers` and every branch in scope → else `not_allowed`; empty/null array →
  `not_allowed`.
- `p_search` (trimmed; null/empty = no filter): if it contains 3 or more digits, match customers
  whose phone digits contain the search digits (a leading `0` in the search is replaced by `233`);
  otherwise match `name` case-insensitively containing the text.
- `p_group`: null or one of `new`, `returning`, `frequent`, `lapsed`, `at_risk` → else
  `invalid_group`.
- Groups (in scope), checked in this order: **new** — no completed visit; **lapsed** — last
  completed visit more than 90 days ago; **at_risk** — 3 or more no-shows, or the customer's
  `late_cancellation_count` ≥ 3; **frequent** — 3 or more completed visits in the last 90 days;
  **returning** — everyone else.
- Ordered by last visit (most recent first, customers with no visit last), then name; 50 rows from
  `p_offset` (≥ 0, default 0).
- Returns `{ rows: [{ id, name, phone, last_visit_at, visits, no_shows, avg_rating_given, group }],
  has_more }` where `visits` = completed tickets, `no_shows` = no-show tickets,
  `avg_rating_given` = average `overall_rating` of their feedback (2 decimals, null if none).

### Customer list page (staff app `/customers`)

- Linked from the staff home page (`Customers`) for `view_customers` holders.
- Filters: Branch (branches in scope; owners also `All branches`), search box
  (`Search by name or phone`), Group (`All groups`, `New`, `Returning`, `Frequent`, `Lapsed`,
  `At risk`). Search applies when typing pauses (400 ms) or on Enter.
- Table columns: Name (links to the customer page), Phone, Last visit (`Tue 7 Oct`, `—` if none),
  Visits, No-shows, Average rating given (`4.50`, `—`), Group.
- `Show more` loads the next 50 when `has_more`.
- A short legend under the filters states the five group rules in plain words.
- Messages: no permission → `You don't have access to this page.`; load failure →
  `Couldn't load customers.`; no rows → `No customers match.`

## Section 2 — Customer page and messaging

### `customer_detail(p_customer_id uuid, p_branch_ids uuid[]) returns jsonb`

- Requires `view_customers` and every branch in scope → else `not_allowed`; customer not visible
  in those branches (or anonymized) → `not_found`.
- Returns:
  - `customer`: `id`, `name`, `phone` (masked as above), `email`, `requires_confirmation_call`,
    `push_enabled`, `sms_backup_enabled`, `marketing_allowed` (latest `marketing` consent's
    `granted`, false if none).
  - `stats`: `visits`, `last_visit_at`, `appointments` (appointments booked at those branches),
    `no_shows`, `cancellations` (cancelled tickets), `late_cancellations` (customer total),
    `avg_rating_given`, `visits_last_90_days`.
  - `group` and `group_reason` — one of the five groups and the facts behind it (e.g. `frequent`
    with `visits_last_90_days: 4`).
  - `visits`: newest 50 tickets at those branches — `ticket_id`, `created_at`, `branch_name`,
    `service_name`, `barber_name` (null if none), `state`, `cancel_reason`.
  - `feedback`: newest 20 — `created_at`, `branch_name`, `barber_name`, `overall_rating`,
    `comment`.
  - `messages`: newest 20 `staff_message` notifications to this customer from those branches —
    `id`, `created_at`, `branch_name`, `sent_by_name`, `text`, `status`, `failed_reason`.

### Customer page (staff app `/customers/[id]`)

- Branch context: the branch filter carried from the list (or all branches in scope).
- Sections: contact (name, phone, email); group with its reason (e.g. `Frequent: 4 visits in the
  last 90 days`); numbers (Visits, Last visit, Appointments, No-shows, Cancellations, Late
  cancellations, Average rating given); `Confirmation call before appointments: Yes|No` as plain
  data; settings (`App notifications: On|Off`, `SMS backup: On|Off`, `Promotions: Allowed|Not
  allowed`), read-only; Visit history (date, branch, service, barber, outcome — `Served`,
  `No-show`, `Cancelled (reason)`, or the live state); Feedback; Messages (date, branch, sent by,
  text, delivery label).
- Delivery labels: `pending` → `Sending`; `sent`, `delivered`, `fallback_sent` → `Delivered`;
  `failed` → `Not delivered` plus a plain reason (`sms_disabled`/`not_allowlisted`/no devices →
  `No app notifications or SMS available`; `expired` → `Expired`; anything else → `Failed`).
- No access / not found → `You don't have access to this page.` / `We couldn't find this
  customer.`; load failure → `Couldn't load this customer.`

### Message customer

- Shown only to `message_customers` holders: Branch picker (branches in scope where the customer
  is visible), a text box (max 140 characters, counter `{n} characters left`), the note `For service
  messages about a visit, not promotions.`, and `Send`.
- `send_customer_message(p_customer_id uuid, p_branch_id uuid, p_text text) returns uuid`
  (`authenticated`): requires `message_customers` and `in_branch_scope(p_branch_id)` → else
  `not_allowed`; customer not visible at that branch → `not_found`; text trimmed, empty →
  `empty_message`, longer than 140 → `message_too_long`; 5 or more `staff_message` notifications to
  this customer from this branch since the start of today (Ghana) → `daily_limit`. Inserts a
  notification `notification_type = 'staff_message'`, channel `sms`, recipient the customer,
  `payload = { text, branch_id, branch_name, sent_by_staff_id }`, and returns its id.
- Errors → copy: `empty_message` → `Write a message first.`; `message_too_long` → `Messages can be
  up to 140 characters.`; `daily_limit` → `This customer has had 5 messages from this branch
  today.`; anything else → `Couldn't send. Please try again.` After sending: `Message queued.` and
  the Messages list refreshes.

### Delivering `staff_message`

- `claim_sms_notifications` (dropped and recreated, as before) also returns the payload's `text`
  and `branch_name` for `staff_message` rows; `send-notifications` adds `staff_message` to its
  claimed types.
- Never stale (no ticket or appointment); the usual 10-minute expiry applies.
- Push: title `Pixel Barber · {branch}`, body the message text, tap URL `/`, urgency `normal`.
- SMS fallback: `Pixel Barber ({branch}): {text}`.

## Error handling

- Every new function: `security definer`, `set search_path = public, pg_temp`, explicit revoke/grant
  (`authenticated` only). Error codes: `not_allowed`, `not_found`, `invalid_group`,
  `empty_message`, `message_too_long`, `daily_limit`.
- Customers' own data access is unchanged (no new RLS policies; staff read only through the
  functions).

## Testing

- **DB (staging):** customers seeded across two branches (one customer at both): a manager sees only
  their branch's customers and in-branch counts; owner/analyst over both; search by name, by phone
  with and without the leading 0; each group rule; pagination (`has_more`); analysts get masked
  phones and are refused sending; barbers refused everything; detail sections and `not_found`
  outside scope; send rules (empty, too long, 6th message today) and the queued notification's
  payload; `invalid_group`.
- **Unit:** sender texts for `staff_message` (push and SMS) and never-stale rule; phone masking;
  delivery labels.
- **E2E:** a receptionist searches a customer by phone, opens their page, sees a visit in the
  history, sends a message, and sees it listed with a delivery label.

## Out of scope

Broadcasts to groups (needs the approved SMS sender ID and marketing consent checks); editing
customer details or preferences from the staff app; customer replies; merging duplicate customers;
exporting the customer list; the audit log viewer.
