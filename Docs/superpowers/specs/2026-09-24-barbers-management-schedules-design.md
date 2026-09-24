# Design: Barbers Management — Schedules & Skills

**Date:** 2026-09-24
**Status:** Approved in brainstorming, awaiting written-spec review
**Origin:** Barber assignment (`2026-09-18-barber-assignment-queue-progression-design.md`) is
shipped, but it can never fire in production: `find_eligible_barber` requires a `barber_schedule`
row for today and a `barber_skills` row for the service, and nothing in the app can create either.
This is sub-project 1 of 2. Sub-project 2 (the staff invitation flow, so barber accounts can be
created at all) follows as its own spec; neither is usable by a real shop until both are done.

## Goal

Let an Owner or Branch Manager set each barber's regular working week, adjust individual days,
and set which services each barber can perform — so barber assignment and Today's Queue work
with real data.

## Out of scope

- **Creating barber accounts** — sub-project 2 (staff invitation flow, backend-schema 3.4 / App
  Flow 8.12, 8.15). Until then barbers exist only via fixtures/scripts.
- **Scheduled breaks** — `barber_schedule.break_start/break_end` stay unused. Barbers mark breaks
  live via their existing status button, and assignment already treats `on_break` as eligible.
- **Automatic reassignment** of a barber's queued tickets when they're marked off — no
  reassignment logic exists anywhere; the screen warns instead.
- **Barber names in customer-facing lists** (Book flow barber step, walk-in modal) — needs a safe
  customer-readable source of names; `staff_users` is not customer-readable. Separate follow-up.
  Related effect: a barber floating to another branch for a day can be auto-assigned there but
  won't appear in that branch's "pick a barber" list, which lists home-branch barbers only.
- **Shifts crossing midnight** — already a known, deferred limitation of `find_eligible_barber`.

## Decisions

1. **Weekly pattern + per-day changes.** A manager sets a regular week once; the app keeps the
   upcoming days filled from it; any single date can be changed.
2. **Pattern is stored and materialized** (approach A, chosen over computing hours on the fly or a
   copy-forward button). Dated `barber_schedule` rows remain the single thing
   `find_eligible_barber` reads, so **the barber-assignment logic is not modified**.
3. **Rolling window: 28 days** (today through today + 27), refilled nightly and whenever a
   barber's pattern or days off change.
4. **Hand-changed days are protected** from refills; **past days are never rewritten**.
5. **Skills** are a tick-box list of the services offered at the barber's home branch.
6. **Permissions** follow the existing `manage_barber_schedules` capability (held by `owner` and
   `branch_manager`) scoped by `in_branch_scope(...)`.

## Data model

### New: `barber_weekly_hours`

| column | type | notes |
|---|---|---|
| `id` | uuid pk | |
| `barber_id` | uuid not null → `barbers(id)` on delete cascade | |
| `day_of_week` | smallint not null, check 0–6 | same convention as `branch_hours` (0 = Sunday) |
| `branch_id` | uuid not null → `branches(id)` | where they work that weekday |
| `shift_start` | time not null | |
| `shift_end` | time not null | check `shift_end > shift_start` |

`unique (barber_id, day_of_week)`. **No row for a weekday = day off.**

RLS: `manage_barber_schedules` + `in_branch_scope(<the barber's home_branch_id>)` for all
operations — scoped by the **barber's home branch**, exactly like the existing
`barber_skills_staff_write` policy, never by a client-supplied column (scoping by the row's own
`branch_id` would let a manager of branch B edit any barber's pattern just by naming branch B). A
barber may read their own rows (mirrors `barber_schedule_barber_own_read`).

### New: `barber_days_off`

| column | type | notes |
|---|---|---|
| `barber_id` | uuid not null → `barbers(id)` on delete cascade | |
| `off_date` | date not null | |

`primary key (barber_id, off_date)`. Same RLS as `barber_weekly_hours` — scoped by the barber's
home branch. Needed because deleting a dated row alone would be undone by the next refill.

### Existing: `barber_schedule` RLS unchanged

Hand edits of a single date keep the existing `barber_schedule_staff_scoped` policy
(`in_branch_scope(branch_id)` of the dated row). So a manager can send a barber to another branch
for a day only if that branch is also in their scope; an Owner can always.

### Changed: `barber_schedule`

Add `is_manual boolean not null default false` — true for rows a manager edited by hand. Existing
rows default to false. No other change; `find_eligible_barber` and every existing reader are
unaffected.

## The fill function

`fill_barber_schedule(p_barber_id uuid default null)` — `SECURITY DEFINER`,
`set search_path = public, pg_temp`, **not callable by any client role** (revoke from
`public, anon, authenticated`; grant to `service_role` only). Invoked only by triggers and the
nightly job, so no client can call it to rewrite schedules.

For each barber (or just `p_barber_id`) whose `staff_users.is_active` is true, for each date from
`current_date` to `current_date + 27`:

1. If the date is in `barber_days_off` → delete any row for that date (manual or not).
2. Else if a row exists with `is_manual = true` → leave it.
3. Else if the pattern has a row for that weekday → upsert the dated row from it
   (`is_manual = false`).
4. Else (pattern says day off) → delete any non-manual row for that date.

Dates before `current_date` are never touched. Running it twice produces no change.

**Triggers:**
- After insert/update/delete on `barber_weekly_hours` → refill for the affected barber.
- After insert/delete on `barber_days_off` → refill for the affected barber (so removing a day off
  restores the pattern day).

**Nightly job:** a `pg_cron` job (same mechanism as the existing no-show expiry job) calls
`fill_barber_schedule()` once a day, which also extends the window by one day.

"Today" is `current_date` in the database's timezone — the same definition `find_eligible_barber`
uses, so the two always agree.

### Reset one day: `reset_barber_schedule_day(p_barber_id uuid, p_date date)`

`SECURITY DEFINER`, `set search_path = public, pg_temp`, granted to `authenticated`. It first
checks the caller holds `manage_barber_schedules` and that the barber's home branch is in the
caller's scope (`in_branch_scope`), raising an error otherwise; it refuses dates before
`current_date`. Then it deletes that date's `barber_days_off` entry and any `barber_schedule` row
for that date, and re-applies the pattern for that single date (rules 3–4). This is the one
client-callable action that restores a day, and it can only touch one barber-date the caller is
allowed to manage.

## Screens (staff app)

### Barbers list — `apps/staff/app/settings/barbers/page.tsx` (upgraded)

- Show each barber's **name** (from `staff_users.name`, which staff can read), status, and home
  branch, instead of the raw id.
- Keep the existing PIN set/rotate control unchanged.
- Each row links to the barber detail screen.

### Barber detail — `apps/staff/app/settings/barbers/[id]/page.tsx` (new)

1. **Regular week** — seven rows (Mon–Sun): working switch, branch (defaults to home branch),
   start, end. One Save, which writes `barber_weekly_hours`; the trigger refills.
2. **Next 4 weeks** — the materialized `barber_schedule` rows plus `barber_days_off`, one line per
   date, clearly marking **changed by hand** and **day off**. Per date:
   - **Edit hours/branch** — upserts that date's `barber_schedule` row with `is_manual = true`.
   - **Mark day off** — inserts `barber_days_off`; the trigger removes the dated row.
   - **Reset to regular week** — calls `reset_barber_schedule_day`.
3. **Skills** — tick boxes for services offered at the barber's home branch
   (`branch_services` → `services`); Save writes `barber_skills`. A clear warning when none are
   ticked: that barber will never be assigned customers.

Branch pickers list only branches the user may manage (`auth_branch_ids()`; all branches for an
Owner). All strings via `next-intl` in `apps/staff/messages/en.json`.

## Error handling

- **End before start** — blocked in the form and by the table's check constraint.
- **Day off on a hand-changed day** — the day off wins (fill rule 1).
- **Marking a barber off on a day with queued tickets** — the screen counts that barber's active
  tickets for that date and warns before saving; tickets are not moved.
- **Editing today** — takes effect immediately for new joins.
- **Save failures** (RLS denial, network, a refused reset) — a visible error; no optimistic UI
  that could leave a silent half-save.
- **Inactive staff** — skipped by the fill function.

## Testing

- **DB (`tests/db/`), fill rules:** a pattern produces exactly the right 28 dated rows; pattern
  day off → no row; manual rows survive a refill; `barber_days_off` dates are skipped and their
  existing rows removed; removing a day off restores the pattern day; changing the pattern updates
  only non-manual future rows; rows before today are untouched; a second run is a no-op;
  `reset_barber_schedule_day` restores the pattern day; inactive staff are skipped.
- **DB, permissions:** a Branch Manager can write `barber_weekly_hours` / `barber_days_off` /
  `barber_schedule` / `barber_skills` for their own branch's barber but not another branch's —
  including the specific attack of a manager naming their own branch on a row for another
  branch's barber (must be refused); a
  barber can read their own rows; a customer can read none; no client role can execute
  `fill_barber_schedule`; `reset_barber_schedule_day` refuses an out-of-scope barber and a past
  date.
- **DB, the production unblocker:** set a barber's regular week and skills through a real Branch
  Manager session, then assert `find_eligible_barber` returns that barber as eligible (and as the
  fallback) for a skilled service.
- **e2e (Playwright):** a Manager sets a barber's regular week and skills on screen; a customer
  then joins that branch and the ticket is assigned to that barber.
