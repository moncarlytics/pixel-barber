# Design: Appointments, Part 3 — Reminders, Early Check-In, Real Wait Times

**Date:** 2026-10-02
**Status:** Approved in brainstorming, awaiting written-spec review
**Origin:** Implementation plan Phase 6, part 3 of 3 (part 1:
`Docs/superpowers/specs/2026-10-01-appointments-customer-booking-design.md`; part 2:
`Docs/superpowers/specs/2026-10-01-appointments-staff-side-design.md`; both live on staging and
production). PRD 14.3 (early arrival), 14.4 (queue/appointment interaction), 17 (wait estimate),
20 (appointment reminder trigger), 22 (check-in).

## Goal

Customers get reminder texts before their appointment; a customer who arrives early can tap
"I've arrived" and is served at once when their barber is free; and every waiting ticket shows a
real wait estimate that honestly includes appointments that will be served first.

## Discovery that shaped this

Wait estimates have never been computed. `queue_tickets.estimated_wait_low_min` /
`estimated_wait_high_min` exist and the customer ticket page and staff tickets page display them,
but nothing writes them, and `calculateWaitEstimate` in `packages/shared/src/wait-time.ts` is
exported but unused. "Honest wait times" therefore includes building wait estimates.

## Decisions

1. **Reminders: evening before + 1 hour before.** 18:00 the day before (only if the appointment
   already existed at that moment) and 1 hour before the slot (only if booked at least 1 hour
   ahead). Same-day bookings get only the 1-hour text.
2. **Early check-in: served early if the barber is free.** From 30 minutes before the slot the
   customer can tap "I've arrived". If their barber is free with nobody waiting, the appointment
   converts to a ticket now; otherwise it is `checked_in` and converts at its slot (part 2
   behaviour). Staff "Check in" uses the same rule.
3. **Walk-in buffer = honest wait times.** Booking rules are unchanged; walk-in estimates count
   appointments that will be served ahead of them.
4. **Approach: the database computes and stores estimates** on each ticket, refreshed on every
   queue change and every minute. (Browser-side calculation is impossible under RLS; on-demand RPCs
   would need per-ticket polling from the staff list.)

Times are UTC (= Ghana time), as everywhere else.

## Section 1 — Reminder texts

### Types and timing

Two new `notifications.notification_type` values, channel `sms`, recipient the customer,
`related_appointment_id` set, `related_ticket_id` null, `payload = {"slot": <scheduled_start ISO>}`:

| Type | Enqueue window | Only if |
|---|---|---|
| `appointment_reminder_day` | `[D−1 18:00, D−1 21:00)`, where `D` is the slot's UTC date | `created_at <= D−1 18:00` |
| `appointment_reminder_hour` | `[scheduled_start − 1h, scheduled_start)` | `created_at <= scheduled_start − 1h` |

Rules for `enqueue_appointment_reminders()`:

- Candidates: appointments with `status in ('scheduled','checked_in')` whose current `now()` falls in
  a type's window and that meet its "only if".
- One row per (appointment, type, slot): a partial unique index on
  `(related_appointment_id, notification_type, (payload->>'slot'))` where the type is one of the two
  reminder types; inserts use `on conflict do nothing`.
- A rescheduled appointment has a new `scheduled_start`, so it gets fresh reminders for its new slot
  under the same rules. (Rescheduling leaves `created_at` unchanged, so a moved appointment stays
  eligible.)

`enqueue_appointment_reminders()` is `SECURITY DEFINER`, `set search_path = public, pg_temp`,
service-role only. The existing every-minute cron job `activate-due-appointments` is re-pointed at
a wrapper `appointments_minute_tick()` that runs `activate_due_appointments()`,
`enqueue_appointment_reminders()` and `refresh_all_wait_estimates()` (Section 3), each in its own
`begin … exception` block (warning on failure) so one failing step cannot skip the others.

### Sending

- `claim_sms_notifications` is extended (same arguments; new output columns) to also return, for
  appointment rows: `appointment_id`, `appointment_status`, `appointment_slot` (`scheduled_start`),
  `payload_slot` (`payload->>'slot'`), and `branch_name` from the appointment's branch when there is
  no ticket.
- `notification-sms-core.ts`: the two types join `SMS_NOTIFICATION_TYPES`. A reminder is **stale**
  when the appointment's status is not `scheduled`/`checked_in` or `payload_slot` ≠ the
  appointment's current `scheduled_start`. Everything else in `decideNotification` applies
  unchanged: 10-minute expiry, SMS-backup opt-out, missing phone, allowlist, live switch.
- Texts (time in 12-hour format, e.g. `2:30 PM`):
  - Day: `Pixel Barber: Reminder, your appointment at {branch} is tomorrow at {time}.`
  - Hour: `Pixel Barber: Your appointment at {branch} is today at {time}, in about an hour.`
- Live sending stays off (`SMS_NOTIFICATIONS_LIVE` unset) until the Arkesel sender ID is approved;
  rows are recorded and skipped as `sms_disabled`, exactly like the queue texts.

## Section 2 — Early check-in ("I've arrived")

### Data

- `appointments.check_in_method check_in_method` (nullable) — set when checked in (`app_tap` for the
  customer, `staff` for staff). Conversion copies it to the ticket (replacing the hard-coded
  `'staff'` in `20261001090900`).

### Shared conversion

The per-appointment body of `activate_due_appointments()` (closure check, attach to an existing
active ticket, choose barber, create ticket, recalculate) moves into
`convert_appointment(p_appointment_id uuid, p_barber_id uuid default null) returns uuid` (the ticket
id, or null when it could not convert). `activate_due_appointments()` loops and calls it; slot-time
conversion behaves exactly as today (including expiry of slots already over, which stays in the
loop). When `p_barber_id` is given it is used instead of `find_eligible_barber`'s choice.

### Free barber

`free_barber_for_appointment(p_appointment_id uuid) returns uuid` — a barber who, right now:

- is on today's `barber_schedule` at the appointment's branch with `now()` inside the shift,
- has the service's skill,
- has `status = 'available'`,
- has no tickets at that branch in `waiting`, `almost_turn`, `called`, `confirmed`, `in_service` or
  `grace_period`;

restricted to the preferred barber when the appointment has one; for "any barber", the first such
barber by id. Null when none.

### Check-in functions

- **`check_in_my_appointment(p_appointment_id uuid) returns uuid`** (customer; `authenticated`):
  - Locks the appointment row; it must belong to the caller's customer record, else `not_found`.
  - `status <> 'scheduled'` → `too_late` (already checked in, converted, or finished).
  - `now() < scheduled_start − 30 min` → `too_early`.
  - Branch closed today (closure or temporarily closed) → `branch_closed`.
  - Sets `status = 'checked_in'`, `checked_in_at = now()`, `check_in_method = 'app_tap'`.
  - If `free_barber_for_appointment` returns a barber, calls `convert_appointment` with it and
    returns the ticket id; otherwise returns null.
- **`staff_check_in_appointment(uuid)`** (part 2) now **returns uuid** (drop and recreate, then
  re-grant as before): same checks as today (`edit_tickets` + branch scope, `scheduled` only, slot
  is today), sets `check_in_method = 'staff'`, then the same free-barber/convert step. Staff keep
  the "any time today" window.
- Existing active ticket at the branch: `convert_appointment` attaches the appointment to it (part 1
  rule); the returned id is that ticket.

Lock order matches the existing code: appointment row first, then whatever `convert_appointment` /
`recalculate_positions` take.

### Screens

- **Customer appointment detail** (`apps/customer/app/appointments/[id]/page.tsx`):
  - "I've arrived" button when `status = 'scheduled'` and now ≥ slot − 30 min (computed in the load
    effect, not in render).
  - Ticket id returned → navigate to `/tickets/{id}`.
  - Null → status shows "Checked in" and the line "You're checked in. We'll call you at {time}."
  - Errors map to messages: `too_early` → "You can check in from 30 minutes before your
    appointment."; `branch_closed`, `too_late` and anything else → the existing messages.
  - A `checked_in` appointment shows the same "We'll call you at {time}" line.
- **Staff appointment detail**: after Check in, a returned ticket id shows "Started early — now in
  the queue" with a link to the live queue (`/tickets`); null keeps today's behaviour.

## Section 3 — Real wait times

### Durations

`expected_duration_min(p_barber_id uuid, p_branch_service_id uuid)` returns `(minutes int,
historical boolean)`: the barber's `barber_service_stats.avg_duration_seconds / 60` (rounded) when
`completed_count >= 5` (historical), else `coalesce(branch_services.duration_minutes_override,
services.default_duration_minutes)` (not historical).

### Estimate per barber

`refresh_wait_estimates(p_branch_id uuid, p_barber_id uuid)` walks the barber's tickets in
`waiting`/`almost_turn` in `position` order, keeping a running total `T` (minutes from now) and a
flag "any non-historical duration so far":

1. Start: `T` = remaining time of the barber's `in_service` ticket (expected duration minus minutes
   since its `service_sessions.started_at`, floored at 0), or 0 if none. A ticket in
   `called`/`confirmed`/`grace_period` for this barber adds its full expected duration.
2. Before assigning each waiting ticket its estimate, add every not-yet-counted appointment for this
   barber with `status in ('scheduled','checked_in')` and `scheduled_start <= now() + T`, in start
   order, re-checking after each addition (each one pushes `T` later). "Any barber" appointments at
   the branch count with their duration ÷ the number of skilled barbers on shift at their slot time
   (minimum 1).
3. The ticket's estimate is `T`; then add the ticket's own expected duration to `T`.
4. Range: when every duration counted so far is historical → low = high = `round(T)`; otherwise
   low = `round(T × 0.8)`, high = `round(T × 1.2)` (the rule from `calculateWaitEstimate`).
5. Update `estimated_wait_low_min` / `estimated_wait_high_min` only where they differ
   (`is distinct from`), so realtime subscribers are not woken needlessly.

Tickets in other states, and pooled tickets (`assigned_barber_id is null`), get null estimates.

### When it runs

- At the end of `recalculate_positions(branch, barber)` when `p_barber_id` is not null (covers join,
  call, complete, cancel, no-show and conversion).
- `refresh_all_wait_estimates()` every minute (via `appointments_minute_tick()`): every
  (branch, barber) pair with at least one `waiting`/`almost_turn` ticket.

### Join Now preview

`preview_wait_estimate(p_branch_service_id uuid, p_barber_id uuid)` returns `(low_min int,
high_min int)` (`authenticated`): the estimate a new ticket would get at the end of that barber's
line, using the same walk. The Join Now review step in `BookFlow.tsx` shows
"Estimated wait: {low}–{high} min" (or "{low} min" when equal) for the chosen barber, or for
`find_eligible_barber`'s fallback when "any available". Hidden if the call fails.

### Cleanup

`packages/shared/src/wait-time.ts`, its test and its export are removed (the SQL is now the single
implementation).

## Error handling

- Every new function is `SECURITY DEFINER`, `set search_path = public, pg_temp`, with explicit
  revoke/grant: customer and staff functions to `authenticated`; tick, enqueue and refresh functions
  to `service_role` only; `convert_appointment`, `free_barber_for_appointment` and
  `expected_duration_min` revoked from `public, anon, authenticated`.
- The minute tick isolates each step; a failing step logs a warning and the rest still run.
- Customer/staff errors are raised as short codes and mapped to messages in the existing mappers
  (`appointmentErrors.ts`, `staffAppointmentErrors.ts`).

## Testing

- **DB (vitest, staging):**
  - Reminders: day reminder enqueued in its window and not for an appointment created after 18:00;
    hour reminder; none for cancelled; reschedule produces new rows and the old-slot row is skipped
    as stale; no duplicates on repeated ticks.
  - Sender core (unit): stale/send decisions for reminder rows; text formatting.
  - Check-in: too early; free barber → converts and returns the ticket; busy barber → `checked_in`
    and null; existing ticket → attached; staff check-in returns a ticket when free;
    `check_in_method` reaches the ticket.
  - Wait estimates: single-barber queue; in-service remainder; an appointment inside the window adds
    time, one outside does not; historical vs set-duration ranges; the preview matches the next
    ticket's estimate.
- **e2e (Playwright):** customer taps "I've arrived" with a free barber and lands on the ticket
  page; with a busy barber sees "checked in"; a joined ticket shows "Estimated wait".

## Out of scope

Push notifications (SMS only); QR / geofence check-in; booking caps per barber; configurable
reminder times per branch; wait estimates for pooled tickets.
