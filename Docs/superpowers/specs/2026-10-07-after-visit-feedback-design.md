# Design: After-Visit Feedback

**Date:** 2026-10-07
**Status:** Approved in brainstorming, awaiting written-spec review
**Origin:** PRD section 29 (feedback and service quality); implementation plan Phase 7 lists the
low-rating alert. Builds on the notification sender (push first, SMS fallback —
`Docs/superpowers/specs/2026-10-07-web-push-notifications-design.md`).

## Goal

After a haircut, the customer rates the visit in a tap (optional comment and detailed ratings), sees
their history in Profile, and branch managers notice low ratings quickly through a staff alert and a
Feedback page.

## Current state

- `feedback` table exists: `ticket_id` (unique), `customer_id`, `branch_id`, `barber_id`,
  `overall_rating` 1–5 (required), five optional 1–5 ratings (`service_quality_rating`,
  `barber_professionalism_rating`, `waiting_experience_rating`, `cleanliness_rating`,
  `value_rating`), `comment`, `gemini_themes`, `gemini_processed_at`, `created_at`. A trigger keeps
  `barbers.average_rating` up to date on insert.
- RLS: customers may read their own feedback and insert directly (`feedback_customer_submit`); staff
  read with `in_branch_scope(branch_id) and has_capability('view_branch_reports')`.
- The customer ticket page shows "Your visit is complete" for completed tickets; Profile has an empty
  "Feedback History" section ("No feedback submitted yet.").
- Capabilities: `view_branch_reports` — owner, branch_manager, analyst; `handle_escalations` — owner,
  branch_manager.
- `send-notifications` claims pending `channel = 'sms'` notifications of a fixed list of types and
  delivers push first, SMS as fallback (SMS live sending is off until the Arkesel sender ID is
  approved).

## Decisions

1. **Form:** overall stars (required) + optional comment; "Tell us more" reveals the five optional
   detailed ratings.
2. **Asking:** a notification right away when the ticket is completed, plus the form on the ticket
   screen.
3. **Low-rating alert:** a banner in the staff app for owners and branch managers of that branch until
   someone marks the rating seen, plus a Feedback page listing ratings.
4. **Approach:** database functions for submitting, listing and marking seen; the existing
   notification sender delivers the request.

## Section 1 — Customer side

### The request

- When a ticket moves to `completed`, the database queues one notification
  `notification_type = 'feedback_request'` (channel `sms`, recipient the customer,
  `related_ticket_id` the ticket), unique per ticket. Only for customers with an app account
  (`customers.auth_user_id is not null`) — a walk-in without an account can't open the form.
- The sender treats it like the other types: push first (body `How was your cut at {branch}? Tap to
  rate.`, title `Pixel Barber`, tap URL `/tickets/{ticket_id}`), SMS as fallback
  (`Pixel Barber: How was your cut at {branch}? Rate your visit: {link}` where `{link}` is the ticket
  link). It is **stale** (not sent) when feedback already exists for the ticket or the ticket is no
  longer `completed`. Urgency `normal`. The usual 10-minute expiry applies.

### The form (ticket page `/tickets/[id]`, completed tickets)

- Shown when the ticket is `completed`, no feedback exists for it, and the ticket completed within the
  last 7 days.
- Heading `How was your visit?`; five star buttons (1–5, each labelled e.g. "4 stars"); optional
  comment (max 1000 characters); link `Tell us more` revealing five optional star rows: `Service
  quality`, `Barber professionalism`, `Waiting experience`, `Cleanliness`, `Value for money`;
  `Send` button (disabled until a star is chosen).
- After sending: `Thanks for your feedback!` with the chosen overall stars. If feedback already exists
  when the page loads, show the same thank-you state.
- Errors map to messages: `too_late` → `Feedback for this visit has closed.`; `already_submitted` →
  the thank-you state; anything else → `Couldn't send your feedback. Please try again.`

### Profile — Feedback History

- Lists the customer's feedback, newest first: date, branch, barber name, overall stars, comment.
  Empty → `No feedback submitted yet.` (existing message).

### Submitting

`submit_feedback(p_ticket_id uuid, p_overall smallint, p_service_quality smallint,
p_barber_professionalism smallint, p_waiting_experience smallint, p_cleanliness smallint,
p_value smallint, p_comment text) returns uuid` (`authenticated`):

- The ticket must belong to the calling customer → else `not_found`.
- Ticket `completed` → else `not_completed`; completed within 7 days (`completed_at`, falling back to
  `updated_at` when null) → else `too_late`.
- Already rated → `already_submitted`.
- `p_overall` 1–5 required; each optional rating null or 1–5 → else `invalid_rating`; comment trimmed,
  empty → null, longer than 1000 characters → `invalid_comment`.
- `branch_id` and `barber_id` come from the ticket (`assigned_barber_id`; a completed ticket without
  one → `not_completed`).
- Returns the feedback id. The existing trigger updates the barber's average.
- The direct customer insert policy (`feedback_customer_submit`) is dropped, so the rules above can't
  be bypassed. The customer read policy stays.

## Section 2 — Staff side

### Low-rating alert

- New columns on `feedback`: `seen_at timestamptz`, `seen_by_staff_id uuid references staff_users(id)`.
- "Low" = `overall_rating <= 2`.
- `list_unseen_low_feedback_count() returns integer` (`authenticated`): the number of low, unseen
  ratings in branches the caller has in scope, for callers with `handle_escalations`; 0 otherwise.
- The staff header shows, for signed-in staff, a red banner `{count} new low rating(s) — View` when
  the count is above 0 (`1 new low rating — View` / `2 new low ratings — View`), linking to
  `/feedback`. It refreshes when the page loads and every 60 seconds.
- `mark_feedback_seen(p_feedback_id uuid) returns void` (`authenticated`): requires
  `handle_escalations` and the branch in scope → else `not_allowed`; sets `seen_at = now()` and
  `seen_by_staff_id` (idempotent: an already-seen rating keeps its first values).

### Feedback page (staff app `/feedback`)

- Linked from the staff home page (`Feedback`) for staff with `view_branch_reports`.
- Branch picker (branches in scope) and the list for the chosen branch, newest first, at most 100:
  date, customer first name, barber name, service name, overall stars, any detailed ratings, comment.
  Low ratings are highlighted; unseen low ratings show `Mark as seen` (only for `handle_escalations`
  callers); seen ones show `Seen by {name} on {date}`.
- Summary at the top: average overall rating and number of ratings in the last 30 days.
- `list_branch_feedback(p_branch_id uuid) returns table (...)` (`authenticated`): requires
  `view_branch_reports` and the branch in scope → else `not_allowed`.
- Receptionists and barbers don't see the link, and the functions refuse them.

## Error handling

- Every new function: `security definer`, `set search_path = public, pg_temp`, explicit revoke/grant
  (`authenticated` only).
- Error codes are short strings mapped to messages in the apps.
- The feedback request never blocks completing a ticket: the trigger insert uses `on conflict do
  nothing` and only fires on the transition into `completed`.

## Testing

- **DB (staging):** submit rules (own ticket, completed, 7-day window, once, rating/comment
  validation, branch/barber derived, direct insert refused); request queued on completion only for
  app customers and only once; stale once rated (sender core unit test); staff list scoped by
  capability and branch; unseen-low count; mark seen (capability, idempotent).
- **Unit:** sender stale rule and texts for `feedback_request`; customer/staff error mappers.
- **E2E:** a customer with a completed ticket rates it (overall + one detail + comment), sees the
  thank-you state and the entry in Profile; a branch manager sees the banner, opens Feedback, marks
  the rating seen, and the banner disappears.

## Out of scope

Gemini comment themes; per-branch low-rating threshold settings; replying to customers; editing or
deleting feedback; feedback for appointments that never became tickets; staff push notifications.

## Amendments (implementation)

- The staff summary uses "1 rating" / "N ratings" (ICU plural).
- The Feedback page shows "You don't have access to feedback." to staff without `view_branch_reports`.
- Promotion order is migrations, then apps, then send-notifications, so the live push never opens a
  ticket page without the form.
