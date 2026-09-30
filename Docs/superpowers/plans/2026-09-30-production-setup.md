# Production Supabase Setup Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> **Execution note for this plan:** almost every task writes to the live production project (restore,
> migrations, function deploys, secrets, Vault, auth config). Implementer subagents may not do any
> of those, so this plan is executed **inline by the controller**, stopping for the user's approval
> before each production write.

**Goal:** Bring the production Supabase project (`yegnbwrmdlhicpzbnldl`) up to staging's state — schema, seed data, cron jobs, Edge Functions, secrets, Vault, auth hooks, Owner account — with live SMS off, and record it in a runbook.

**Architecture:** The same Supabase CLI commands already proven on staging, each naming production with `--project-ref yegnbwrmdlhicpzbnldl`. `config.toml` stops hardcoding staging: the send-SMS hook URI and `site_url` become `env()` substitutions, fed by the git-ignored `supabase/.secrets/send-sms.env` (staging) or the new git-ignored `supabase/.secrets/production.env` (production). The repo stays linked to staging.

**Tech Stack:** Supabase CLI v2.117, Supabase MCP (`restore_project`, `get_project`, `list_edge_functions`), Git Bash, Node (one-off scripts that never print secrets), PowerShell (the user's Owner-account step).

**Spec:** `Docs/superpowers/specs/2026-09-30-production-setup-design.md`

## Global Constraints

- Production ref: `yegnbwrmdlhicpzbnldl`. Staging ref: `bfkokxcdgvrnevtpeycw`. Every production command passes `--project-ref yegnbwrmdlhicpzbnldl`; never `--linked` for production (the repo is linked to staging).
- Before any production CLI command: `set -a && source supabase/.secrets/production.env && set +a`. Before any staging CLI command: `set -a && source supabase/.secrets/send-sms.env && set +a`.
- Never print a secret value (service role key, hook secret, Arkesel keys, DB password). Scripts write secrets straight into files or env vars; temporary files live in the session scratchpad and are deleted after use.
- Every production write (restore, `db push`, `functions deploy`, `secrets set`, Vault SQL, `config push`) needs the user's explicit approval first.
- No automated test suite is ever run against production.
- Production values: `CUSTOMER_APP_URL=https://pixel-barber-customer.vercel.app`, `STAFF_APP_URL=https://pixel-barber-staff.vercel.app`, `AUTH_SITE_URL=https://pixel-barber-customer.vercel.app`, `SEND_SMS_HOOK_URI=https://yegnbwrmdlhicpzbnldl.supabase.co/functions/v1/send-sms`, Vault `project_url=https://yegnbwrmdlhicpzbnldl.supabase.co`.
- `SMS_NOTIFICATIONS_LIVE` is **not** set on production. `SMS_NOTIFICATIONS_ALLOWLIST` is the Owner's own number (kept out of the repo — it lives only in the memory note and the secret).
- `SEND_SMS_HOOK_SECRET` for production is newly generated (`v1,whsec_<base64 of 32 random bytes>`), never staging's.
- Do not stage `apps/*/next-env.d.ts`, `graphify-out/`, `playwright-report/`, `test-results/`, `supabase/.secrets/`, or the untracked `Docs/superpowers/plans/2026-09-1*` files. No AI-attribution lines in commits. Ask before pushing to `origin/main`.

---

### Task 1: Make `config.toml` environment-driven (staging unchanged)

**Files:**
- Modify: `supabase/config.toml:161` (`site_url`) and `supabase/config.toml:301` (`[auth.hook.send_sms] uri`)
- Modify (git-ignored, local only): `supabase/.secrets/send-sms.env`

**Interfaces:**
- Produces: two env variables every CLI run must now have — `SEND_SMS_HOOK_URI`, `AUTH_SITE_URL`.

- [ ] **Step 1: Add staging's values to the staging secrets file** (appends two lines; prints names only)

```bash
cd "/c/Users/T490s i7/OneDrive/Desktop/All/Clients/Pixel Barber"
printf '%s\n' \
  'SEND_SMS_HOOK_URI=https://bfkokxcdgvrnevtpeycw.supabase.co/functions/v1/send-sms' \
  'AUTH_SITE_URL=http://localhost:3000' >> supabase/.secrets/send-sms.env
sed 's/=.*/=<redacted>/' supabase/.secrets/send-sms.env
```

Expected: five names — `SEND_SMS_HOOK_SECRET`, `ARKESEL_API_KEY`, `ARKESEL_SENDER_ID`, `SEND_SMS_HOOK_URI`, `AUTH_SITE_URL`.

- [ ] **Step 2: Edit `config.toml`**

Replace line 161:

```toml
site_url = "http://localhost:3000"
```

with:

```toml
# Per-environment (supabase/.secrets/send-sms.env for staging, production.env for production).
site_url = "env(AUTH_SITE_URL)"
```

Replace line 301:

```toml
uri = "https://bfkokxcdgvrnevtpeycw.supabase.co/functions/v1/send-sms"
```

with:

```toml
# Per-environment: each project's own send-sms function (see supabase/.secrets/*.env).
uri = "env(SEND_SMS_HOOK_URI)"
```

- [ ] **Step 3: Prove staging sees no change** (answers "no" to the push prompt; only shows the diff)

```bash
set -a && source supabase/.secrets/send-sms.env && set +a
echo n | npx supabase config push --project-ref bfkokxcdgvrnevtpeycw 2>&1 | tail -30
```

Expected: no diff lines for `site_url` or the `send_sms` hook. If the diff shows `site_url`/hook changes, the `env()` substitution did not resolve — stop and investigate; never answer yes here. (Unrelated pre-existing drift, if any, is reported to the user, not pushed.)

- [ ] **Step 4: Commit**

```bash
git add supabase/config.toml
git commit -m "chore: read send-sms hook URI and auth site_url from per-environment secrets"
```

---

### Task 2: Create `supabase/.secrets/production.env`

**Files:**
- Create (git-ignored, local only): `supabase/.secrets/production.env`

**Interfaces:**
- Consumes: `supabase/.secrets/send-sms.env` (Arkesel keys copied from it).
- Produces: `production.env` with `SEND_SMS_HOOK_SECRET`, `ARKESEL_API_KEY`, `ARKESEL_SENDER_ID`, `SEND_SMS_HOOK_URI`, `AUTH_SITE_URL`, `CUSTOMER_APP_URL`, `STAFF_APP_URL`; later tasks source it.

- [ ] **Step 1: Write the file with a script that prints nothing secret**

```bash
cd "/c/Users/T490s i7/OneDrive/Desktop/All/Clients/Pixel Barber"
node -e "
const fs=require('fs'),crypto=require('crypto');
const target='supabase/.secrets/production.env';
if(fs.existsSync(target)) throw new Error('production.env already exists');
const src=Object.fromEntries(fs.readFileSync('supabase/.secrets/send-sms.env','utf8').split(/\r?\n/).filter(l=>/^[A-Z_]+=/.test(l)).map(l=>[l.slice(0,l.indexOf('=')),l.slice(l.indexOf('=')+1)]));
if(!src.ARKESEL_API_KEY||!src.ARKESEL_SENDER_ID) throw new Error('Arkesel keys missing from send-sms.env');
fs.writeFileSync(target,[
 'SEND_SMS_HOOK_SECRET=v1,whsec_'+crypto.randomBytes(32).toString('base64'),
 'ARKESEL_API_KEY='+src.ARKESEL_API_KEY,
 'ARKESEL_SENDER_ID='+src.ARKESEL_SENDER_ID,
 'SEND_SMS_HOOK_URI=https://yegnbwrmdlhicpzbnldl.supabase.co/functions/v1/send-sms',
 'AUTH_SITE_URL=https://pixel-barber-customer.vercel.app',
 'CUSTOMER_APP_URL=https://pixel-barber-customer.vercel.app',
 'STAFF_APP_URL=https://pixel-barber-staff.vercel.app',
].join('\n')+'\n');
"
sed 's/=.*/=<redacted>/' supabase/.secrets/production.env
git check-ignore supabase/.secrets/production.env
```

Expected: seven names with `<redacted>` values, then `supabase/.secrets/production.env` (git ignores it).

- [ ] **Step 2: Confirm production values resolve** (no network call)

```bash
( set -a && source supabase/.secrets/production.env && set +a && echo "$SEND_SMS_HOOK_URI $AUTH_SITE_URL" && test -n "$ARKESEL_API_KEY" && echo arkesel-set )
```

Expected: the production hook URI, the customer app URL, `arkesel-set`.

No commit (the file is git-ignored).

---

### Task 3: Restore the production project

**Files:** none.

- [ ] **Step 1: Ask the user for approval, then restore** with the Supabase MCP tool `restore_project` (`project_id: yegnbwrmdlhicpzbnldl`). If the tool is unavailable or refused, the user presses **Restore project** on the project's dashboard page instead.

- [ ] **Step 2: Wait until healthy.** Check `get_project` (`id: yegnbwrmdlhicpzbnldl`) about once a minute until `status` is `ACTIVE_HEALTHY` (usually a few minutes).

- [ ] **Step 3: Confirm the database has no app migrations yet**

```bash
set -a && source supabase/.secrets/production.env && set +a
npx supabase migration list --project-ref yegnbwrmdlhicpzbnldl 2>&1 | tail -15
```

Expected: every local migration listed with an empty "Remote" column. If the CLI asks for the database password, the user adds `SUPABASE_DB_PASSWORD=<their production DB password>` to `production.env` themselves (the dashboard's Database settings can reset it) — never typed into the conversation.

---

### Task 4: Apply all migrations to production

**Files:** none unless a migration fails (Step 3).

- [ ] **Step 1: Dry run**

```bash
set -a && source supabase/.secrets/production.env && set +a
npx supabase db push --project-ref yegnbwrmdlhicpzbnldl --dry-run 2>&1 | tail -60
```

Expected: all 52 migrations from `20260911210000_extensions_and_shared.sql` to `20260925150000_sms_dispatch_hardening.sql` listed as would-be pushed.

- [ ] **Step 2: Ask the user for approval, then push**

```bash
npx supabase db push --project-ref yegnbwrmdlhicpzbnldl --yes 2>&1 | tail -40
```

Expected: `Finished supabase db push.`

- [ ] **Step 3: If a migration fails,** the push stops at it and earlier ones stay applied. Read the error and write a **new** migration with a later timestamp that fixes the root cause on a fresh database (never edit an applied migration — staging already has it). Push it to **staging first** and confirm staging still applies it cleanly, commit it, then re-run Step 2 on production.

- [ ] **Step 4: Confirm data and jobs, comparing against staging**

```bash
Q="select (select count(*) from services) services, (select count(*) from branches) branches, (select count(*) from branch_hours) hours, (select string_agg(jobname, ', ' order by jobname) from cron.job) jobs"
npx supabase migration list --project-ref yegnbwrmdlhicpzbnldl 2>&1 | tail -5
npx supabase db query --project-ref yegnbwrmdlhicpzbnldl "$Q"
( set -a && source supabase/.secrets/send-sms.env && set +a && npx supabase db query --project-ref bfkokxcdgvrnevtpeycw "select string_agg(jobname, ', ' order by jobname) jobs from cron.job" )
```

Expected: every migration has a Remote timestamp; production shows 15 services, 1 branch, 7 hour rows; production's job list equals staging's.

---

### Task 5: Deploy the Edge Functions

**Files:** none.

- [ ] **Step 1: Ask the user for approval, then deploy all functions**

```bash
set -a && source supabase/.secrets/production.env && set +a
npx supabase functions deploy --project-ref yegnbwrmdlhicpzbnldl 2>&1 | tail -20
```

Expected: 9 functions deployed — `barber-pin-set`, `pin-login`, `send-notifications`, `send-sms`, `staff-invite`, `staff-invite-accept`, `staff-manage`, `tickets-join`, `tickets-walk-in`.

- [ ] **Step 2: Confirm** with the Supabase MCP `list_edge_functions` (`project_id: yegnbwrmdlhicpzbnldl`): 9 functions; `verify_jwt` false only for `send-sms`, `pin-login`, `staff-invite-accept`.

---

### Task 6: Set production function secrets

**Files:** none.

- [ ] **Step 1: Ask the user for approval, then set the secrets** (values come from the sourced env; the allowlist number is the Owner's number from the memory note; nothing is printed)

```bash
set -a && source supabase/.secrets/production.env && set +a
npx supabase secrets set --project-ref yegnbwrmdlhicpzbnldl \
  "SEND_SMS_HOOK_SECRET=$SEND_SMS_HOOK_SECRET" \
  "ARKESEL_API_KEY=$ARKESEL_API_KEY" \
  "ARKESEL_SENDER_ID=$ARKESEL_SENDER_ID" \
  "CUSTOMER_APP_URL=$CUSTOMER_APP_URL" \
  "STAFF_APP_URL=$STAFF_APP_URL" \
  "SMS_NOTIFICATIONS_ALLOWLIST=+233XXXXXXXXX" 2>&1 | head -1
```

(Replace `+233XXXXXXXXX` with the Owner's number when running; it is not written into the repo.)

Expected: `"count":6` and `Finished supabase secrets set.`

- [ ] **Step 2: Confirm names only**

```bash
npx supabase secrets list --project-ref yegnbwrmdlhicpzbnldl 2>&1 | grep -o '"name":"[A-Z_]*"' | sed 's/"name"://;s/"//g'
```

Expected: the six names above plus Supabase's built-in `SUPABASE_*` names; **no** `SMS_NOTIFICATIONS_LIVE`.

---

### Task 7: Create the Vault secrets for the cron job

**Files:** a temporary SQL file in the session scratchpad (deleted in Step 2).

- [ ] **Step 1: Write the SQL without printing the key** (`SCRATCH` = this session's scratchpad directory, in Git Bash form)

```bash
set -a && source supabase/.secrets/production.env && set +a
SQL="$SCRATCH/prod-vault.sql"
npx supabase projects api-keys --project-ref yegnbwrmdlhicpzbnldl -o json 2>/dev/null | node -e "
let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{
  const k=JSON.parse(s).find(x=>x.name==='service_role');
  if(!k||!k.api_key) throw new Error('service_role key not found');
  const q=v=>\"'\"+v.replace(/'/g,\"''\")+\"'\";
  require('fs').writeFileSync(process.argv[1],
    'select vault.create_secret('+q('https://yegnbwrmdlhicpzbnldl.supabase.co')+\", 'project_url');\n\"+
    'select vault.create_secret('+q(k.api_key)+\", 'notifications_dispatch_key');\n\");
  console.log('written');
})" "$SQL"
```

Expected: `written`.

- [ ] **Step 2: Ask the user for approval, run it, delete the file**

```bash
npx supabase db query --project-ref yegnbwrmdlhicpzbnldl -f "$SQL" 2>&1 | tail -3; rm -f "$SQL"; test ! -e "$SQL" && echo deleted
```

Expected: two UUID rows, then `deleted`.

- [ ] **Step 3: Confirm the cron job reaches the function** (wait about a minute first)

```bash
npx supabase db query --project-ref yegnbwrmdlhicpzbnldl "select status_code, count(*) from net._http_response where created > now() - interval '3 minutes' group by status_code"
```

Expected: only `200`. `401` → the dispatch key is wrong; `404` → the function isn't deployed; `500` → read the function's logs (MCP `get_logs`, service `edge-function`).

---

### Task 8: Push auth configuration to production

**Files:** none.

- [ ] **Step 1: Show the diff without applying**

```bash
set -a && source supabase/.secrets/production.env && set +a
echo n | npx supabase config push --project-ref yegnbwrmdlhicpzbnldl 2>&1 | tail -80
```

Expected diff includes: `site_url` → `https://pixel-barber-customer.vercel.app`; the `custom_access_token` hook enabled at `pg-functions://postgres/public/custom_access_token_hook`; the `send_sms` hook enabled at `https://yegnbwrmdlhicpzbnldl.supabase.co/functions/v1/send-sms`; phone signup and confirmations enabled. **Stop if** any value names `bfkokxcdgvrnevtpeycw` or `localhost`.

- [ ] **Step 2: Ask the user for approval (with the diff summary), then apply**

```bash
npx supabase config push --project-ref yegnbwrmdlhicpzbnldl --yes 2>&1 | tail -10
```

- [ ] **Step 3: Confirm no remaining diff**

```bash
echo n | npx supabase config push --project-ref yegnbwrmdlhicpzbnldl 2>&1 | tail -20
```

---

### Task 9: Owner account (the user runs this)

**Files:** none.

- [ ] **Step 1: Give the user these PowerShell commands** for the VS Code terminal in the project folder, with their own email, password and name (typed only by them):

```powershell
Get-Content supabase\.secrets\production.env | ForEach-Object { if ($_ -match '^\s*([^#=]+)=(.*)$') { Set-Item "env:$($matches[1].Trim())" $matches[2].Trim('"') } }
$env:NEXT_PUBLIC_SUPABASE_URL = "https://yegnbwrmdlhicpzbnldl.supabase.co"
$env:SUPABASE_SERVICE_ROLE_KEY = ((npx supabase projects api-keys --project-ref yegnbwrmdlhicpzbnldl -o json | ConvertFrom-Json) | Where-Object { $_.name -eq 'service_role' }).api_key
npm run bootstrap:owner -- "you@example.com" "YourStrongPassword" "Your Name"
Remove-Item Env:SUPABASE_SERVICE_ROLE_KEY, Env:NEXT_PUBLIC_SUPABASE_URL
```

Expected: `Owner staff_users row created: <uuid>`.

- [ ] **Step 2: Confirm** (no personal details printed)

```bash
npx supabase db query --project-ref yegnbwrmdlhicpzbnldl "select role, invite_status, is_active from staff_users"
```

Expected: exactly one row: `owner | accepted | true`.

---

### Task 10: Verify production end to end

**Files:** none.

- [ ] **Step 1: Function gate**

```bash
curl -s -o /dev/null -w '%{http_code}\n' -X POST https://yegnbwrmdlhicpzbnldl.supabase.co/functions/v1/send-notifications
```

Expected: `401`.

- [ ] **Step 2: Customer app** — `https://pixel-barber-customer.vercel.app` shows the Pixel Barber branch and its services with no connection errors.

- [ ] **Step 3: Staff app** — the user logs into `https://pixel-barber-staff.vercel.app` with the Owner email and password and reaches the dashboard, **Settings → Staff** and **Settings → Barbers**.

- [ ] **Step 4: SMS safety** — rerun Task 6 Step 2: `SMS_NOTIFICATIONS_LIVE` absent, `SMS_NOTIFICATIONS_ALLOWLIST` present.

- [ ] **Step 5: Staging untouched** — with `send-sms.env` sourced, `npx supabase secrets list --project-ref bfkokxcdgvrnevtpeycw` shows the same names as before this plan, and `echo n | npx supabase config push --project-ref bfkokxcdgvrnevtpeycw` shows no diff.

---

### Task 11: Runbook, memory note, commit

**Files:**
- Create: `Docs/ops/production-setup.md`
- Modify (outside repo): memory note `pixel_barber_infra_status.md`

- [ ] **Step 1: Write `Docs/ops/production-setup.md`** with these sections, filled from what actually happened in Tasks 1–10 (commands verbatim from this plan, corrected for anything that had to change; no secret values, no phone number):
  1. *Environments* — the two refs, which Vercel app points where, the two `.secrets/*.env` files and the variable names each holds.
  2. *Initial setup (done 2026-09-30)* — Tasks 2–9 as numbered steps with their commands.
  3. *Promote a finished feature to production* — source `production.env`; `db push --project-ref yegnbwrmdlhicpzbnldl --dry-run`, then without `--dry-run`; `functions deploy <name> --project-ref yegnbwrmdlhicpzbnldl` for changed functions; `secrets set` for new secrets; `config push` (diff first) if `config.toml` changed; then the Task 10 checks. Staging always first; production only after the user approves.
  4. *If production is paused* — restore from the dashboard; data is kept.
  5. *Go-live checklist* — copied from the spec.

- [ ] **Step 2: Update the memory note**: production set up (date, what exists, live SMS off, allowlist set, Owner account created), `.secrets/production.env` exists, runbook path.

- [ ] **Step 3: Commit**

```bash
git add Docs/ops/production-setup.md
git commit -m "docs: production setup runbook"
```

- [ ] **Step 4: Ask the user before pushing** to `origin/main`: check `git log origin/main..main`, behind 0, no attribution lines.
