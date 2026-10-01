# Design: Appointments, Part 1 — Customer Booking and Automatic Conversion

**Date:** 2026-10-01
**Status:** Approved in brainstorming, awaiting written-spec review
**Origin:** Implementation plan Phase 6 ("Appointments"). The `appointments` table, its RLS and a
placeholder `activate-due-appointments` cron job exist from Phase 1, but nothing books, shows or
converts appointments. Phase 6 is split in three; this is part 1.

| Part | Scope |
|---|---|
| **1 (this spec)** | Customer books a date/time slot, sees it under Upcoming, reschedules or cancels it; at its start time it becomes a normal queue ticket with priority; late arrivals use the existing no-show flow |
| 2 | Staff: Appointments Calendar (App Flow 8.7), staff Appointment Detail with reschedule / cancel / mark no-show / manual check-in (8.8), booking on a customer's behalf |
| 3 | Appointment reminder texts; early check-in; reserving walk-in capacity around appointments (PRD 14.4's buffer) |

## Goal

A signed-in customer can book an appointment for a specific branch, service and barber (or "any
barber") at an open time slot, manage it until 1 hour before, and at the start time it
automatically becomes a live, trackable ticket that is served next — with no manual staff action.

## Decisions

1. **Priority at conversion: "next in line."** At its start time an appointment ticket goes ahead of
   waiting walk-ins but never ahead of a ticket already called to the chair. Queue order becomes:
   (1) called ticket, (2) appointment tickets by `scheduled_start`, (3) everyone else in the
   existing order.
2. **Booking rules ("standard set"):** 30-minute slot grid; book up to 14 days ahead and at least
   1 hour ahead; cancel or reschedule up to 1 hour before the start; one active appointment per
   customer per calendar day.
3. **Approach A: database functions.** Slot listing, booking, cancel, reschedule and conversion are
   `SECURITY DEFINER` Postgres functions with `set search_path = public, pg_temp` (the same pattern
   as `find_eligible_barber` and `set_barber_weekly_hours`). Booking checks and inserts in one
   transaction under a lock, so two customers can never take the same slot.
4. **Conversion at the start time, not before.** The current placeholder converts 5 minutes early;
   that could call (and no-show) a customer before their own slot, so conversion moves to
   `scheduled_start <= now()`.
5. **Times are Ghana time = UTC.** Ghana is UTC+0 with no daylight saving, so branch hours, barber
   shifts and slot times are compared directly in UTC (the same convention `branch_status_view`
   already uses).

## Section 1 — Booking a slot

### Customer flow (App Flow 7.5)

- The Book screen gains a **Join Now / Schedule** toggle. Branch, service and barber steps are
  shared; **Schedule** adds a **Date & Time** step, then its own **Review & Confirm**.
- **Date & Time:** the next 14 days as selectable dates; for the chosen date, the open 30-minute
  slots. On confirm, an **Appointment Confirmation** screen, then the customer's Upcoming list.
- Signed-out customers are sent to `/login` with `next` set back to the booking page (the existing
  `sessionEndedLoginPath`).

### `list_appointment_slots(p_branch_service_id uuid, p_barber_id uuid, p_date date)`

Returns `slot_start timestamptz` rows. `p_barber_id` null = "any barber". Callable by
`authenticated`. A candidate slot starts on the 30-minute grid; its end is start + the service's
duration (`branch_services.duration_minutes_override`, else `services.default_duration_minutes`).
A slot is open only if **all** hold:

- `slot_start >= now() + 1 hour` and `p_date <= current_date + 14`;
- the branch is open for the whole `[start, end)`: a non-closed `branch_hours` row for that weekday
  covering it, no `branch_closures` row for the date, and — for today's slots only, since it is a
  live flag rather than a future plan — `branches.is_temporarily_closed` is false;
- the branch service is active;
- **specific barber:** the barber's staff account is active with `invite_status = 'accepted'`, they
  are skilled for the service (`barber_skills`), they have a `barber_schedule` row for the date **at
  this branch** whose shift covers `[start, end)` and whose break (if any) does not overlap it, and
  they have no active appointment (`status in ('scheduled','converted')`) overlapping it;
- **any barber:** at least one suitable barber is left unreserved — the number of barbers who pass
  the specific-barber checks (other than appointments naming them) exceeds the number of
  overlapping active "any barber" appointments at this branch service's branch plus the overlapping
  active appointments that name one of those barbers;
- the calling customer has no other `scheduled` appointment on that date.

### `book_appointment(p_branch_service_id uuid, p_barber_id uuid, p_slot_start timestamptz)`

Callable by `authenticated`; resolves the caller's `customers` row (none → `not_a_customer`). In one
transaction: takes a transaction-level advisory lock keyed on the branch, re-checks every slot rule
above for exactly this slot, and inserts the `appointments` row (`status = 'scheduled'`,
`created_by = 'customer'`, `scheduled_end` from the service duration). Returns the new appointment
id. Failures raise a specific error the app maps to plain words: `slot_taken`,
`already_booked_that_day`, `branch_closed`, `too_soon`, `too_far_ahead`, `not_a_customer`.

### Access

- Customers keep `select` on their own appointments (existing `appointments_customer_own`).
- Direct customer `insert` / `update` is removed (drop `appointments_customer_create` and
  `appointments_customer_update_own`); every customer write goes through the functions, so the rules
  can't be bypassed. The staff policy is left for part 2.

## Section 2 — At the appointment time

### `activate_due_appointments()` (replaces the placeholder job body)

Runs every minute under the same job name (`cron.schedule('activate-due-appointments',
'* * * * *', 'select activate_due_appointments()')`). For each appointment with
`status = 'scheduled' and scheduled_start <= now()`, locked `for update skip locked`:

- **Branch closed** (a `branch_closures` row for today, or `branches.is_temporarily_closed`): the
  appointment becomes `cancelled` with `cancel_reason = 'branch_closed'` (a new `cancel_reason`
  enum value) and `cancelled_at = now()`; no ticket.
- **Otherwise:** insert a `queue_tickets` row (`ticket_number = next_ticket_number(branch)`, the
  customer, branch, branch service, `appointment_id`, `created_by = 'appointment_conversion'`,
  `state = 'waiting'`). Barber:
  - preferred barber's account still active and accepted, and the barber not `offline` →
    `assigned_barber_id` = that barber;
  - otherwise (any barber, or the preferred barber is offline/deactivated) → pooled
    (`is_pooled = true`, no assigned barber), so the first suitable free barber takes it.
- Write a `queue_events` row (`event_type = 'created'`, `actor_type = 'system'`, `after_state`
  carrying the appointment id), set the appointment to `converted`, and call `recalculate_positions`
  for the affected barber / pool.

### Queue priority

`recalculate_positions` (latest definition `20260925130000_youre_next_notifications.sql`) orders
tickets by: called ticket first, then tickets with a non-null `appointment_id` by their
appointment's `scheduled_start`, then the existing order (`coalesce(skipped_at, '-infinity'),
created_at`). Everything else in it — promotion to `called`, `almost_turn`, the `your_turn` /
`youre_next` notifications, the reentrancy guard — is unchanged, so appointment customers get the
same texts as everyone else.

### Late or absent

An appointment ticket is called like any other. If the customer doesn't confirm, the existing
grace-period → `no_show` path runs unchanged (one no-show state machine, PRD 21). When a ticket with
an `appointment_id` becomes `no_show`, its appointment becomes `no_show`; when it becomes
`completed`, its appointment becomes `completed`.

## Section 3 — Managing appointments

### Upcoming (App Flow 7.4) and Appointment Detail (7.8)

- The customer's `/tickets` page gains an **Upcoming** section: future `scheduled` appointments by
  date (date, time, branch, service, barber or "Any available"). Empty state: a message plus
  "Book an appointment".
- **Appointment Detail** (`/appointments/[id]`): date, time, branch, barber, service and current
  price, with **Cancel** (reuses the existing cancellation reasons) and **Reschedule** (reopens Date
  & Time with branch, service and barber pre-filled).
- Within 1 hour of the start (or once converted or cancelled), the actions are replaced by "Too late
  to change online — please contact the branch."

### `cancel_appointment(p_appointment_id uuid, p_reason cancel_reason)` and `reschedule_appointment(p_appointment_id uuid, p_slot_start timestamptz)`

Both callable by `authenticated`, only for the caller's own appointment, only while `scheduled` and
more than 1 hour before its start (`too_late` otherwise). Reschedule takes the same advisory lock and
re-checks every slot rule for the new slot (ignoring the appointment being moved), then updates it in
place — the old slot is only freed once the new one is secured. Both bump `version`.

### Errors

Plain messages per error: "That time was just taken — please pick another" (with the slot list
refreshed), "You already have an appointment that day", "This branch is closed then", "Too late to
change this appointment", and "Something went wrong — please try again" for anything else. Nothing
is half-saved: every write is a single function call in one transaction.

## Testing

- **DB (`tests/db/`):** slot listing honours hours, closures, shift, break, skill, overlaps, the
  1-hour and 14-day limits and one-per-day; "any barber" capacity; double booking is refused
  (`slot_taken`); cancel and reschedule rules including `too_late`; customers can't insert or update
  appointments directly or touch someone else's.
- **Conversion (`tests/db/`):** a due appointment becomes a ticket with a `queue_events` row and
  status `converted`; it ranks ahead of waiting walk-ins and behind a called ticket; a branch-closed
  appointment becomes `cancelled` / `branch_closed`; a converted ticket that goes `no_show` marks
  its appointment `no_show`; completion marks it `completed`.
- **E2E (`e2e/`):** book a slot through Schedule, see it under Upcoming, reschedule it, cancel it.

## Out of scope (parts 2 and 3, or later)

Staff calendar, staff detail actions and booking on a customer's behalf (part 2); reminder texts,
early check-in and walk-in buffer (part 3); appointment SMS confirmations; per-branch configurable
rules (the standard set is fixed for now); deposits or payment.
