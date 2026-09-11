# Pixel Barber — Locked Technology Stack & Dependency Manifest

**Document status:** Input document for Claude Code (or any engineer) to scaffold the project
**Version:** 1.0
**Versions verified:** 9 September 2026, against the npm registry directly
**Companion to:** `pixel-barber-prd.md` (product/business rules) and `pixel-barber-app-flow.md` (screens/navigation) — this document does not repeat either; it only adds the technical layer needed to start writing code.

---

## 0. How to Use This Document

Every version number below was checked against the live npm registry on the date at the top of this file, not recalled from memory — npm registries change daily, so treat this as a verified snapshot rather than something that stays accurate indefinitely. Before running the first `npm install`, re-verify each version with `npm view <package> version` and adjust if a newer patch has shipped in the meantime; the point of this document is the *policy* (exact pins, no carets, no tildes, lockfile committed) as much as the specific numbers. Every version in every table below is meant to be installed with `--save-exact` (or written directly into `package.json` with no `^` or `~` prefix) and followed immediately by committing the resulting lockfile — that lockfile, not this document, is the final source of truth for transitive dependencies.

---

## 1. Selection Methodology

Two filters were applied to every choice below: nothing newer than two years old, and nothing under 10,000 GitHub stars, unless no well-established alternative exists. That second clause does real work in a stack like this one, so it's applied transparently rather than quietly:

**General-purpose libraries** (UI frameworks, form libraries, data-fetching, utilities) are judged by the star/age screen directly, because they compete for community adoption and a low star count on one of these is a real signal to look elsewhere.

**Official vendor SDKs** (Supabase, Google, MessageBird, Vercel) are judged by the maturity and market position of the vendor and its documentation instead, not by GitHub stars — their usage is driven by who holds an API key to that specific service, not by community mindshare, so a modest star count on an official SDK repo says nothing about how established or safe it is. This is why `@google/genai` and `messagebird` appear below despite star counts well under 10,000.

**Ecosystem "connective tissue" packages** — the small utilities that are the de facto standard companion to a chosen framework (`tailwind-merge`, `class-variance-authority`, `clsx` alongside Tailwind/shadcn; `@hookform/resolvers` bridging React Hook Form and Zod) — are included under the "no well-established alternative" exception, because within their specific niche they are what nearly every production Next.js codebase already uses, which is exactly what maximizes Claude Code's familiarity with them. Section 21 lists every package that relied on this exception and why, so nothing is included without a stated reason.

---

## 2. Architecture Summary

Two Next.js applications in one monorepo, not one app trying to serve both audiences: `apps/customer` (the customer-facing PWA) and `apps/staff` (the staff/admin portal, which also serves the barber's single-screen interface as a role-gated view within it, per the App Flow document — no third app needed). A `packages/shared` workspace holds what both apps need in common: generated Supabase types, Zod validation schemas, and translation message files — not UI components, since the two apps' interfaces are different enough (consumer-friendly vs. data-dense) that each maintains its own shadcn-generated `components/ui` folder rather than forcing a shared component library prematurely. Server-side notification sending (SMS, web push, and the Gemini feedback-analysis call) lives in Supabase Edge Functions, not inside either Next.js app — a Postgres trigger fires the relevant function directly on the database change (a new ticket, a new feedback row), so a notification only ever gets sent once regardless of which app made the change, and neither app needs to duplicate that logic.

```text
pixel-barber/
├── apps/
│   ├── customer/         # Customer PWA
│   └── staff/            # Staff/admin portal + barber interface
├── packages/
│   └── shared/           # Supabase generated types, Zod schemas, i18n messages
├── supabase/
│   ├── functions/        # Edge Functions (Deno): SMS, web push, Gemini feedback analysis
│   └── migrations/
├── turbo.json
└── package.json          # npm workspaces root
```

---

## 3. Runtime and Monorepo Tooling

| Dependency | Exact version | Role |
|---|---|---|
| Node.js | **24.20.0** | Current Active LTS as of this document's verification date; set in `package.json` `engines` and in `.nvmrc` |
| npm | Bundled with Node 24.20.0 | Package manager per your choice — not a separate pin; whatever ships with the pinned Node version is what's used, verified with `npm --version` at setup |
| turbo | **2.10.12** | Coordinates builds/tests across `apps/customer`, `apps/staff`, and `packages/shared` |

Root `package.json` declares npm workspaces (`"workspaces": ["apps/*", "packages/*"]`) — no separate workspace tool needed beyond npm's own built-in support.

---

## 4. Core Framework (both apps)

| Dependency | Exact version | Notes |
|---|---|---|
| next | **16.3.4** | App Router only — no Pages Router |
| react | **19.2.8** | |
| react-dom | **19.2.8** | Must match the `react` version exactly |
| typescript | **7.0.2** | This is the new Go-native compiler generation (a rewrite from the previous JavaScript-based `tsc`), significantly faster than prior majors. It is npm's current `latest` tag as of verification, but because it's an architectural rewrite rather than an incremental release, run the full lint/build pipeline early and watch for any editor plugin or typed-ESLint-rule incompatibility; if one surfaces, the fallback is pinning the last pre-rewrite release line instead. |
| eslint-config-next | **16.3.4** | Kept in lockstep with the `next` version |

---

## 5. Styling and UI Components (both apps)

| Dependency | Exact version | Notes |
|---|---|---|
| tailwindcss | **4.3.3** | v4 engine — no `tailwind.config.js` content-scanning setup needed the way v3 required; configuration lives in CSS via `@theme` |
| @tailwindcss/postcss | **4.3.3** | The official PostCSS plugin for wiring Tailwind v4 into Next.js's build pipeline |
| shadcn | **4.21.0** | CLI/codegen tool, not a runtime dependency — used to generate component source directly into each app's `components/ui`, backed by Radix primitives |
| class-variance-authority | **0.7.1** | Variant styling for shadcn-generated components (exception — see section 21) |
| clsx | **2.1.1** | Conditional className composition |
| tailwind-merge | **3.6.0** | Resolves conflicting Tailwind classes when composing components (exception — see section 21) |
| lucide-react | **1.42.0** | Icon set — the standard pairing with shadcn/ui |
| @radix-ui/react-\* | Pin each on addition, e.g. `@radix-ui/react-dialog` **1.1.23** | shadcn's CLI adds the specific Radix primitive package a given component needs (dialog, dropdown-menu, select, tabs, avatar, etc.) at generation time — pin whichever ones get added using this same exact-version policy rather than pre-installing ones that may go unused |

---

## 6. Backend, Database, and Auth (both apps)

| Dependency | Exact version | Notes |
|---|---|---|
| @supabase/supabase-js | **2.116.0** | Client for Postgres queries, Auth, Storage, and Realtime subscriptions — Realtime is what powers every live queue/dashboard update described in the App Flow document; no separate WebSocket library is needed |
| @supabase/ssr | **0.12.6** | The current officially recommended package for server-side/App-Router Supabase auth — supersedes the deprecated `@supabase/auth-helpers-nextjs` (exception — see section 21) |
| supabase (CLI) | **2.117.0** | Dev-only: local development, migrations, generating TypeScript types into `packages/shared` from the live schema |

---

## 7. Forms and Validation (both apps)

| Dependency | Exact version | Notes |
|---|---|---|
| react-hook-form | **7.87.0** | Every form in the App Flow document — onboarding, walk-in registration, service/barber settings, feedback — uses this rather than mixing form approaches |
| zod | **4.5.4** | Schema validation, shared between client-side form validation and server-side input validation in Next.js server actions |
| @hookform/resolvers | **5.9.1** | Bridges React Hook Form to Zod schemas (exception — see section 21) |

---

## 8. Data Fetching and Client State (both apps)

| Dependency | Exact version | Notes |
|---|---|---|
| @tanstack/react-query | **5.102.8** | Handles request caching, retries, and optimistic updates for anything not covered by a live Supabase Realtime subscription (e.g., paginated reports, the CRM customer list) — Realtime handles the truly live surfaces (queue position, dashboard metrics) directly through `@supabase/supabase-js`, so the two aren't doing the same job |

No separate global client-state library (Redux/Zustand/Jotai) is included — between React Query for server state and React's own component/URL state for everything else, the screens in the App Flow document don't need a third state layer. Revisit only if a specific cross-cutting client state need emerges that neither covers.

---

## 9. Date and Time Handling (both apps)

| Dependency | Exact version | Notes |
|---|---|---|
| date-fns | **4.4.0** | Formatting, comparison, and duration math for wait estimates, appointment slots, and the grace-period timer. Because Ghana observes no daylight saving (GMT/UTC+0 year-round, per the PRD), the usual DST-transition edge cases this library handles don't apply here — it's still the right tool for ordinary date arithmetic and formatting, just without that particular complexity to test for |

---

## 10. Internationalization (both apps)

| Dependency | Exact version | Notes |
|---|---|---|
| next-intl | **4.14.2** | Chosen over the higher-starred `react-i18next` specifically because it's built for the App Router and React Server Components, which the higher-star alternative isn't designed around (exception — see section 21). Covers all five launch languages from the App Flow document: English, French, Chinese, Spanish, German |

---

## 11. Maps and Location (customer app required; staff app optional)

| Dependency | Exact version | Notes |
|---|---|---|
| @googlemaps/js-api-loader | **2.1.1** | Official Google Maps loader (exception — see section 21), used for branch discovery, distance/travel-time calculation, and the geofence arrival detection described in the App Flow document. Required in `apps/customer`; only needed in `apps/staff` if Branch Settings gets a visual map picker for the geofence radius rather than a plain numeric input |

Server-side travel-time calculation (the Distance Matrix lookup behind the "leave now" guidance) should go through a thin Next.js API route or Edge Function calling Google's REST Distance Matrix API directly with `fetch`, rather than an additional npm wrapper package — the REST API needs no SDK.

---

## 12. AI: Feedback Analysis (Gemini)

Per the decision to keep this build's AI use narrow, Gemini has exactly one job in this version: classifying free-text customer feedback (PRD section 29) into the themes the PRD names — waiting time, barber quality, staff attitude, cleanliness, price/value, appointment experience, other. It is not wired into a conversational assistant or any recommendation engine in this build; that stays the Phase 3 direction described in the PRD.

| Dependency | Exact version | Notes |
|---|---|---|
| @google/genai | **1.15.0** | The current unified Google GenAI SDK — the previous `@google/generative-ai` package is officially deprecated in favor of this one. No alternative exists for calling Gemini specifically (exception — see section 21) |

This runs as a Supabase Edge Function triggered by a database webhook on new `Feedback` rows with free-text content, writing the classified theme(s) back onto that row — never called directly from either Next.js app, so a feedback submission gets classified exactly once regardless of which surface it came through.

---

## 13. Server-Side Notifications (Supabase Edge Functions, Deno runtime)

These three packages are used from Supabase Edge Functions rather than from either Next.js app's own `package.json` — Deno's `npm:` specifier support means the same exact-version discipline still applies, just declared per-function (in that function's import statement or `deno.json`) instead of in a root `package.json`.

| Dependency | Exact version | Import as | Notes |
|---|---|---|---|
| messagebird | **4.0.1** | `npm:messagebird@4.0.1` | Official MessageBird Node SDK, chosen as the SMS provider for Ghana numbers. MessageBird is also one of Supabase Auth's natively-supported phone-OTP providers (alongside Twilio, Twilio Verify, TextLocal, and Vonage), so — unlike a provider outside that list — it needs no custom Auth Hook: OTP delivery is a dashboard setting in the Supabase project's Auth configuration, and this package is only for the ticket-lifecycle/appointment SMS function below. Confirm MessageBird's supported sending routes/pricing for Ghana numbers before launch |
| web-push | **3.6.7** | `npm:web-push@3.6.7` | Reference implementation of the Web Push protocol for sending to a browser's push subscription — the server-side half of the native Web Push approach chosen for this build (exception — see section 21) |
| @google/genai | **1.15.0** | `npm:@google/genai@1.15.0` | Same package as section 12, invoked from the feedback-classification function specifically |

A ticket-lifecycle webhook (new ticket, called, no-show, cancelled) triggers the SMS/push function; a new-feedback webhook triggers the Gemini classification function. Both are ordinary Postgres triggers calling Supabase's built-in webhook mechanism — no message queue is needed at this scale.

---

## 14. Testing (root, spanning both apps)

| Dependency | Exact version | Notes |
|---|---|---|
| vitest | **5.0.0** | Unit and component test runner |
| @testing-library/react | **16.3.3** | Component testing |
| @testing-library/jest-dom | **7.0.1** | DOM assertion matchers for the above |
| jsdom | **30.0.1** | DOM environment for Vitest |
| @playwright/test | **1.63.0** | End-to-end tests across full user journeys (PRD/App Flow sections on cross-surface journeys are natural Playwright test cases — e.g., staff walk-in registration through to the SMS tracking page) |

---

## 15. Linting and Formatting (root)

| Dependency | Exact version | Notes |
|---|---|---|
| eslint | **10.10.0** | Flat config (`eslint.config.js`) |
| prettier | **3.9.6** | Formatting, run via a pre-commit hook rather than left to individual editor settings |

---

## 16. Hosting and Deployment

Two separate Vercel projects, one per app, both pointed at the same monorepo with their respective `apps/customer` or `apps/staff` set as the project root — this is standard Vercel monorepo support, not a workaround. Supabase runs as a managed project (database, auth, storage, Realtime, and Edge Functions all in one place); no separate hosting is needed for the backend.

| Tool | Exact version | Notes |
|---|---|---|
| vercel (CLI) | **59.11.7** | Dev-only, for local preview deploys and environment variable management |

Recommended environments: separate Supabase projects for staging and production (not just separate Vercel environments pointed at one database), so schema migrations and Edge Function changes can be tested against real infrastructure before touching live customer data.

---

## 17. Complete `package.json` Dependency Blocks

### `apps/customer/package.json`

```json
{
  "dependencies": {
    "next": "16.3.4",
    "react": "19.2.8",
    "react-dom": "19.2.8",
    "@supabase/supabase-js": "2.116.0",
    "@supabase/ssr": "0.12.6",
    "react-hook-form": "7.87.0",
    "zod": "4.5.4",
    "@hookform/resolvers": "5.9.1",
    "@tanstack/react-query": "5.102.8",
    "date-fns": "4.4.0",
    "next-intl": "4.14.2",
    "@googlemaps/js-api-loader": "2.1.1",
    "class-variance-authority": "0.7.1",
    "clsx": "2.1.1",
    "tailwind-merge": "3.6.0",
    "lucide-react": "1.42.0"
  },
  "devDependencies": {
    "typescript": "7.0.2",
    "tailwindcss": "4.3.3",
    "@tailwindcss/postcss": "4.3.3",
    "eslint-config-next": "16.3.4"
  }
}
```

### `apps/staff/package.json`

```json
{
  "dependencies": {
    "next": "16.3.4",
    "react": "19.2.8",
    "react-dom": "19.2.8",
    "@supabase/supabase-js": "2.116.0",
    "@supabase/ssr": "0.12.6",
    "react-hook-form": "7.87.0",
    "zod": "4.5.4",
    "@hookform/resolvers": "5.9.1",
    "@tanstack/react-query": "5.102.8",
    "date-fns": "4.4.0",
    "next-intl": "4.14.2",
    "class-variance-authority": "0.7.1",
    "clsx": "2.1.1",
    "tailwind-merge": "3.6.0",
    "lucide-react": "1.42.0"
  },
  "devDependencies": {
    "typescript": "7.0.2",
    "tailwindcss": "4.3.3",
    "@tailwindcss/postcss": "4.3.3",
    "eslint-config-next": "16.3.4"
  }
}
```

*(`@googlemaps/js-api-loader` moves from `devDependencies` to `dependencies` here only if Branch Settings gets a visual geofence map picker — see section 11.)*

### Root `package.json` (workspace-level tooling)

```json
{
  "private": true,
  "workspaces": ["apps/*", "packages/*"],
  "engines": {
    "node": "24.20.0"
  },
  "devDependencies": {
    "turbo": "2.10.12",
    "typescript": "7.0.2",
    "eslint": "10.10.0",
    "prettier": "3.9.6",
    "vitest": "5.0.0",
    "@testing-library/react": "16.3.3",
    "@testing-library/jest-dom": "7.0.1",
    "jsdom": "30.0.1",
    "@playwright/test": "1.63.0"
  }
}
```

### `supabase/functions/*/deno.json` (per Edge Function, as needed)

```json
{
  "imports": {
    "messagebird": "npm:messagebird@4.0.1",
    "web-push": "npm:web-push@3.6.7",
    "@google/genai": "npm:@google/genai@1.15.0"
  }
}
```

---

## 18. Environment Variables

| Variable | Where used | Notes |
|---|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | Both apps, client + server | Public by design |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Both apps, client + server | Public by design; row-level security in Postgres is what actually protects data, not secrecy of this key |
| `SUPABASE_SERVICE_ROLE_KEY` | Server-only (Edge Functions, staff-app server actions needing elevated access) | Never exposed to any client bundle |
| `NEXT_PUBLIC_GOOGLE_MAPS_API_KEY` | Customer app, client | Restrict by HTTP referrer in Google Cloud Console |
| `GOOGLE_MAPS_SERVER_API_KEY` | Server-side Distance Matrix calls | Separate, IP-restricted key rather than reusing the public one |
| `GEMINI_API_KEY` | Feedback-classification Edge Function only | Never exposed client-side |
| `MESSAGEBIRD_API_KEY` / `MESSAGEBIRD_ORIGINATOR` | Ticket-lifecycle/appointment SMS Edge Function only | Never exposed client-side; the same MessageBird account is configured separately, natively, in the Supabase project's Auth settings for OTP delivery (no app-level env var needed for that path) |
| `VAPID_PUBLIC_KEY` | Client (subscription) + server (sending) | Web Push key pair |
| `VAPID_PRIVATE_KEY` | Server-only | |
| `VAPID_SUBJECT` | Server-only | A `mailto:` contact address, required by the Web Push protocol |
| `NEXT_PUBLIC_CUSTOMER_APP_URL` / `NEXT_PUBLIC_STAFF_APP_URL` | Both apps | Cross-linking between the two deployed apps (e.g., an SMS tracking link pointing at the customer app from a staff-triggered function) |

---

## 19. Version Verification and Update Protocol

Re-verify every version in this document with `npm view <package> version` immediately before scaffolding — this document is a snapshot, and even well-established packages ship patch releases weekly. Once installed with exact pins and a committed lockfile, use `npm ci` (never plain `npm install`) in CI and deployment so builds are fully reproducible from the lockfile rather than re-resolving anything. For ongoing maintenance, a scheduled dependency-update tool (Dependabot or Renovate, both free on GitHub) opens a pull request per update rather than silently drifting — review and merge those deliberately, re-applying the same exact-pin policy rather than letting range-based updates creep back in.

---

## 20. Explicit Exceptions to the Star/Age Rule

| Package | Why it's included despite the screen |
|---|---|
| @google/genai | Official Gemini SDK — no alternative exists for calling this specific API |
| @supabase/ssr | Official, current-recommended replacement for the deprecated `@supabase/auth-helpers-nextjs` — no better-established alternative for Supabase auth in the App Router |
| @hookform/resolvers | Official bridge between React Hook Form and Zod — no alternative better integrated with either |
| next-intl | Purpose-built for the App Router/React Server Components, unlike the higher-starred `react-i18next` — chosen for framework fit over raw star count, per explicit direction |
| @googlemaps/js-api-loader | Official Google Maps loader — chosen to avoid adding a third-party wrapper on top of an already-Google-dependent stack (Gemini) |
| messagebird | Star count on the SDK repository sits under the threshold, but it's the official vendor SDK and MessageBird is one of Supabase Auth's own natively-supported OTP providers, which is what makes the OTP-delivery path (backend schema section 17) a dashboard setting rather than custom code |
| web-push | Reference implementation of the Web Push protocol — no better-established alternative for the native Web Push approach chosen over Firebase Cloud Messaging |
| class-variance-authority, tailwind-merge, clsx | De facto standard companions to Tailwind CSS and shadcn/ui — below the star threshold individually, but what nearly every production Tailwind/shadcn codebase already uses |
| shadcn (CLI) | A code-generation tool, not a runtime dependency — the underlying Radix Primitives project it scaffolds against is well past the threshold on its own |

---

## 21. What This Document Does Not Cover

Payment processing has no entry here because the PRD keeps v1 pay-at-shop only (PRD section 5) — nothing to lock yet. A conversational AI assistant and any ML-driven recommendation engine are absent for the same reason: the PRD's section 27 keeps that as an unspec'd future direction, not a v1 feature, so there's no library to choose until that scope is actually opened up.

---

## 22. Phase 2: In-App Messaging and Avatar Personalization Need No New Dependency

PRD section 45 (in-app customer–barber messaging) and section 18's Phase 2 avatar enhancement are both Phase 2 scope, but worth locking here now since neither one changes this document's dependency list at all — a deliberate outcome of designing them against what's already in sections 5–6, not an oversight.

Text messaging reuses `@supabase/supabase-js`'s Realtime subscriptions and Postgres storage exactly as the rest of the app's live surfaces do (section 6) — a `messages` table, not a third-party chat SDK. Voice notes use the browser's native `MediaRecorder` API to capture audio and a native `<audio>` element to play it back, with the resulting file uploaded to Supabase Storage through the same `@supabase/supabase-js` client already in both apps' dependencies — no waveform, recorder, or chat-UI package is added for this, in keeping with this document's own methodology (section 1): a package earns a place here only when it carries real weight, and neither recording nor playing a short audio clip needs one. The build-your-own avatar picker (PRD section 18) is composed from `lucide-react`/inline SVG parts and CSS, the same way the Phase 1 avatar grid already is — no avatar-builder library is warranted for a fixed, product-defined set of parts and colors.

The one addition worth flagging for when this phase is actually built: a Supabase Storage bucket for voice-note audio (with a lifecycle rule matching the 30-day conversation-anonymization policy in PRD section 45.4) needs creating alongside the `messages` table migration — a configuration step in `supabase/migrations/`, not a new npm dependency.

---

## 23. Phase 2: Biometric (Passkey) Login Also Needs No New Dependency, With One Real Caveat

PRD section 47 (biometric/fingerprint login) is Phase 2 scope, and — like section 22's two features — it doesn't add a package to this document's dependency list, because Supabase Auth ships this natively rather than it being something to build from a lower-level WebAuthn library. The pinned `@supabase/supabase-js` version in this document (**2.116.0**, section 17) already comfortably exceeds the minimum version Supabase's own passkey support requires (2.105.0+ per their current documentation), so this is available the moment this phase is built, with no version bump needed. `@supabase/ssr` (used for server-side session handling) needs no change either — a passkey sign-in still produces an ordinary Supabase session against `auth.users`, so everything downstream of authentication (the custom access token hook, RLS, every existing server-side session check) keeps working completely unchanged.

The client-facing shape: `supabase.auth.registerPasskey()` enrolls the current device's platform authenticator (Face ID, Touch ID, Android biometric unlock, Windows Hello) against the signed-in user, and `supabase.auth.signInWithPasskey()` runs the full "discoverable credential" sign-in ceremony — the browser/OS handles prompting for and matching the fingerprint or face locally, and only a signed cryptographic assertion (never any biometric data itself) is sent to Supabase to verify. This is what makes the barber shared-station case (PRD section 47.4) work with no custom code: when more than one barber has enrolled a passkey on the same station, the browser's own account picker resolves which one just touched the sensor, the same pattern used for any shared-device passkey scenario on the web.

**The real caveat, worth flagging plainly rather than glossing over:** Supabase's own documentation currently marks this feature **experimental — its API may change without notice** — the client SDK calls above require an explicit opt-in flag (`{ auth: { experimental: { passkey: true } } }`) precisely because of that status. This is the one place in this entire stack document where a "locked" dependency's own vendor is telling us the interface underneath it isn't locked yet. That's an acceptable trade for an additive, opt-in convenience feature with a fully working non-experimental fallback already in place (password, OTP, and PIN login all stay exactly as built) — but it means re-verifying this specific API against Supabase's current docs immediately before Phase 2's biometric-login work starts, not assuming this section's method names are still accurate by the time that phase is actually reached, and treating any breaking change there as an isolated fix to one feature rather than something that touches the rest of the auth model.

No new Storage bucket, Edge Function, or schema table is needed for this feature — passkey credentials are managed entirely inside Supabase Auth's own internal tables against the existing `auth.users` row, the same way password hashes and OTP state already are (Backend Schema section 3.5 has the full note).
