# Design: Role and Permission Check

**Date:** 2026-10-08
**Status:** Approved in brainstorming, awaiting written-spec review
**Origin:** PRD section 32 (Roles and Permissions); implementation plan Phase 8 ("every row of PRD
section 32's table becomes an automated test … rejected at the RLS layer if they try the underlying
request directly"). Prompted by the `customers_staff_scoped` gap closed on 2026-10-08.

## Goal

Prove, with automated tests, that each role can do exactly what the PRD allows and is refused —
in the app and in the database — for everything else; close the clear gaps the tests expose; and
stop future tables or functions from shipping unclassified.

## Current state

- 31 public tables/views, all with RLS on (views use security invoker or are public
  read-only data: `branch_status_view`, `current_branch_service_price`, `customer_segments`).
- ~45 functions executable by `authenticated` (most `security definer` with their own capability
  and `in_branch_scope` checks); a few also by `anon`.
- Capabilities (role_capabilities): owner — everything except `manage_own_queue`;
  branch_manager — pricing, hours, branch reports, barber schedules, escalations, messaging,
  broadcasts, walk-ins, edit/cancel tickets, check-in, dashboard, customers; receptionist —
  walk-ins, edit/cancel tickets, check-in, message customers, dashboard, customers; barber —
  `manage_own_queue`; analyst — branch and business reports, audit log, dashboard, customers.
- Existing focused tests: `tests/db/rls-policies.test.ts`, `rls-helpers.test.ts`, per-feature DB
  tests, and `customer-staff-read.test.ts`.
- Suspected gaps seen while designing (to be confirmed by the tests):
  1. `consents_staff_read` lets any `view_branch_reports` or `broadcast_messages` holder (incl.
     analysts) read every customer's consents business-wide, with no branch scope.
  2. `tickets_staff_branch_scope` is `FOR ALL`, so `edit_tickets` holders may be able to DELETE
     tickets (PRD allows edit and cancel only), subject to table grants.
  3. `staff_users_branch_scoped_read` lets every staff member (incl. barbers) read colleagues'
     staff rows (possibly phone and email).
  4. `link_or_create_customer` is executable by `anon`.

## Decisions

1. **Gaps:** clear gaps (PRD forbids the access, or the access ignores branch scope) are fixed in
   this work with a test; judgment calls are listed for the user with a recommendation and are not
   changed until they decide.
2. **Depth:** the full matrix at the database layer (tables and functions, every role); screens get
   one light browser check per staff role.
3. **Approach:** one declarative permission matrix is the source of truth, plus a coverage guard.

## Section 1 — The matrix and what is tested

### Roles under test

`anon` (not logged in), `customer`, `barber`, `receptionist`, `branch_manager`, `analyst`,
`owner`, plus `other_manager` (a branch manager of the second branch, to catch cross-branch leaks).

### Fixture (`tests/db/rbac/fixture.ts`)

- Two branches (A and B), each with a service, a price, a barber, a customer with a completed
  ticket, an appointment, a feedback row and a `staff_message` notification.
- Logins: owner; branch_manager, receptionist, analyst at A; barber at A (barber A's own tickets);
  other_manager at B; customer A (an app customer of branch A); an anonymous client.
- Created and cleaned up per run like the existing fixtures (cleanup throws on failure).

### The matrix (`tests/db/rbac/matrix.ts`)

- **Tables:** for each table, per role: `read` — `none` | `own` | `branch` | `all` (what rows come
  back for the role compared with the fixture rows of branch A, branch B and the role's own), and
  `insert` / `update` / `delete` — `allow` | `deny` (tried against a branch-A row and a branch-B
  row; `allow` means allowed for in-scope rows only unless marked `all`). Each entry has a one-line
  `why` (PRD row or capability).
- **Functions:** for each `authenticated`/`anon`-executable function, per role: `allow` or `deny`
  (`deny` = the call errors with `not_allowed`, `not_found` for scope-hidden rows, or a permission
  error), with fixed arguments built from the fixture, and a `why`.
- Trigger functions and helper functions that are not meaningfully callable (`returns trigger`,
  `set_updated_at`, `check_notification_recipient`) are listed as `internal` with a reason.

### Tests

- `tests/db/rbac/tables.test.ts` — every table × role × operation against the matrix.
- `tests/db/rbac/functions.test.ts` — every function × role against the matrix.
- `tests/db/rbac/coverage.test.ts` — reads the catalog (public tables/views, and functions
  executable by `authenticated` or `anon`) and fails, naming the object, if any is missing from
  the matrix or the matrix names something that no longer exists.
- `e2e/staff-roles.spec.ts` — for each staff role: log in, check the home page shows exactly that
  role's links (e.g. a barber sees no Reports, Customers or settings links; an analyst sees Today,
  Reports, Customers, Feedback), and open one forbidden page (Reports as a barber, Customers as a
  barber, Staff & Roles as a branch manager) and see `You don't have access to this page.` (or the
  page's existing equivalent).

## Section 2 — Gaps

### Clear gaps — fixed here, each with its matrix entry

- **Consents:** `consents_staff_read` is replaced so staff read consents only for customers visible
  at their branches and only with `broadcast_messages` (owner, branch_manager); analysts lose direct
  access (the customer page already exposes "Promotions: Allowed" through `customer_detail`).
- **Ticket deletion:** staff (`edit_tickets`) can no longer DELETE `queue_tickets` (and the same
  check is applied to any other table where an `ALL` policy grants DELETE the PRD doesn't allow);
  insert/update/cancel are unchanged.
- **Any further case the tests expose** that matches the "clear" rule: a role writing what the PRD
  says it can't, reading outside its branches, an analyst changing anything, a barber touching
  another barber's tickets, `anon` reaching non-public data.
- Each fix is its own migration (`supabase/migrations/2026100812xxxx_rbac_*.sql`), never an edit to
  an applied migration; staging first, production after the user's OK.

### Judgment calls — listed, not changed

- Colleague details (`staff_users_branch_scoped_read`: which columns, which roles).
- What `anon` sees about barbers (`barbers_public_read`) and other public reads.
- `link_or_create_customer` callable by `anon` (if the tests show it refuses safely, recommend
  revoking anyway).
- Anything else the PRD doesn't decide. Each gets: what's exposed, to whom, and a recommendation.
  The matrix records the current behaviour for these with `why: 'pending user decision'` so the
  suite stays green until the user decides.

## Section 3 — Delivery

- All new tests run on staging with the existing suite (paced re-runs on login rate limits).
- Results reported to the user: fixes made (with migrations), the judgment-call list with
  recommendations, and confirmation the existing DB, unit and e2e suites still pass.
- Out of scope: audit log viewer; new capabilities or roles; rate limiting; changing what any screen
  shows beyond fixing access.
