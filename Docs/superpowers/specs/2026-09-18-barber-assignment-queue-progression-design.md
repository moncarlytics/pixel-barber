# Design: Barber Assignment & Queue Progression

**Date:** 2026-09-18
**Status:** Approved by user, ready for implementation planning
**Origin:** Critical finding from Phase 5's final whole-branch review — no code path anywhere
sets `queue_tickets.assigned_barber_id`, so Today's Queue (Phase 5's headline barber-facing
screen) cannot show a real ticket in production. Flagged as the third major un-owned scope gap
this project's phased build has surfaced (alongside the Barbers Management screen and the staff
invitation flow — neither addressed by this design).

## Problem

`queue_tickets.preferred_barber_id` (set at join time) and `queue_tickets.assigned_barber_id`
(read everywhere downstream — Today's Queue, `recalculate_positions`, the barber-current-ticket
trigger) both exist in the schema and are already wired into every consumer. Nothing anywhere
ever *writes* `assigned_barber_id`. Every test that exercises Today's Queue fabricates this field
directly via the admin client. Separately, `called` and `almost_turn` — two of the ten
`ticket_state` values, already ranked by `recalculate_positions` — are dead: no code transitions
a ticket into either of them. Only `waiting`, `confirmed` (via staff's existing Mark Arrived),
`in_service`, `no_show`, `grace_period`, and the terminal states are actually reachable today.

This design adds the two missing decisions — *which barber does this customer actually get*, and
*when do they get told their turn is close* — without adding any new customer- or staff-facing
concept beyond what the schema already models.

## Out of scope

- **`is_pooled` / `POST /tickets/:id/pool-accept`** (PRD 16/35) — a customer already assigned to
  a specific barber later opting into "any available barber" to reduce their wait. This is a
  distinct, already-specified feature with its own endpoint, addressing a different moment in the
  journey (mid-wait escalation) than this design (initial assignment). Not built here. This
  design's change to `recalculate_positions` must continue to rank pooled, unassigned tickets
  (`assigned_barber_id is null and is_pooled`) alongside every eligible barber's own queue exactly
  as the function already does — that existing behavior is preserved, not modified.
- **Barbers Management screen** and **staff invitation flow** — both previously flagged,
  unrelated gaps. Not addressed here.
- **PIN brute-force / rate-limiting hardening** — previously deferred to Phase 10. Unrelated.

## Decisions

1. **Assignment happens at queue-join time** (customer self-service join, or staff walk-in) —
   not dynamically as barbers free up, and not left to a future manual staff screen.
2. **If the customer named a preferred barber and that barber isn't currently eligible**, the
   customer is asked, at join time: wait specifically for that barber, or take the next available
   one. (If the preferred barber has no schedule at all for today at that branch, the "wait for
   them" choice is not offered — see Data Flow, step 2.)
3. **With no usable preference** (none given, or the customer chose "take next available"), the
   system assigns the *least busy* eligible barber — fewest of that barber's own active tickets
   (`waiting`/`almost_turn`/`called`/`confirmed`/`in_service`) at that branch. Ties broken
   deterministically (lowest `barber_id`) — no further fairness logic beyond least-busy.
4. **Eligibility** = has a `barber_skills` row for the ticket's service, has a `barber_schedule`
   row for *today* at *this branch* whose `shift_start`–`shift_end` covers the current time, and
   `barbers.status` is not `offline`, `end_of_shift`, or `temporarily_unavailable`. A barber
   currently `on_break` still counts as eligible (they'll be back before a newly-joined ticket
   reaches the front of their line).
5. **If no barber is eligible at all** for that service at that branch right now, the join is
   refused with a clear inline message ("No barbers available for this service right now") — no
   ticket is created. This matches the app's existing handling of a branch being closed
   (App Flow's error-state table).
6. **Position-derived state promotion**: within one barber's own queue (ranked by `position`,
   exactly as `recalculate_positions` already computes it), position 1 → `called`, position 2 →
   `almost_turn`, position 3+ → `waiting`. Purely automatic, computed in the same place positions
   already are — no new manual step for anyone.
7. **Notification on entering `called`**: one row inserted into `notifications`
   (`recipient_type='customer'`, `channel='sms'`, `notification_type='your_turn'`,
   `related_ticket_id`), using the exact insert shape `expire_no_show_grace_periods` already uses.
   `notification_type` is a plain `text` column (confirmed via
   `20260911210900_notifications_and_push.sql`) — no enum migration needed. Matches the existing
   codebase pattern of always sending via `sms` regardless of the customer's push/SMS-backup
   preference (the same simplification `expire_no_show_grace_periods` already makes) — not a new
   inconsistency introduced by this design.

## Architecture

Two functions carry the whole feature; both extend existing code rather than introduce new
subsystems, matching this codebase's established pattern of putting cross-row, security-sensitive
logic in `SECURITY DEFINER` SQL functions rather than application code.

### New: `find_eligible_barber(p_branch_id uuid, p_service_id uuid, p_preferred_barber_id uuid default null)`

Returns one row: `preferred_eligible boolean, preferred_scheduled_today boolean, fallback_barber_id uuid`
(`fallback_barber_id` is `null` when no barber is eligible at all).

- Eligible pool = `barbers` joined to `barber_skills` (service match), joined to `barber_schedule`
  (`work_date = current_date`, `branch_id = p_branch_id`, `now()::time between shift_start and
  shift_end`), filtered on `status not in ('offline','end_of_shift','temporarily_unavailable')`.
- `preferred_scheduled_today` = whether `p_preferred_barber_id` has *any* `barber_schedule` row
  for today at this branch, regardless of the shift-hours/status filters — this is what decides
  whether "wait for them" is even offered (decision 2's parenthetical).
- `fallback_barber_id` = the eligible barber with the fewest active tickets at this branch (see
  decision 3), or `null` if the eligible pool is empty.

Called twice:
1. **Pre-check**, as a plain RPC from the client, right after the customer names a preferred
   barber — decides whether to show the wait/fallback prompt at all.
2. **Inside `createTicketAtomic`**, at actual insert time — always re-derived fresh, never trusts
   the pre-check's answer, closing the (accepted, narrow) timing gap between the two calls.

### Extended: `createTicketAtomic`

Gains one new parameter carrying the customer's resolved choice from the prompt (or its absence,
for walk-ins and no-preference joins). At insert time:
- Preferred given and (per the fresh `find_eligible_barber` call) eligible → assign the preferred
  barber.
- Preferred given, not eligible, customer chose "wait for them" → assign the preferred barber
  anyway (only offered when `preferred_scheduled_today` was true, so this always resolves to a
  barber who will become eligible again later today).
- Preferred given, not eligible, customer chose "take next available" (or preferred has no
  schedule today at all) → assign `fallback_barber_id`.
- No preference given → assign `fallback_barber_id`.
- `fallback_barber_id` is `null` (nobody eligible) → the insert does not happen; the Edge Function
  returns the refusal from decision 5.

### Extended: `recalculate_positions`

After computing each ticket's `position` within its assigned barber's queue exactly as today,
for any ticket currently in `waiting`/`almost_turn`/`called`, derive the new state from its
position (decision 6) and write it in the same update. On a fresh transition into `called`,
insert the `notifications` row (decision 7). No new trigger — reuses the existing
`trg_ticket_state_changed` firing conditions unchanged.

## Data Flow (customer join)

1. Customer picks branch + service (+ optionally a preferred barber) in Book flow / the walk-in
   modal.
2. If a preferred barber was picked, the client calls the `find_eligible_barber` pre-check.
   - `preferred_eligible = true` → proceed straight to step 3, no prompt.
   - `preferred_eligible = false` and `preferred_scheduled_today = true` → prompt: "wait for
     [barber]" vs. "take next available."
   - `preferred_eligible = false` and `preferred_scheduled_today = false` → no prompt; proceed
     straight to fallback (the preferred barber isn't working today at all).
3. Client submits the join/walk-in request carrying whatever was resolved.
4. `tickets-join` / `tickets-walk-in` call `createTicketAtomic`, which re-derives the assignment
   (never trusting step 2's read) and either creates the ticket with `assigned_barber_id` set, or
   returns the "no barbers available" refusal.
5. The existing `trg_ticket_state_changed` trigger fires unchanged, calling the extended
   `recalculate_positions`, which sets `position`, derives `called`/`almost_turn`/`waiting`, and
   notifies on entry to `called`.

## Error Handling

- **No eligible barber at all**: join refused per decision 5, no ticket created.
- **Pre-check/insert timing gap**: what the customer was shown in step 2 may be marginally stale
  by step 4 (another customer took the last available barber in between). Accepted, matches this
  project's existing tolerance for similarly narrow timing gaps elsewhere (e.g. the PIN-collision
  fix's disclosed race) — not a data-integrity issue, just an occasional mismatched expectation.
- **Two simultaneous joins both told the same barber is least-busy**: both may land on that one
  barber instead of splitting evenly. A fairness rough edge, not a correctness bug — explicitly
  accepted rather than adding a reservation/locking layer (the rejected Approach C) for it.

## Testing

- **DB-level** (`tests/db/`): `find_eligible_barber`'s pool computation (skill match, shift-hours
  boundary, each excluded `status` value, `on_break` still counts), least-busy tie-breaking,
  preferred-eligible vs. not-eligible-but-scheduled vs. not-scheduled-at-all branches; extended
  `recalculate_positions`'s position→state derivation (position 1 → `called` + notification row
  written exactly once, position 2 → `almost_turn`, 3+ stay `waiting`, correct re-derivation after
  a `Skip` reorders the queue).
- **Edge Function level** (existing pattern — real deployed-function calls): both `tickets-join`
  and `tickets-walk-in` end with a real `assigned_barber_id` on the created ticket, for both the
  auto-fallback and explicit-preference paths; the "no barber available" refusal returns cleanly
  with no ticket row created.
- **e2e** (Playwright, extending Phase 5's cross-surface journey pattern): full customer journey —
  customer's preferred barber is shown as busy, customer chooses "take next available," the
  resulting ticket appears correctly assigned in Today's Queue for the fallback barber.
