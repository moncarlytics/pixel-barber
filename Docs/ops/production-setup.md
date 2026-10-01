# Production runbook

How the production Supabase project was set up, what lives where, and how to promote each finished
feature from staging. Design: `Docs/superpowers/specs/2026-09-30-production-setup-design.md`.

Status (2026-10-01): production is **ready, not launched** — every feature through the queue SMS
slice is live there, live texting is off, and the Owner account exists (step 7).

## 1. Environments

| | Staging | Production |
|---|---|---|
| Supabase project | `pixel-barber-staging`, ref `bfkokxcdgvrnevtpeycw` | `pixel-barber-production`, ref `yegnbwrmdlhicpzbnldl` |
| Used by | automated tests, CI, local dev (`.env.local`), the repo's `supabase link` | both Vercel apps |
| Customer app | `http://localhost:3000` | `https://pixel-barber-customer.vercel.app` |
| Staff app | `http://localhost:3001` | `https://pixel-barber-staff.vercel.app` |
| Local secrets file (git-ignored) | `supabase/.secrets/send-sms.env` | `supabase/.secrets/production.env` |

Secrets files — variable **names** (never commit values):

- `send-sms.env`: `SEND_SMS_HOOK_SECRET`, `ARKESEL_API_KEY`, `ARKESEL_SENDER_ID`, `SEND_SMS_HOOK_URI`,
  `AUTH_SITE_URL`
- `production.env`: the same five (production values; its own hook secret), plus `CUSTOMER_APP_URL`,
  `STAFF_APP_URL`

`supabase/config.toml` reads `site_url` and the send-SMS hook `uri` from `AUTH_SITE_URL` /
`SEND_SMS_HOOK_URI`, so **source the right file before every CLI command**:

```bash
set -a && source supabase/.secrets/production.env && set +a   # production
set -a && source supabase/.secrets/send-sms.env && set +a     # staging
```

Rules:

- Every production command names production: `--project-ref yegnbwrmdlhicpzbnldl`. The repo stays
  linked to staging.
- `supabase db query` only accepts a project ref together with `--linked`:
  `npx supabase db query --linked --project-ref yegnbwrmdlhicpzbnldl "<sql>"` — this does reach
  production (verified 2026-09-30). The Supabase MCP `execute_sql` with
  `project_id: yegnbwrmdlhicpzbnldl` also works for read-only checks.
- **Never run the automated test suites against production** — they create customers with made-up
  Ghana numbers.
- Never print secret values; scripts write them straight into files or env vars.

Production function secrets: `SEND_SMS_HOOK_SECRET`, `ARKESEL_API_KEY`, `ARKESEL_SENDER_ID`,
`CUSTOMER_APP_URL`, `STAFF_APP_URL`, `SMS_NOTIFICATIONS_ALLOWLIST` (the Owner's own number only).
`SMS_NOTIFICATIONS_LIVE` is **not set**. Vault: `project_url`, `notifications_dispatch_key`.

## 2. Initial setup (done 2026-09-30)

1. **Restore** the paused project (Supabase MCP `restore_project`, or the dashboard's *Restore
   project*), wait for `ACTIVE_HEALTHY`.
2. **Migrations:**
   ```bash
   npx supabase db push --project-ref yegnbwrmdlhicpzbnldl --dry-run
   npx supabase db push --project-ref yegnbwrmdlhicpzbnldl --yes
   ```
   All 52 migrations applied cleanly on the fresh database (no DB password prompt). Result: 15
   services, 1 branch (address `TBD`), 7 hour rows, cron jobs `activate-due-appointments`,
   `expire-no-show-grace-periods`, `fill-barber-schedules`, `send-notifications` (same as staging).
3. **Edge Functions:**
   ```bash
   npx supabase functions deploy --project-ref yegnbwrmdlhicpzbnldl
   ```
   All 9 deploy; `verify_jwt` is false only for `send-sms`, `pin-login`, `staff-invite-accept`.
   A deploy can fail with "unexpected deploy status 500 … internal error" (Supabase-side; happened
   once for `send-sms`) — redeploy that one function: `npx supabase functions deploy send-sms
   --project-ref yegnbwrmdlhicpzbnldl`.
4. **Function secrets:**
   ```bash
   npx supabase secrets set --project-ref yegnbwrmdlhicpzbnldl \
     "SEND_SMS_HOOK_SECRET=$SEND_SMS_HOOK_SECRET" "ARKESEL_API_KEY=$ARKESEL_API_KEY" \
     "ARKESEL_SENDER_ID=$ARKESEL_SENDER_ID" "CUSTOMER_APP_URL=$CUSTOMER_APP_URL" \
     "STAFF_APP_URL=$STAFF_APP_URL" "SMS_NOTIFICATIONS_ALLOWLIST=<Owner's number>"
   ```
5. **Vault secrets** (the cron job's URL and key): a Node script reads the `service_role` key from
   `npx supabase projects api-keys --project-ref yegnbwrmdlhicpzbnldl -o json` without printing it,
   writes `select vault.create_secret(<url>, 'project_url'); select vault.create_secret(<key>,
   'notifications_dispatch_key');` to a temp file in the session scratchpad, which is run with
   `npx supabase db query --linked --project-ref yegnbwrmdlhicpzbnldl -f <file>` and deleted.
   Check: `select status_code, count(*) from net._http_response group by status_code;` → only `200`.
6. **Auth config:**
   ```bash
   echo n | npx supabase config push --project-ref yegnbwrmdlhicpzbnldl   # review the diff
   npx supabase config push --project-ref yegnbwrmdlhicpzbnldl --yes
   ```
   Enables the `custom_access_token` and `send_sms` hooks (production's own `send-sms` URL and hook
   secret), phone signup with confirmations, `site_url` = the customer app. The note
   "auth.sms.twilio.enabled could not be encoded" also appears on staging and is harmless.
7. **Owner account (done 2026-10-01).** Simplest way, used for production:
   1. Supabase dashboard → project `pixel-barber-production` → **Authentication → Users → Add user →
      Create new user**: email + password, tick **Auto Confirm User**.
   2. Link that login to an Owner row (Supabase MCP `execute_sql` or the SQL editor):
      ```sql
      insert into staff_users (auth_user_id, name, email, role, invite_status, invite_accepted_at)
      select id, '<display name>', email, 'owner', 'accepted', now()
      from auth.users where lower(email) = '<owner email>';
      ```

   Alternative (terminal; got stuck once on quoting, so prefer the above) — run once in PowerShell
   from the project folder, with your own email, password and name (single quotes):
   ```powershell
   Get-Content supabase\.secrets\production.env | ForEach-Object { if ($_ -match '^\s*([^#=]+)=(.*)$') { Set-Item "env:$($matches[1].Trim())" $matches[2].Trim('"') } }
   $env:NEXT_PUBLIC_SUPABASE_URL = "https://yegnbwrmdlhicpzbnldl.supabase.co"
   $env:SUPABASE_SERVICE_ROLE_KEY = ((npx supabase projects api-keys --project-ref yegnbwrmdlhicpzbnldl -o json | ConvertFrom-Json) | Where-Object { $_.name -eq 'service_role' }).api_key
   npm run bootstrap:owner -- 'you@example.com' 'YourStrongPassword' 'Your Name'
   Remove-Item Env:SUPABASE_SERVICE_ROLE_KEY, Env:NEXT_PUBLIC_SUPABASE_URL
   ```
   Expect `Owner staff_users row created: <id>`. Running it twice with the same email fails (the
   email already exists). Then log into the staff app with that email and password.

## 3. Promote a finished feature to production

Staging always first; production only after the Owner approves.

```bash
set -a && source supabase/.secrets/production.env && set +a
npx supabase db push --project-ref yegnbwrmdlhicpzbnldl --dry-run    # review the list
npx supabase db push --project-ref yegnbwrmdlhicpzbnldl --yes
npx supabase functions deploy <changed-function> --project-ref yegnbwrmdlhicpzbnldl
npx supabase secrets set --project-ref yegnbwrmdlhicpzbnldl NEW_SECRET=...   # only if new secrets
echo n | npx supabase config push --project-ref yegnbwrmdlhicpzbnldl         # only if config.toml changed; review, then --yes
```

Then the checks:

- `curl -s -o /dev/null -w '%{http_code}' -X POST https://yegnbwrmdlhicpzbnldl.supabase.co/functions/v1/send-notifications` → `401`
- `select status_code, count(*) from net._http_response where created > now() - interval '5 minutes' group by status_code;` → only `200`
- `npx supabase secrets list --project-ref yegnbwrmdlhicpzbnldl` → no `SMS_NOTIFICATIONS_LIVE` unless deliberately enabled
- Open both apps and use the changed feature.

If `config.toml` gains a new per-environment value, add it to **both** secrets files.

## 4. If production is paused

The free plan pauses a project after about a week without use. Restore it from the dashboard (or
MCP `restore_project`); data is kept. Wait for `ACTIVE_HEALTHY` before running anything.

## 5. Go-live checklist (before real customers)

1. Arkesel sender ID approved; set `ARKESEL_SENDER_ID` on production to the approved name.
2. Upgrade production to Supabase Pro (no pausing, daily backups).
3. Decide on a custom domain; if used, update `CUSTOMER_APP_URL`, `STAFF_APP_URL`, `AUTH_SITE_URL`.
4. Optional: Resend configured for email invites (`RESEND_API_KEY`, `INVITE_EMAIL_FROM`).
5. First live text on production with the allowlist; then remove the allowlist and set
   `SMS_NOTIFICATIONS_LIVE=true`.
6. The implementation plan's Phase 10 hardening completed.
