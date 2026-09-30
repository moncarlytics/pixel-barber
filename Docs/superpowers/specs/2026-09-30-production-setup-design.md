# Design: Production Supabase Setup — "Ready, not launched"

**Date:** 2026-09-30
**Status:** Approved in brainstorming, awaiting written-spec review
**Origin:** Both Vercel apps (`https://pixel-barber-customer.vercel.app`,
`https://pixel-barber-staff.vercel.app`) are built against the production Supabase project
(`yegnbwrmdlhicpzbnldl`), but that project is paused (free-plan inactivity), has no Edge Functions,
and has never received the schema. Every feature so far lives only on staging
(`bfkokxcdgvrnevtpeycw`). This slice brings production up to the same state as staging so the Owner
can test end to end and invite staff, without announcing it to customers.

## Goal

Production runs every feature built so far — schema, seed data, scheduled jobs, Edge Functions,
auth hooks, secrets, the Owner account — with live SMS **off**, and a written runbook records how it
was set up and how each later feature is promoted from staging.

## Decisions

1. **Scope: "ready, not launched."** Production becomes fully working, but it is not a public
   launch. The implementation plan's Phase 10 hardening (PRD §34 edge-case suite, performance and
   security pass, monitoring, PRD §40 acceptance run) still gates the public launch and is out of
   scope here.
2. **Plan: stay on the Supabase free plan for now.** The project may pause again after about a week
   without use; restoring it from the dashboard keeps all data. Upgrading to Pro (no pausing, daily
   backups) is a go-live checklist item.
3. **Approach A: a CLI runbook.** Use the same Supabase CLI commands already proven on staging, each
   one naming production explicitly with `--project-ref yegnbwrmdlhicpzbnldl`, run by the
   controller with the user's approval, and recorded in `Docs/ops/production-setup.md`. Chosen over
   dashboard clicking (slow, error-prone, unrecorded) and a GitHub Actions deploy pipeline (worth
   having once live changes are frequent — later).
4. **The Owner creates their own account.** The user runs `scripts/bootstrap-owner.mjs` against
   production themselves, so their password never passes through Claude.

## Section 1 — What gets set up, in order

1. **Restore the project** from the dashboard. The free plan allows two active projects; staging and
   production make two (the old `PixelBarber Revenue Tracker` project stays inactive and untouched).
2. **Apply all migrations** (`supabase db push`, currently 52 files, `20260911210000` →
   `20260925150000`). This also creates the seed data (`20260911211700_seed_data.sql`: the business,
   the "Pixel Barber" branch with address `TBD` and the placeholder Accra coordinate, 9am–9pm
   Monday–Saturday hours, and the 15 services with GHS prices) and the `pg_cron` jobs, including the
   30-second `send-notifications` call.
3. **Deploy all 9 Edge Functions:** `barber-pin-set`, `pin-login`, `send-notifications`, `send-sms`,
   `staff-invite`, `staff-invite-accept`, `staff-manage`, `tickets-join`, `tickets-walk-in`. The
   `verify_jwt = false` settings in `config.toml` (`send-sms`, `pin-login`, `staff-invite-accept`)
   apply the same way as on staging.
4. **Function secrets (production values):**
   - `ARKESEL_API_KEY`, `ARKESEL_SENDER_ID` — the same Arkesel account as staging.
   - `SEND_SMS_HOOK_SECRET` — a **new** secret generated for production (Standard Webhooks format,
     `v1,whsec_<base64>`), never staging's.
   - `CUSTOMER_APP_URL=https://pixel-barber-customer.vercel.app`
   - `STAFF_APP_URL=https://pixel-barber-staff.vercel.app`
   - `SMS_NOTIFICATIONS_ALLOWLIST` — the Owner's own phone number only (the number itself is kept
     out of the repo).
   - `SMS_NOTIFICATIONS_LIVE` — **not set** (live texting off).
   - `RESEND_API_KEY` / `INVITE_EMAIL_FROM` — not set (email invites report "not configured", as on
     staging).
5. **Vault secrets:** `project_url` (`https://yegnbwrmdlhicpzbnldl.supabase.co`) and
   `notifications_dispatch_key` (production's service role key), created the same way as on
   staging: a temporary SQL file in the session scratchpad, written by a script that obtains the key
   without printing it, run by a command that targets production explicitly (never `--linked`, which
   points at staging), then deleted.
6. **Auth configuration** (`supabase config push --project-ref yegnbwrmdlhicpzbnldl`): the
   `custom_access_token` hook, the `send_sms` hook pointed at production's own `send-sms` function
   with production's hook secret, phone signup with confirmations, and a `site_url` of the customer
   app instead of `localhost`.
7. **Owner account:** the user runs `scripts/bootstrap-owner.mjs <email> <password> "<name>"` with
   `NEXT_PUBLIC_SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` set to production's values for that one
   command (the script's `dotenv` load does not override variables already set).
8. **Vercel apps:** no change expected — both are already built against production. Confirm they
   work once production is awake.

### Known limits (not fixed by this slice)

- Until Arkesel approves a sender ID, every SMS on production fails to deliver: customer login codes
  (so customers can't sign up yet), SMS staff invites, and "you're next" texts.
- Email staff invites need Resend configured; until then staff can only be invited by phone (which
  itself waits on the sender ID).

## Section 2 — Keeping staging and production separate

- **`config.toml` stops naming staging.** Two values become environment substitutions:
  - `[auth.hook.send_sms] uri = "env(SEND_SMS_HOOK_URI)"`
  - `[auth] site_url = "env(AUTH_SITE_URL)"`

  Staging's values (`https://bfkokxcdgvrnevtpeycw.supabase.co/functions/v1/send-sms` and
  `http://localhost:3000`) are added to the existing git-ignored `supabase/.secrets/send-sms.env`,
  which is already sourced before every CLI command. Production's values live in a new git-ignored
  `supabase/.secrets/production.env` (`SEND_SMS_HOOK_URI`, `AUTH_SITE_URL`,
  `SEND_SMS_HOOK_SECRET`, and the Arkesel keys), sourced instead of `send-sms.env` for production
  commands. Pushing staging's config after this change must produce no difference on staging
  (checked with `supabase config push`'s diff before confirming).
- **Every production command names production.** Each command carries
  `--project-ref yegnbwrmdlhicpzbnldl` (or production's DB URL); the repo stays linked to staging.
- **No automated tests against production, ever.** The test suites create customers with made-up
  Ghana numbers and other fake data; production is verified by hand (Section 3).
- **Promotion routine.** From now on a finished feature goes to staging first and to production
  only after the user approves, following the runbook's "promote to production" steps: push
  migrations, deploy changed functions, set any new secrets, push config if changed.

## Section 3 — Verification, risks, records

### Manual verification on production

- The migration list for production shows all migrations applied; the branch, 15 services and hours
  exist; `cron.job` lists the scheduled jobs.
- After the Vault secrets exist, `net._http_response` shows the `send-notifications` calls returning
  200 (not 401/500).
- All 9 functions are listed as deployed; an unauthenticated call to `send-notifications` returns
  401.
- `https://pixel-barber-customer.vercel.app` shows the Pixel Barber branch and its services.
- The Owner logs into `https://pixel-barber-staff.vercel.app` and reaches the dashboard and
  settings.
- `supabase secrets list --project-ref yegnbwrmdlhicpzbnldl` shows `SMS_NOTIFICATIONS_LIVE` absent
  and the allowlist present.

### Risks

- **A migration fails on a fresh database.** Staging received the migrations one at a time over
  weeks; production gets all of them in one run. If one fails, the push stops there; the fix is a
  new forward migration (never editing an applied one), then the push continues. Production has no
  real data, so nothing is at risk.
- **The project pauses again.** Restore from the dashboard; data is kept.
- **Rollback.** Production holds no customer data yet; the worst case is resetting it and replaying
  the runbook.

### Records

`Docs/ops/production-setup.md`: the ordered steps with exact commands, which settings exist on
production (names only, never values), the promotion routine, and the go-live checklist below. The
project memory note is updated with production's state.

## Go-live checklist (before real customers — out of scope here)

1. Arkesel sender ID approved; set `ARKESEL_SENDER_ID` on production to the approved name.
2. Upgrade production to Supabase Pro (no pausing, daily backups).
3. Decide on a custom domain; if used, update `CUSTOMER_APP_URL`, `STAFF_APP_URL`, `AUTH_SITE_URL`.
4. Optional: Resend configured for email invites.
5. First live text on production with the allowlist; then remove the allowlist and set
   `SMS_NOTIFICATIONS_LIVE=true`.
6. The implementation plan's Phase 10 hardening completed.

## Out of scope

- A GitHub Actions deploy pipeline.
- Phase 10 hardening, monitoring and observability.
- Custom domains, the Pro upgrade, Resend setup, the Arkesel sender ID.
- Any data migration from staging (production starts from the seed data only).
