# Design: Appointments, Part 2 — Staff Side

**Date:** 2026-10-01
**Status:** Approved in brainstorming, awaiting written-spec review
**Origin:** Implementation plan Phase 6, part 2 of 3 (part 1:
`Docs/superpowers/specs/2026-10-01-appointments-customer-booking-design.md`, live on staging and
production). Customers can book, but staff can't see or manage appointments until they become
tickets. App Flow 8.7 (Appointments Calendar) and 8.8 (staff Appointment Detail).

## Goal

Owners, Branch Managers and Receptionists see each day's appointments for the branches they manage,
book on a customer's behalf, and check in, reschedule, cancel or mark no-show — with the same
"can't double-book a barber" guarantees as customer booking. Barbers see their own appointments for
today, read-only.

## Decisions

1. **Early arrival = mark arrived, wait for the slot.** "Check in" sets the appointment to
   `checked_in`; it still converts at its start time (next in line, part 1 rules), and the ticket it
   becomes records the customer as already present.
2. **Staff limits are looser:** staff may book or reschedule any open slot whose start is **now or
   later** (no 1-hour minimum) and cancel any appointment that hasn't become a ticket. Everything
   else still applies: 14-day horizon, one active appointment per customer per day, branch hours and
   closures, barber shift/break/skill, no double-booking, "any barber" capacity.
3. **Barbers see their own appointments today, read-only** (time + customer first name) on Today's
   Queue.
4. **Approach A: database functions.** Every staff read and write goes through `SECURITY DEFINER`
   functions (`set search_path = public, pg_temp`) that check the caller's capability and branch
   scope, reusing part 1's rule-checker. Direct staff writes to `appointments` are closed.

## Who

- **Managers of appointments:** callers with capability `edit_tickets` (owner, branch_manager,
  receptionist) and `in_branch_scope(branch_id)` for the appointment's branch. Owners are in scope for
  every branch.
- **Barbers:** only their own appointments for today, via a dedicated read function.
- **Customers:** unchanged from part 1 (their own, through the part 1 functions).

## Section 1 — Screens

### Appointments Calendar (staff app, new page `/appointments`)

- Linked from the staff home page as "Appointments".
- **Day view** for one branch: branch picker (branches the caller manages), Previous day / Today /
  Next day, and a barber filter (All / each barber / Any barber).
- One row per appointment that day, ordered by start time: time (HH:MM, Ghana time = UTC), customer
  name, service, barber display name or "Any barber", status label (Booked, Checked in, In the queue,
  Done, Cancelled, No-show).
- **Book for a customer** button (Section 2). Empty day: "No appointments on this day."

### Staff Appointment Detail (`/appointments/[id]`)

- Date, time, branch, service, price, barber, status, customer name and phone, and who booked it
  (the customer, or the staff member's name).
- Actions while `scheduled` or `checked_in` (not yet converted):
  - **Check in** (only while `scheduled`): status → `checked_in`.
  - **Reschedule:** the part 1 slot picker for the same branch service and barber, with staff limits
    and the appointment itself ignored.
  - **Cancel:** the customer cancel reasons (not `branch_closed`).
  - **Mark no-show:** only once `scheduled_start <= now()`: status → `no_show`, so it never converts.
- Once `converted`: "Now in the queue" with a link to the Live Queue (`/tickets`); no appointment
  actions. Terminal statuses (completed, cancelled, no_show) show no actions.

### Barber "Today's appointments" (Today's Queue `/queue/today`)

A read-only list under the queue: today's `scheduled` / `checked_in` appointments naming this barber,
by time — time and customer first name. Hidden when empty.

## Section 2 — Booking for a customer

From the calendar:

1. **Customer:** phone (optional, Ghana number, normalised like walk-ins) and name. A customer with
   that `phone_e164` is reused; otherwise a new `customers` row is created (no auth account), exactly
   like `tickets-walk-in`. No phone → always a new customer.
2. **Service** (the branch's active services) and **barber** (bookable barbers by name, or any).
3. **Date & time:** the part 1 slot picker, fed by the staff slot list (staff limits).
4. **Confirm:** creates the appointment with `created_by = 'staff'` and `created_by_staff_id` = the
   caller, then opens its staff detail.

## Section 3 — Database

### Rule-checker with a staff mode

`appointment_slot_problem` gains a lead-time parameter: customers keep the 1-hour minimum; staff
calls use zero (slot start must be `>= now()`). Implemented as a new 6-argument
`appointment_slot_problem(p_branch_service_id, p_barber_id, p_slot_start, p_customer_id,
p_ignore_appointment_id, p_min_lead interval)`; the existing 5-argument function becomes a thin
wrapper passing `interval '1 hour'`, so part 1 callers are unchanged. The `checked_in` status counts
as active everywhere `scheduled` does (one-per-day, overlaps, capacity).

### Staff functions

All `SECURITY DEFINER`, `set search_path = public, pg_temp`, granted to `authenticated` only; each
write re-checks `has_capability('edit_tickets') and in_branch_scope(<appointment's branch>)` and
raises `not_allowed` otherwise.

| Function | Does |
|---|---|
| `list_branch_appointments(p_branch_id uuid, p_date date)` | Rows for that branch and UTC date: appointment id, start/end, status, customer name + phone, service name, preferred barber id + display name, created_by, created-by staff name, linked ticket id (if converted) |
| `staff_list_appointment_slots(p_branch_service_id uuid, p_barber_id uuid, p_date date, p_customer_id uuid, p_ignore_appointment_id uuid default null)` | Open slots with staff limits (one-per-day checked for `p_customer_id` when given) |
| `staff_book_appointment(p_branch_service_id uuid, p_barber_id uuid, p_slot_start timestamptz, p_customer_name text, p_customer_phone text)` | Find-or-create customer by phone (null phone → new), lock (branch, then customer), re-check with staff limits, insert (`created_by='staff'`, `created_by_staff_id`), return id |
| `staff_reschedule_appointment(p_appointment_id uuid, p_slot_start timestamptz)` | While `scheduled`/`checked_in`: same locks, re-check ignoring itself, move; `version + 1` |
| `staff_cancel_appointment(p_appointment_id uuid, p_reason cancel_reason)` | While `scheduled`/`checked_in` (any time): cancel; `branch_closed` → `not_allowed` |
| `staff_check_in_appointment(p_appointment_id uuid)` | While `scheduled`: → `checked_in`, `checked_in_at = now()` |
| `staff_mark_appointment_no_show(p_appointment_id uuid)` | While `scheduled`/`checked_in` and `scheduled_start <= now()`: → `no_show` |
| `list_my_appointments_today()` | For a barber caller: today's `scheduled`/`checked_in` appointments with `preferred_barber_id` = their barber: id, start time, customer first name |

New column: `appointments.checked_in_at timestamptz` (null until checked in).

Errors (exact strings): part 1's (`slot_taken`, `already_booked_that_day`, `branch_closed`,
`too_soon`, `too_far_ahead`, `service_unavailable`, `not_found`, `too_late`) plus `not_allowed`
(no capability, out of scope, or forbidden reason), `already_converted` (actions on a converted
appointment), `invalid_phone`.

### Access changes

Replace the staff `for all` policy on `appointments` with a staff **select**-only policy (same
capability + scope); all staff writes go through the functions.

### Conversion changes (`activate_due_appointments`)

- Picks up `scheduled` **and** `checked_in` appointments (expiry, closure and barber rules unchanged).
- For a `checked_in` appointment, the new ticket gets `checked_in_at` = the appointment's
  `checked_in_at` and `check_in_method = 'staff'`; when an existing active ticket takes the
  appointment, the same check-in fields are set on it if empty.

### Customer app

- Appointment Detail and Upcoming show `checked_in` as "Checked in"; customer reschedule/cancel stay
  limited to `scheduled` (part 1 functions unchanged), so a checked-in customer sees "Too late to
  change online".
- Upcoming lists `scheduled` and `checked_in`.

## Testing

- **DB:** staff booking for an existing and a new customer (and no phone); staff limits (inside
  1 hour allowed, past start refused, 14 days, one-per-day); double booking refused; out-of-scope
  manager, barber and customer refused (`not_allowed`); reschedule (incl. checked-in), cancel (incl.
  `branch_closed` refused), check-in, mark no-show (refused before start); `list_branch_appointments`
  scope; `list_my_appointments_today` returns only the caller's; staff direct insert/update refused;
  a checked-in appointment converts into a ticket with `checked_in_at` and `check_in_method = 'staff'`.
- **E2E:** a receptionist books for a new customer, sees it on the calendar and checks it in;
  reschedules and cancels another; a barber sees their appointment under Today's appointments.

## Out of scope

Week view; drag-and-drop rescheduling; changing an appointment's service or barber (cancel and
rebook); reminder texts and the walk-in buffer (part 3); staff notifications.
