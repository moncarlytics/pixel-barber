# CLAUDE.md — Pixel Barber

This file governs every Claude Code session working in this repository. Read it first, every session, before touching any file.

## The one rule that matters

**`docs/` is the source of truth. Read the relevant document(s) before starting any task — planning, coding, reviewing, or fixing a bug. Never make an architectural or feature decision that contradicts what's written there. If a task genuinely can't be done without deviating from a document, stop and ask before proceeding — do not silently work around it, guess at an intent the document doesn't state, or proceed on the assumption the document is wrong.**

This applies mid-task too, not just at the start of one. If something you learn three files into a change reveals a conflict with `docs/`, stop there and ask, rather than finishing the task first.

This file does not restate anything from `docs/` — it only tells you which document answers which kind of question, and the two working rules above and below. Facts (dependency versions, table schemas, screen behavior, color values, RBAC rules) live in exactly one place, and it isn't here; treat any fact that looks duplicated between this file and `docs/` as a bug in this file.

## Which document to open

| Question you're trying to answer | Read |
|---|---|
| What is this product, who is it for, what does a feature actually need to do, what are the business rules? | `docs/pixel-barber-prd.md` |
| Which screen does this belong on, what does it show empty/loading/erroring, how does a user get from A to B? | `docs/pixel-barber-app-flow.md` |
| What library/version am I allowed to use, how is the monorepo laid out, what goes in an Edge Function vs. a Next.js app? | `docs/pixel-barber-tech-stack.md` |
| What table/column/enum/function/RLS policy already exists or should exist, how is auth structured, what's the migration order? | `docs/pixel-barber-backend-schema.md` |
| What color, type size, spacing, component variant, icon, or copy string should this use? | `docs/pixel-barber-design-system.md` |
| What phase is the MVP build in, what's already done, what's this phase's Definition of Done? | `docs/pixel-barber-implementation-plan.md` (Phases 0–10) |
| What phase is the post-MVP build in (cross-branch transfer, messaging, avatar personalization, CRM/reporting depth, biometric login), what's already done, what's this phase's Definition of Done? | `docs/pixel-barber-implementation-plan-phase-2.md` (Phases 11–15) |

A task that spans more than one of these — nearly all of them do — means reading all of the relevant rows, not just the first one that seems to apply. A UI change still needs the App Flow and Design System documents even if the PRD is where the underlying business rule lives; a schema change still needs the PRD and Backend Schema documents even if it was requested as "just add a column."

If a document referenced above is missing from `docs/`, that's itself a reason to stop and ask, not a reason to proceed without it.

## Phase discipline

Before starting a task, check which phase of `pixel-barber-implementation-plan.md` or `pixel-barber-implementation-plan-phase-2.md` the repository is actually in — its own Definition of Done sections are how you tell what's really finished versus what merely has code written for it. Do not start work that belongs to a later phase while an earlier phase's Definition of Done hasn't been met, and do not skip a phase's own verification (its tests, its Definition of Done) to get to the next one faster. If a request would do either of those things, stop and ask before proceeding, exactly as the rule above requires for a documents conflict — jumping ahead of the sequence is a form of deviating from it.

## What this file is not

Not a summary of the product, the schema, the design system, or the build plan — that's what `docs/` is for, and duplicating any of it here would just create a second copy that can drift out of sync with the real one. Not a process/style guide — commit conventions, branch naming, and PR expectations aren't defined by this file; follow whatever the repository's actual tooling (linter config, CI checks, existing commit history) already establishes, and ask if something isn't established yet. Not a substitute for reading a document in full — a table of contents tells you where to look, not what it says.
