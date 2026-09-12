# Pixel Barber — Implementation Plan for Claude Code

**Document status:** Execution plan — the sequence Claude Code follows to build and ship the product
**Version:** 1.0
**Date:** 9 September 2026
**Companion to:** `pixel-barber-prd.md` (what to build), `pixel-barber-app-flow.md` (every screen referenced below), `pixel-barber-tech-stack.md` (every dependency and version referenced below), `pixel-barber-backend-schema.md` (every table, function, and policy referenced below) — this document does not repeat any of their content, only sequences it into buildable phases.

**Decisions locked for this plan**, from the clarifying round before it was written: the build proceeds in **vertical slices** — each phase delivers one feature end-to-end across backend, customer app, and staff app together, rather than finishing one whole layer before starting the next. Automated tests are written **alongside each phase**, not retrofitted later. Staging Supabase and both staging Vercel projects are provisioned in **Phase 0**, so every phase after that ends with something actually deployed, not just passing locally. Web Push, Google Maps, and Gemini are built behind stub interfaces from the start and wired to real accounts in one dedicated **Phase 7** (Arkesel, the SMS provider, is a partial exception — its `send-sms` Send SMS Hook has to be real from Phase 1, since OTP signup depends on it; only the ticket-lifecycle/appointment SMS path waits for Phase 7), so core queue/appointment logic never blocks on third-party account provisioning. The five launch languages are scaffolded immediately but only populated in English until a dedicated **Phase 9**, once copy has stopped changing. The plan runs **continuously** — Claude Code uses its own judgment within each phase and only stops for a genuine blocker (a missing credential, an actual product ambiguity), not for a scheduled review gate. The plan's scope ends at **PRD section 39's Phase 1 (MVP), fully deployed to production** — PRD Phase 2 (geofencing depth, cross-branch comparison, richer CRM) is out of scope for this document.

---

## 0. How to Read and Use This Plan

Eleven phases, numbered 0–10, each with the same four parts: **Builds on**, naming exactly which prior phase's output this one extends; **Scope**, what gets built, phrased as references into the four companion documents rather than re-describing screens or tables that already have a canonical description; **Verification**, the automated tests this phase adds; and **Definition of Done**, the concrete, checkable condition that means the phase is actually finished — not "the code is written" but "this specific thing works end-to-end against the staging environment." A phase is not complete until its Definition of Done is true; a later phase should never be the place a skipped earlier one gets finished.

Every phase after Phase 0 touches all three of backend (migrations/RLS/functions), customer app, and staff app together where the feature calls for it — this is what "vertical slice" means in practice, and it's a deliberate response to the PRD's own first product principle (section 42: "customer, barber, and staff views all read from the same queue state"). Building the customer's half of a feature in one phase and the staff half three phases later would let exactly that kind of drift happen.

Each phase should land as its own commit (or small set of commits) and, once its Definition of Done passes locally, a deploy to the staging Vercel projects — "deploy early and often" per the locked environments decision, not a single deployment at the very end.

---

## 1. Phase Summary

| # | Phase | Primary output |
|---|---|---|
| 0 | Initialization & Environments | Monorepo, CI, staging Supabase + both staging Vercel projects, all deploying a blank shell |
| 1 | Database Foundation & Auth Walking Skeleton | Full schema applied, RBAC/RLS live, customer + staff login working, one ticket visible live on both a customer and staff screen |
| 2 | Branch & Service Data (Both Surfaces) | Staff can manage branches/services/pricing/hours; customers can browse them |
| 3 | Onboarding & Customer Profile | Full account creation, avatar, notification prefs, consent capture, profile editing |
| 4 | Core Queue Engine | Join/walk-in, live tracking, wait-time estimate, cancellation, idempotency |
| 5 | Barber Interface & No-Show Handling | Barber login, today's queue, service sessions, grace period, full no-show escalation |
| 6 | Appointments | Booking, calendar, auto-conversion into live tickets, late-arrival handling |
| 7 | Real Integrations | Arkesel SMS (ticket-lifecycle/appointment path — the OTP path's Send SMS Hook is already real from Phase 1), Web Push, Google Maps travel/geofence, Gemini feedback classification |
| 8 | CRM, Reporting, RBAC Completion | Customer CRM, messaging/broadcast, reports, business-wide dashboard, audit log, full RBAC test matrix |
| 9 | Localization & Accessibility | All 5 languages populated, accessibility and design-system compliance pass |
| 10 | Hardening & Production Launch | Edge-case suite, performance/security pass, production cutover, PRD acceptance criteria verified live |

---

## 2. Phase 0 — Initialization & Environments

**Builds on:** nothing; this is the starting point.

**Scope.** Scaffold the monorepo exactly as laid out in the tech stack document's section 2 (`apps/customer`, `apps/staff`, `packages/shared`, `supabase/`), with root `package.json` workspaces and `turbo.json` per that document's section 3. Install every dependency at the exact pinned versions in tech stack sections 4–15, after first re-running `npm view <package> version` against each one per that document's own section 19 — a document written on 9 September 2026 is not guaranteed to still be current the day this phase actually runs. Set up ESLint (flat config), Prettier with a pre-commit hook, and a GitHub Actions workflow that runs lint, typecheck, and `vitest` on every pull request. Create two Supabase projects (staging and production, per tech stack section 16's recommendation) and two Vercel projects (`apps/customer` and `apps/staff` as their respective roots), and populate every environment variable from tech stack section 18 with placeholder or sandbox values — real Maps/Gemini keys are not needed yet (Phase 7), and Arkesel needs only enough of a real account to issue an API key by Phase 1 (a registered sender ID can wait, since it only blocks actual SMS delivery, not the rest of Phase 0's scaffolding), but `NEXT_PUBLIC_SUPABASE_URL`/`ANON_KEY` and the service role key must be real staging values from day one, since nothing after this phase works without them. Each app gets a minimal placeholder home route so a real deploy can be verified.

**Verification.** A CI run on an empty pull request passes lint, typecheck, and an empty test suite. `supabase db push` against the staging project succeeds with zero migrations (proving the CLI is correctly linked).

**Definition of Done.** Both apps are live at their staging Vercel URLs showing a placeholder page; a trivial PR triggers CI and merges cleanly; `supabase` CLI commands run against staging without authentication errors.

---

## 3. Phase 1 — Database Foundation & Auth Walking Skeleton

**Builds on:** Phase 0's environments.

**Scope.** Write and apply the full set of migrations for the backend schema document, in the dependency order that document's section 19 specifies: extensions and the shared `set_updated_at()` function (schema section 1); identity and RBAC (`customers`, `staff_users`, `capabilities`, `role_capabilities`, `barbers`, section 2–3, plus the `custom_access_token_hook` and its helper functions, wired via the Supabase dashboard's Auth Hooks setting per section 3.2); reference data (`businesses`, `branches` and its hours/closures, `services`, `branch_services`, `branch_service_prices`, `barber_skills`, sections 4–5); then the queue-dependent tables (`barber_schedule`, `barber_service_stats`, `staff_branch_assignments`, `queue_tickets`, `appointments`, `service_sessions`, `notifications`, `push_subscriptions`, `feedback`, `consents`, `queue_events`, `audit_log`, sections 6–12); then every RLS policy from section 14 and every trigger/function from section 15. Seed one `businesses` row, two or three `branches` rows with hours, a handful of `services`/`branch_services`/`branch_service_prices`, and the full `capabilities`/`role_capabilities` matrix matching PRD section 32's table exactly.

On the auth side: wire Supabase Auth's phone-OTP sign-up flow for customers (App Flow section 5, steps 1–3 only — name/phone, OTP, password; avatar and notification preferences are Phase 3) and email/phone-plus-password login for staff (App Flow section 8.2). A distinction worth being explicit about here: OTP-for-login is Supabase Auth's own core mechanism, not part of the notification system this plan stubs until Phase 7 — but unlike a natively-supported provider, it needs a working `send-sms` Send SMS Hook (backend schema section 17) from this phase onward, since Arkesel (the SMS provider for Ghana numbers, tech stack section 13) isn't one of Supabase Auth's dashboard-configurable phone providers. This pulls a small, real piece of "Phase 7 work" (an Edge Function that calls a real SMS provider) earlier into Phase 1 — deliberately, since a customer literally cannot sign up without it, and Phase 1's own Definition of Done requires real OTP signup working end-to-end. The Edge Function built here is reused as-is by Phase 7's ticket-lifecycle/appointment SMS path rather than rebuilt.

To prove the "one queue engine, both sides read from it" principle before any real UI exists, this phase ends with a deliberately bare walking skeleton: a customer, once logged in, sees an unstyled list of their own tickets on a placeholder route; a staff user, once logged in, sees an unstyled list of their branch's tickets on a placeholder route; a single `queue_tickets` row inserted directly in the Supabase dashboard appears on both routes within a second or two via a Realtime subscription, with no manual refresh.

**Verification.** Unit tests for `auth_role()`, `has_capability()`, `in_branch_scope()`. An RLS integration test suite (using two seeded customers and two seeded staff users across two branches) that asserts every policy in schema section 14.2 behaves as written — in particular, that customer A cannot `select` customer B's row, and that a Receptionist scoped to Branch 1 cannot see a Branch 2 ticket.

**Definition of Done.** A new customer can sign up end-to-end (name/phone → real OTP → password) against staging. A staff user can log in. The manually-inserted ticket is visible live on both placeholder routes. Every RLS test passes in CI.

---

## 4. Phase 2 — Branch & Service Data, Both Surfaces

**Builds on:** Phase 1's schema and auth.

**Scope.** Staff/admin portal: Settings → Services & Pricing and Branch Settings (App Flow section 8.12) — full CRUD for branches, hours, closures, services, branch-service linkage, and effective-dated pricing (backend schema section 5), gated by the `manage_branches`/`edit_pricing` capabilities. Customer app: Branch Discovery and Branch Detail (App Flow sections 4.2–4.3), reading `branch_status_view` and `current_branch_service_price` (schema sections 4.1 and 5) so status and price are always live and correct rather than hard-coded for testing. This is also where `next-intl` gets scaffolded (tech stack section 10): every user-facing string in both apps becomes a translation key against an English-only message file from this phase forward — not populating the other four languages yet is Phase 9's job, but writing raw strings directly into components from this phase on would mean re-touching every file later, which the scaffold-now decision exists specifically to avoid.

**Verification.** Component tests for `branch_status_view`'s open/closed/closing-soon logic against a fixed clock, and for price resolution when a promo row is active vs. expired. A Playwright test: a staff user creates a branch, a service, and a price; a customer, in the same test, sees that branch and its correct price in Discovery and Detail with no manual data seeding beyond what the test itself created.

**Definition of Done.** A staff user can fully configure a new branch from empty (hours, at least one service, one price) through the UI alone. That branch is immediately visible and correct on the customer side. No screen in either app has a hard-coded English string outside the message files.

---

## 5. Phase 3 — Onboarding and Customer Profile

**Builds on:** Phase 1's OTP/password signup, Phase 2's branch data (onboarding can complete "into" a specific branch selection per App Flow section 4.4's note).

**Scope.** Complete the Onboarding Wizard (App Flow section 5, steps 4–6): avatar selection against the predefined avatar library referenced by `customers.avatar_key` (backend schema section 2), notification preferences (push permission prompt plus the two configurable lead-time defaults, PRD section 20), and the resume-to-original-context behavior in step 6. Build the Profile tab in full (App Flow section 7.9): account info, avatar change, password/security, notification preferences, the (English-only, functionally wired) language switcher, default branch, and empty-state Visit History/Feedback History lists. Wire transactional consent capture at the point PRD section 28 implies it (onboarding) and marketing consent as an explicit opt-in in Profile, both writing to the `consents` table (schema section 11) rather than a boolean — this is also the first phase that actually exercises that table, so it's the right place to confirm the "latest row wins" read pattern works as designed.

**Verification.** A Playwright test running the full onboarding wizard start to finish, asserting a `consents` row exists for `transactional` with `granted = true` by the end. A unit test asserting a customer's current consent for a type is always read as the newest row, even after multiple toggles.

**Definition of Done.** A brand-new phone number can complete every onboarding step and land back on their original branch selection. Profile edits (avatar, notification lead times, marketing consent) persist and are visible on reload.

---

## 6. Phase 4 — Core Queue Engine

**Builds on:** Phase 3's complete customer accounts, Phase 2's branch/service/price data.

**Scope.** Customer: the Book tab's "Join Now" path in full (App Flow section 7.5, steps 1–3 plus Review & Confirm), calling the `/tickets/join` endpoint (backend schema section 17) which itself calls `next_ticket_number()` (schema 15.1). Staff: Live Queue and Add Walk-in (App Flow sections 8.5–8.6), calling `/tickets/walk-in`. Both produce the identical ticket shape per PRD section 12.1 — this phase is a good place to add a test asserting exactly that (a walk-in ticket and a self-service ticket for the same branch/service are structurally identical except for `created_by`). Build the Ticket Tracking Screen (App Flow section 7.6) against real live data: position, wait estimate, avatar animation with its reduced-motion fallback (PRD section 18), and the Cancellation Reason Sheet (App Flow section 7.7). Implement the PRD section 17 wait-time calculation as the TypeScript logic the backend schema document deliberately left out of SQL (schema section 15.2's note) — it should read `barber_service_stats` where a barber has enough history and fall back to `services.default_duration_minutes` otherwise, and recompute whenever `recalculate_positions()` fires or a `service_sessions` row starts/ends.

This phase is where PRD section 34's idempotency and concurrency requirements get their first real test: a double-tap on Join Now must never create a second active ticket (the `one_active_ticket_per_customer_branch` unique index, schema section 7, should make the second attempt a no-op that returns the existing ticket), and two staff members racing to edit the same ticket must have the second one rejected with the current state shown, not silently overwritten (the `version` column, checked and incremented on every update).

**Verification.** An automated duplicate-join test (fire the same join request twice concurrently, assert exactly one ticket exists). An automated concurrent-edit test (two simulated staff updates against the same ticket version, assert the second is rejected). A Playwright test spanning both apps: a customer joins, a staff user completes the ticket ahead of them, and the customer's position/wait estimate updates live with no page refresh.

**Definition of Done.** Join-now and walk-in both produce live, trackable tickets. Position and wait estimate update in real time as other tickets in the same queue change state. The duplicate-join and concurrent-edit tests both pass.

---

## 7. Phase 5 — Barber Interface and No-Show Handling

**Builds on:** Phase 4's live ticket lifecycle.

**Scope.** Barber login for both modes (App Flow section 9.1): personal-device login reuses Phase 1's staff auth directly; shared-station PIN login implements the Edge Function flow in backend schema section 3.3 in full, including the PIN being set/rotated from Staff & Roles (App Flow section 8.12) and never stored or transmitted in plaintext. Build Today's Queue (App Flow section 9.2) — acknowledge, not-present, mark-complete, and the status toggle — and the Not-Present Confirmation modal (section 9.3), which is what actually starts the grace-period countdown on the ticket (`grace_period_expires_at`, backend schema section 7). Schedule the `expire-no-show-grace-periods` `pg_cron` job (schema section 15.3) for real in this phase, extended from that document's illustrative version to also write the corresponding `queue_events` row and enqueue the release notification (still through the stub notification sender until Phase 7). Wire the `barber_service_stats`-updating trigger (schema section 15.4) since real service sessions now exist to feed it. Implement End of Shift (App Flow section 9.4) and verify the shared-station handoff actually clears the prior barber's queue view.

This is also where the full no-show escalation cross-surface journey (App Flow section 10) needs to work end-to-end for the first time: barber flags absent → the ticket surfaces as a highlighted, alerted row in Live Queue (App Flow section 8.5) → if the grace period lapses, the customer's Ticket Tracking Screen shows the "released" state with an immediate one-tap rejoin, and the next eligible ticket is called automatically.

**Verification.** A test that advances a ticket to `called`, lets its grace period lapse (either by manipulating `grace_period_expires_at` directly or waiting out a shortened test-only interval), and asserts the cron job transitions it to `no_show` and the next ticket is called. A Playwright test covering the full cross-surface journey above. A test confirming a barber PIN only authenticates against the correct branch's stations, per schema section 3.3's "wrong branch" case.

**Definition of Done.** Every path through the ticket lifecycle in PRD section 12.3 — including both exception paths, `Grace Period → No Show → Cancelled` and `Skip → Waiting` — has been exercised by an automated test and works when driven manually across the barber, staff, and customer surfaces together.

---

## 8. Phase 6 — Appointments

**Builds on:** Phase 4's queue engine (appointments convert into exactly that engine) and Phase 5's no-show mechanism (a late appointment reuses it).

**Scope.** Customer: the Book tab's "Schedule" path (App Flow section 7.5's divergence at step 4 — Date & Time, then Review & Confirm), Appointment Confirmation, Appointment Detail with reschedule/cancel (section 7.8), and the Upcoming section of the Queue tab (section 7.4). Staff: Appointments Calendar and its own Appointment Detail view with reschedule/cancel/no-show/manual-check-in actions (App Flow sections 8.7–8.8). Schedule the `activate-due-appointments` `pg_cron` job (backend schema section 15.3) for real, extended the same way as Phase 5's grace-period job to write its own `queue_events` row. Confirm the appointment-buffer behavior from PRD section 14.4 (walk-ins around a scheduled slot aren't pushed behind it) actually holds once real appointments and real walk-ins coexist in the same branch's queue.

**Verification.** A test that creates an appointment with a near-future `scheduled_start`, lets the cron job run, and asserts a `queue_tickets` row appears referencing it with `appointments.status = 'converted'`. A test for the late-arrival path: an appointment past its slot plus grace period follows the identical state transitions Phase 5 already tested for a called walk-in, confirming PRD section 21's "one no-show state machine... not two separate ones" is actually true in the implementation, not just the design.

**Definition of Done.** A booked appointment automatically becomes a live, trackable ticket at its scheduled window with no manual action. A late arrival is handled by the same mechanism as a called walk-in. Staff can reschedule, cancel, or manually check in an appointment.

---

## 9. Phase 7 — Real Integrations

**Builds on:** every prior phase's stub notification sender, stub travel-time value, and stub feedback classification.

**Scope.** The OTP path's SMS delivery is already real from Phase 1 (the `send-sms` Send SMS Hook, backend schema section 17). This phase replaces the stub notification sender used since Phases 4–6 (for ticket-lifecycle and appointment notifications) with the real Supabase Edge Functions from tech stack section 13: the same Arkesel-backed `send-sms` function (reused, not rebuilt) and the `web-push`-backed push function, both triggered by the Postgres webhooks named in backend schema section 17's table. Implement the push-fallback-to-SMS behavior for time-critical messages (PRD section 20/34) and notification delivery-status tracking (`notifications.status`, schema section 10). Build Google Maps integration (tech stack section 11): the customer-side `@googlemaps/js-api-loader` for branch discovery/distance display, the server-side Distance Matrix proxy endpoint (`/maps/travel-time`, backend schema section 17) keeping the server API key off the client, and the geofence arrival detection (PRD section 19) driving the automatic check-in call already scaffolded in Phase 4. Wire the Gemini feedback-classification Edge Function (tech stack section 12) for real, triggered by the `feedback-created` webhook, writing `gemini_themes` back onto the `feedback` row, and confirm the low-rating internal alert (PRD section 29) actually reaches a branch manager through the now-real notification path.

**Verification.** An integration test suite that actually exercises each provider against a sandbox/test account where one exists (Google Maps offers this; confirm whether Arkesel offers a sandbox or test-credit mode before this phase runs — if not, verification falls back to a real low-volume send against a real test number) rather than mocking the HTTP call — this phase is specifically about proving the real integrations work, so mocking them here would defeat the point. A manual verification pass (documented, not automated) confirming a real SMS and a real push notification are received on a physical or emulated device for at least one ticket-lifecycle event each.

**Definition of Done.** A real SMS and a real push notification are confirmed received for a ticket-lifecycle event. Geofence-based automatic check-in is confirmed working with real or simulated device location. A feedback submission with free-text comment is confirmed classified by Gemini within a reasonable delay, and a below-threshold rating is confirmed reaching a branch manager.

---

## 10. Phase 8 — CRM, Reporting, and RBAC Completion

**Builds on:** every feature phase before it — this phase is largely about surfacing and verifying data that already exists, plus the messaging/broadcast and reporting screens that haven't been touched yet.

**Scope.** Customer CRM (App Flow section 8.10) reading the `customer_segments` view (backend schema section 13) and the reliability counters, styled per that section's note that the flag is "never presented as a warning label, just a data point." Message Customer and Broadcast (App Flow section 8.11), the latter checking `consents` for `marketing` per recipient before sending (backend schema section 17's `/staff/broadcast` note) and showing the segment size before the confirmation step PRD section 28 requires. Reports (App Flow section 8.13) and the Business-Wide Dashboard (section 8.4) against the metrics defined in PRD sections 30–31, built on `queue_events` as that section specifies rather than reconstructed from ticket end-states alone. The Audit Log viewer (App Flow section 8.12) reading the `audit_log` table.

This phase also runs the full RBAC verification pass the backend schema document set up the mechanism for but didn't itself execute: every row of PRD section 32's table becomes an automated test — a Receptionist genuinely cannot reach Reports or Settings in the UI *and* is rejected at the RLS layer if they try the underlying request directly; an Analyst can view every report in their scope and mutate nothing; a Barber can act only on their own current ticket. This is deliberately late in the plan because it's the point where every role, every screen, and every capability actually exist to be tested together — running it earlier would only cover whatever subset of the app existed at the time.

**Verification.** One automated test per row of the PRD's RBAC table (section 32) — a test matrix, not a handful of spot checks. Report-output tests against a seeded historical dataset with known expected aggregates.

**Definition of Done.** Every cell of the PRD's RBAC table has a passing automated test behind it. Reports and dashboards render correct, verifiable numbers against seeded data. A broadcast to a segment respects marketing consent with zero exceptions.

---

## 11. Phase 9 — Localization and Accessibility

**Builds on:** every screen built in Phases 2–8, all of which have been emitting English-only translation keys since Phase 2.

**Scope.** Populate French, Chinese, Spanish, and German message files for every key that exists by this point, per tech stack section 10, including the Noto Sans SC fallback for the Chinese locale specified in the design system document. Verify the language switcher (App Flow section 3's global pattern) actually applies instantly across every open screen, tab-bar/sidebar labels included, without a reload. Run a full accessibility pass against both apps: keyboard-only navigation through every core flow, color-independent status communication (already designed into the status badges per the design system, but verified here against real screens rather than the style guide alone), the reduced-motion path for the queue animation (PRD section 18) confirmed with `prefers-reduced-motion` actually set, and a contrast re-check of real rendered screens against the exact values computed in the design system document's section 3.4 — catching any place an implementation drifted from a token, not re-deriving the values themselves.

**Verification.** An automated `axe-core`-based accessibility check integrated into the Playwright suite. A locale-completeness check (a script asserting every key present in the English message file is also present in the other four) run in CI so a future PR can't silently ship an English string inside a non-English locale.

**Definition of Done.** All five languages are complete and switch instantly with no missing-key fallbacks to English anywhere. The automated accessibility check passes on every core screen. A manual keyboard-only run completes the full remote-walk-in and scheduled-appointment journeys from PRD section 44.

---

## 12. Phase 10 — Hardening and Production Launch

**Builds on:** the complete, localized, accessible application from Phase 9.

**Scope.** Work through PRD section 34's full edge-case table as a dedicated test suite, not spot checks: idempotent duplicate actions, optimistic-concurrency conflicts (both already covered in Phase 4, re-run here as part of the complete suite), offline handling and reconnection sync, SMS/push delivery failure and fallback, a barber calling in sick mid-shift and bulk reassignment, a branch closing unexpectedly, and every row of that table's scenario list. Run a performance pass against PRD section 38's non-functional requirements — Lighthouse or equivalent against the customer PWA on a throttled connection profile representative of typical Ghanaian mobile networks, and a check that dashboard metrics update without a full page reload under realistic data volume. Run a security review: an audit of every RLS policy against the four shapes in backend schema section 14.1 (confirming nothing was left with RLS enabled but no policies, which fails open to nothing rather than failing closed), confirmation the service-role key never reaches a client bundle, and rate limiting on the OTP and login endpoints. Set up the observability PRD section 38 calls for — logging and monitoring for API failures, queue processing errors, notification delivery failures, authentication anomalies, and sync conflicts — before, not after, production traffic exists to generate them. Finally, promote the schema to production (`supabase db push` against the production project), deploy both apps to their production Vercel projects with real environment variables throughout, and run every acceptance criterion in PRD section 40 against the live production environment as the final gate.

**Verification.** The full PRD section 34 edge-case suite, automated where the scenario allows it (idempotency, concurrency, delivery fallback) and manually verified where it genuinely requires a physical condition (offline device, real network throttling). A production smoke test repeating PRD section 44's four user journeys against the live environment.

**Definition of Done.** Every PRD section 40 acceptance criterion passes against production, not staging. Monitoring shows a clean baseline with no unexplained errors in the first observation window. A documented rollback path exists (reverting the Vercel deployment and, if needed, the last migration) before this phase is considered closed.

---

## 13. What Happens After This Plan

This plan's Definition of Done for Phase 10 is PRD section 39's Phase 1 — the MVP — live in production. PRD section 39's own Phase 2 items not already covered here (per this plan's own notes in Phases 4, 5, 7, and 8 on what the MVP build already had to deliver) are deliberately not sequenced in this document, per this document's locked scope — they're sequenced instead in `pixel-barber-implementation-plan-phase-2.md` (currently Phases 11–15: cross-branch ticket transfer, expanded avatar personalization, in-app messaging, CRM/reporting depth, and biometric login), which picks up exactly where this plan's Phase 10 ends. PRD Phase 3 (the predictive/conversational AI direction in PRD section 27) stays out of scope for both documents, deliberately left unspec'd until real production data from Phases 1–2 exists for it to build on, which is also exactly the order PRD section 27 itself argues for. Naming this list by reference rather than re-stating it here is deliberate too — PRD section 39 and the Phase 2 plan's own section 0 are the source of truth for what Phase 2 actually contains, and it has already grown since this plan was first written.
