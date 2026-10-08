# Design: Today Dashboard and Reports

**Date:** 2026-10-08
**Status:** Approved in brainstorming, awaiting written-spec review
**Origin:** PRD sections 26 (staff operations dashboard), 30 (reporting), 31 (KPIs), 32 (RBAC);
App Flow 8.3 (branch dashboard), 8.4 (business-wide dashboard), 8.13 (reports); implementation plan
Phase 8 (reporting subset).

## Goal

Branch staff see how today is going at a glance, with a warning when waits get long; owners,
branch managers and analysts look back over any date range — per branch or across all branches —
with estimated takings and CSV export.

## Current state

- `queue_tickets` carries the lifecycle timestamps reports need: `created_at`, `called_at`,
  `checked_in_at`, `service_started_at`, `completed_at`, `no_show_at`, `cancelled_at`, plus
  `cancel_reason` (enum `wait_too_long`, `cant_make_it`, `changed_plans`, `found_another_barber`,
  `emergency`, `other`), `appointment_id` (set for appointment tickets), `assigned_barber_id`,
  `branch_service_id`, `customer_id`, `state`.
- `queue_events` is only partly populated (a few system events), so reports read tickets, not events.
- Prices: `branch_service_prices` rows with `effective_from` / `effective_until` and `is_promo`; the
  staff app inserts a new row (effective today) on every price change, so the price on any past date
  is recoverable. `current_branch_service_price` picks promo first, then the latest `effective_from`.
- `feedback` has `overall_rating` per ticket (after-visit feedback, 2026-10-07).
- `barbers.home_branch_id`, `barbers.status` (enum includes `available`, `busy`).
- `appointments.status` enum: `scheduled`, `checked_in`, `converted`, `completed`, `cancelled`,
  `no_show`.
- Capabilities: `view_branch_reports` (owner, branch_manager, analyst), `view_business_reports`
  (owner, analyst), `edit_hours` (owner, branch_manager). Receptionists hold `register_walkins`,
  `edit_tickets`, `cancel_tickets`, `check_in_customers`, `message_customers`.
- Helpers: `has_capability(cap)`, `in_branch_scope(branch_id)`.
- Staff app home page links settings, Appointments and Feedback; there is no dashboard or reports page.
- Appointments already use Ghana time (`Africa/Accra`, UTC+0) for "today".

## Decisions

1. **Scope:** a Today dashboard per branch and a Reports page (branch or all branches, date range).
2. **Money:** estimated takings from the price in effect on the visit date, labelled "estimated".
3. **Access:** Today for owner, branch manager, receptionist, analyst; Reports and money for
   `view_branch_reports`; all-branches for `view_business_reports`; barbers see neither.
4. **Long-wait warning:** a per-branch setting, default 20 minutes.
5. **Approach:** database functions compute the numbers; the staff app only displays them.

## Section 1 — Access and the Today dashboard

### Access

- New capability `view_branch_dashboard` ("View the branch Today dashboard"), granted to owner,
  branch_manager, receptionist, analyst.
- Every function also requires the branch to be in the caller's scope (`in_branch_scope`).

### Long-wait setting

- New column `branches.long_wait_warning_minutes smallint not null default 20` with check
  `between 5 and 180`.
- Edited on the existing Branch Settings page (`/settings/branch/[id]`) as
  `Long wait warning (minutes)`, by callers with `edit_hours` (the page's existing rules decide who can
  save). Out-of-range input → `Enter a number from 5 to 180.`

### `branch_today(p_branch_id uuid) returns jsonb` (`authenticated`)

Requires `view_branch_dashboard` and the branch in scope → else `not_allowed`. "Today" is the current
date in `Africa/Accra`. Returns:

- `now`: `waiting` (states `created`, `waiting`, `almost_turn`), `called` (`called`, `confirmed`,
  `grace_period`), `in_service`, `appointments_to_come` (today's appointments at the branch in status
  `scheduled` or `checked_in`), `barbers_available`, `barbers_busy` (barbers with
  `home_branch_id` = the branch and status `available` / `busy`).
- `today` (tickets created today): `served` (completed), `walk_ins` (completed, no `appointment_id`),
  `appointments` (completed, with `appointment_id`), `no_shows`, `cancellations`,
  `avg_wait_min` (completed: `service_started_at − created_at`), `avg_service_min`
  (completed: `completed_at − service_started_at`), rounded to whole minutes, null when no data.
- `ratings` (feedback on tickets created today): `count`, `average` (2 decimals) — **null unless the
  caller has `view_branch_reports`**.
- `long_wait`: `threshold_min` (the branch setting), `current_avg_wait_min` (average of
  `now() − created_at` over tickets currently waiting or called, whole minutes, null if none),
  `alert` (true when `current_avg_wait_min > threshold_min`).
- `updated_at`: `now()`.

### Today page (staff app `/today`)

- Linked from the staff home page (`Today`) for callers with `view_branch_dashboard`.
- Branch picker (branches in scope), then:
  - Red banner when `alert`: `Waits are long: people have waited {minutes} min on average (limit
    {limit} min).`
  - **Right now:** Waiting, Called, In service, Appointments still to come, Barbers available,
    Barbers busy.
  - **So far today:** Served, Walk-ins, Appointments, No-shows, Cancellations, Average wait,
    Average haircut time.
  - **Ratings today** (only when returned): `{count, plural, one {# rating} other {# ratings}} ·
    {average} average`.
  - `Updated {time}`; refreshes every 30 seconds.
- No permission → title plus `You don't have access to this page.`; load failure →
  `Couldn't load the dashboard.`

## Section 2 — Reports

### `branch_report(p_branch_ids uuid[], p_from date, p_to date) returns jsonb` (`authenticated`)

- Requires `view_branch_reports` and every branch in scope; more than one branch also requires
  `view_business_reports` → else `not_allowed`. Empty or null array → `not_allowed`.
- `p_from <= p_to` and `p_to − p_from <= 91` (at most 92 days) → else `invalid_range`.
- A ticket belongs to the period when `(created_at at time zone 'Africa/Accra')::date` is between
  `p_from` and `p_to`; that date is its visit date.
- Definitions (used throughout):
  - served = state `completed`; wait = `service_started_at − created_at`; haircut time =
    `completed_at − service_started_at` (both over completed tickets with both timestamps).
  - no-show rate = no_shows / (served + no_shows); cancellation rate = cancellations / all tickets
    in the period; percentages to 1 decimal, null when the denominator is 0.
  - estimated takings = sum over served tickets of the price in effect for that ticket's
    `branch_service_id` on its visit date: rows with `effective_from <= date` and
    (`effective_until` null or `>= date`), promo first, then latest `effective_from`; a ticket with
    no matching price contributes 0.
  - returning customers = share of distinct customers served in the period who have a completed
    ticket (any branch) created before `p_from` (Ghana date); 1 decimal, null when none served.
  - ratings = feedback rows whose ticket is in the period.
- Returns sections:
  - `summary`: served, walk_ins, appointments, no_shows, no_show_rate, cancellations,
    cancellation_rate, avg_wait_min, median_wait_min, avg_service_min, rating_count,
    rating_average, est_takings_ghs, returning_rate.
  - `daily`: one row per date in the range (including days with no tickets: counts 0, averages
    null, takings 0): date, served, walk_ins, appointments, no_shows, cancellations, avg_wait_min,
    avg_service_min, rating_average, est_takings_ghs.
  - `hours`: one row per Ghana-time hour (0–23) that had any ticket: hour,
    avg_joined_per_day (tickets created in that hour ÷ days in range, 1 decimal), avg_wait_min.
  - `barbers`: per assigned barber with any ticket: barber_id, name (display name), served,
    avg_service_min, no_shows, rating_average, est_takings_ghs; ordered by served desc, then name.
  - `services`: per service: service name, served, share (% of served, 1 decimal),
    avg_service_min, listed_duration_min (branch override, else the service default),
    est_takings_ghs; ordered by served desc, then name.
  - `cancel_reasons`: reason, count; ordered by count desc (tickets with a null reason counted as
    `other`).
  - `branches` (only when more than one branch): per branch the `summary` fields plus branch_id and
    name, ordered by name.
- Minutes rounded to whole numbers; money to 2 decimals; null where there is no data.

### Reports page (staff app `/reports`)

- Linked from the staff home page (`Reports`) for callers with `view_branch_reports`.
- Filters: Branch (branches in scope; plus `All branches` for `view_business_reports`), date preset
  (`Last 7 days`, `Last 30 days`, `This month`, `Last month`, `Custom`) with From/To for Custom. Dates
  are Ghana dates; "Last 7 days" includes today.
- Sections, in order: Summary cards, Day by day, Busiest hours (row shading proportional to
  avg_joined_per_day), Barbers, Services, Cancellation reasons, Branch comparison (all branches only).
- Money shown as `GHS 1,250.00 (estimated)` in the summary and `GHS 1,250.00` in tables under an
  `Estimated takings` column header; minutes as `18 min`; empty values as `—`.
- `Download CSV` under each table (Day by day, Busiest hours, Barbers, Services, Cancellation
  reasons, Branch comparison); file name `pixel-barber-{table}-{from}-{to}.csv`; header row with
  the column labels; values unformatted (plain numbers, ISO dates, empty for null).
- Messages: no permission → `You don't have access to this page.`; `invalid_range` →
  `Pick a range of up to 92 days.`; other errors → `Couldn't load the report.`; no tickets →
  `No visits in this period.`

## Section 3 — Build, errors, testing

- Migration(s): capability + role grants; branch column; `branch_today`; `branch_report`; index
  `queue_tickets (branch_id, created_at)`.
- Every new function: `security definer`, `set search_path = public, pg_temp`, explicit revoke/grant
  (`authenticated` only), short error codes.
- Staff app: `/today`, `/reports`, a CSV helper (`toCsv(headers, rows)` quoting commas, quotes and
  newlines), Branch Settings field, home page links, `en.json` namespaces `Today` and `Reports`.

### Testing

- **DB (staging):** a seeded branch with known tickets — completed walk-ins and appointment
  tickets, a no-show, cancellations with two reasons, two barbers, two services, a price change
  inside the range, a promo price, ratings, a customer with an earlier visit — asserting every
  summary/daily/hours/barbers/services/cancel_reasons value; a second branch for the comparison.
  Access: receptionist gets `branch_today` (ratings null) but `branch_report` → `not_allowed`;
  barber → `not_allowed` for both; branch manager → `not_allowed` for another branch and for
  multiple branches; analyst/owner allowed multi-branch; 93-day range and `from > to` →
  `invalid_range`. `long_wait.alert` true when the seeded waiting tickets exceed the threshold.
- **Unit:** `toCsv` quoting; minute and money formatting.
- **E2E:** a branch manager opens Today (counts and long-wait banner visible), opens Reports, picks
  Custom range, sees the summary and Barbers table, and downloads a CSV (Playwright download event,
  file starts with the header row).

## Out of scope

Barber utilisation (busy time vs scheduled hours); revenue from actual payments; a charts library;
scheduled or emailed reports; customer CRM and broadcasts; audit log viewer; the full RBAC test
matrix (separate Phase 8 work).
