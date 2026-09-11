# Product Requirements Document (PRD)
## Pixel Barber — Smart Virtual Queue, Appointment and Customer Flow Platform

**Document status:** Draft for product and engineering planning
**Version:** 2.0 (reconciles the original concept draft and the AI-forward draft PRD into one canonical document)
**Date:** 8 September 2026
**Market:** Ghana (GHS currency, 10-digit local phone numbers, GMT/UTC+0 — Ghana does not observe daylight saving, so there is no DST transition to design around)
**Product type:** Single business, multiple branches — web/app platform with customer and staff experiences

---

## 0. What Changed From the Two Earlier Drafts

This version replaces both the original narrative concept document and the AI-forward draft PRD. It keeps the state-machine precision, RBAC structure, and data model discipline of the draft PRD, and keeps the concrete customer-experience specifics (geofence behavior, the customer's "stepped out" status, the exact wait-time formula) from the original concept. It resolves the open questions both documents left hanging: this is a single business with multiple branches, not a multi-tenant SaaS product for other businesses; v1 ships walk-in queuing and appointment booking together; "AI" in v1 means dynamic rule-based calculation, not machine learning or a conversational assistant — that stays an explicit later-phase idea rather than a speced v1 feature; and payment stays pay-at-shop for now. Anything stated once elsewhere in this document is referenced, not repeated.

---

## 1. Executive Summary

Pixel Barber is a queue, appointment, and customer-flow platform for a barbershop business operating multiple branches across Ghana. It replaces the physical waiting line with a live, trackable digital queue that works equally well for a customer booking from home and a walk-in with no smartphone at all. Customers join a queue or book an appointment, see their real position and a continuously updated wait estimate, get notified as their turn approaches, and are guided on when to leave based on how far they are from the shop. Staff get a live dashboard of the whole shop, a fast way to register walk-ins, and direct control over barber assignment and exceptions. The platform is designed around one queue engine that both sides read from, so there is never a mismatch between what a customer sees and what staff sees.

---

## 2. Product Vision

Give customers control over their time while giving Pixel Barber's staff intelligent control over customer flow, barber capacity, and service operations. Waiting should be predictable, barber allocation should be sensible by default, communication should be proactive rather than reactive, and every branch's operations should be measurable.

---

## 3. Problem Statement

A physical queue forces a customer to either stand at the shop or risk losing their place. Even when a shop keeps a list, customers rarely know how long they'll actually wait, walk-ins and appointments compete for the same chairs without a clear rule for who goes first, a barber running long is discovered by everyone only after they've already waited too long, and a customer who steps away can miss their turn entirely. On the operations side, managers often have no real visibility into wait times, barber utilization, or demand patterns until a customer already complained, and feedback, when collected at all, isn't connected to what was actually happening in the shop at the time.

---

## 4. Goals

### 4.1 Customer Goals

Join a queue without physically waiting at the shop, or book an appointment for a future date and time. See a branch's hours, services, and prices before committing to join. Know exactly how many customers are ahead and get a wait estimate that updates as conditions change. Choose a preferred barber or let the system pick the fastest suitable one. Know when to leave home based on the combination of wait time and travel time. Check in easily on arrival. Cancel, step out temporarily, or rebook when needed. Leave feedback right after service, while it's still fresh.

### 4.2 Business Goals

Reduce actual and perceived waiting time. Increase barber utilization without overloading any one barber. Reduce avoidable no-shows and improve appointment adherence. Give branch managers real-time operational control and give the owner consolidated visibility across all branches. Build a structured, queryable customer history. Capture service-quality feedback in a form that's actually usable for decisions, not just collected. Scale from one branch to several without redesigning the core product.

---

## 5. Non-Goals for MVP

Payroll, inventory/procurement, and full accounting are out of scope entirely — this is a customer-flow and operations platform, not a business-management suite. Online/in-app payment (deposits, prepay) is deferred past MVP by deliberate choice; v1 is pay-at-shop only. A machine-learning-driven recommendation engine and a conversational AI assistant are explicitly not part of MVP — see section 27. Multi-business/multi-tenant support (selling this platform to other, unrelated barbershop owners) is out of scope; the data model should not be designed around it, since that was a deliberate decision, not a deferral. Loyalty points/rewards programs beyond basic visit history are excluded unless a later phase decision reopens them (see section 43).

---

## 6. Target Users and Personas

**Customer** — someone seeking a haircut or grooming service, either right now or at a scheduled future time. Primary needs: convenience, predictability, and clear pricing with minimal waiting.

**Barber** — the service provider. Needs a simple workflow: who's next, one action to acknowledge them, one action to flag them absent, one action to mark the service done. Nothing more should compete for their attention mid-service.

**Receptionist / Front Desk** — registers walk-ins, checks customers in, communicates with waiting customers, and resolves queue exceptions at their branch.

**Branch Manager** — monitors and runs one branch's day-to-day operations: barbers, queue, exceptions, and that branch's own reporting.

**Owner / Super Admin** — manages the whole business: all branches, pricing policy, staff accounts, and business-wide reporting.

**Analyst (read-only)** — reviews reports and metrics without the ability to change operational data. Useful for a bookkeeper, consultant, or investor-facing view.

---

## 7. Product Structure

Pixel Barber is one business with multiple branches, not a platform serving multiple unrelated businesses. The hierarchy is:

```text
Pixel Barber (Business)
  ├── Branch A — hours, services & prices, barbers, appointments, queue
  ├── Branch B — hours, services & prices, barbers, appointments, queue
  └── Branch N — hours, services & prices, barbers, appointments, queue
```

A customer holds one account across the whole business and can use any branch with it. A barber is a schedulable resource with a home branch, but can be scheduled at a different branch on a given day if the business chooses to allow floating staff — the data model treats "which branch is a barber working today" as a schedule fact, not a fixed property of the barber. Staff accounts are scoped to the branch(es) they're assigned to; the owner sees everything. Because there's one business, there is no tenant-isolation requirement between branches — reporting can freely roll up branch data at the business level.

---

## 8. Core Product Modules

Customer app/web portal; branch discovery (within Pixel Barber's own branches); virtual queue management; appointment management; barber management and allocation; check-in and service tracking; notifications; customer database/CRM; feedback and service quality; branch operations dashboard; business-wide dashboard; reporting and analytics; roles, permissions, and audit logs; configuration and administration.

---

## 9. Customer Experience Requirements

### 9.1 Entry Points

From the app or web portal, a customer can join a queue immediately, book an appointment, view their current ticket, browse branch information, view services and prices, check barber availability, and review their own past visits and feedback.

### 9.2 Onboarding and Accounts

Customers create a real account: name, 10-digit Ghana phone number, and a password, with the phone number verified by a one-time OTP code at signup (this also doubles as proof the number is reachable, which matters later for SMS delivery). Email is optional. During onboarding the customer also picks an avatar from a predefined library — this becomes their visual marker in the live queue view — and sets a notification channel preference (see section 20). Phone numbers should be validated against the Ghanaian 10-digit local format and normalized to E.164 (+233…) internally for SMS delivery, since the underlying SMS gateway will need the international form regardless of how the customer typed it.

### 9.3 Branch Selection and Branch Profile

The customer can search Pixel Barber's branches by location, use their current location (with explicit permission) to find the nearest one, and compare live wait times across branches before choosing where to go (see section 25). Each branch's profile shows its name, address, and map location; contact information; current status (Open / Closed / Closing Soon / Temporarily Closed); today's hours and the full weekly schedule; any special closure dates; current number waiting and estimated wait; available barbers; services and prices; and appointment availability.

---

## 10. Services and Pricing

Services are configured per branch — haircut, beard trim, combo, kids' cut, and so on — each with a name, description, category, price in Ghana Cedis (GHS), a default duration (used by the wait-time engine, section 17), which barbers are eligible to perform it, an optional image, and an active/inactive flag. Pricing supports a business-wide default with a branch-specific override and an effective date for changes, plus an optional promotional price. The customer always sees the price that applies to the branch and date they're actually booking against — never a stale business-wide default if that branch has its own price set.

---

## 11. Operating Hours and Calendar Rules

Hours are branch-specific and configurable by day of week, with support for special closure dates that override the normal weekly schedule. Because Ghana does not observe daylight saving, all times can be stored and reasoned about in a single fixed UTC+0 offset without the DST-transition edge cases that would complicate this in many other markets — still worth storing internally as UTC and rendering as GMT for display, purely as good practice, but there's no seasonal shift to test for.

Business rules: a customer cannot join a standard queue before a branch's opening time unless pre-opening registration is explicitly enabled for that branch; a customer cannot book or join for a service that couldn't reasonably finish before closing, given that service's duration; if the live queue is projected to run past closing time, staff get an alert so they can decide whether to accept more walk-ins that day; and branch status (open/closed/closing soon) must always be visible to the customer before they attempt to join.

---

## 12. Virtual Queue: Entry, Tickets, and Lifecycle

### 12.1 Entry Methods

A ticket can be created three ways: customer self-service through the app; staff-created walk-in registration (section 13); or an appointment converting automatically into an active queue ticket once its scheduled window arrives (section 14.4). All three produce the same kind of ticket, tracked identically from that point on.

### 12.2 Ticket Identity

Each ticket gets a unique, branch-aware ticket number in the form `PB-<BranchCode>-<Number>` (for example `PB-OSU-104`), reset per branch per day. The exact numbering scheme is configurable, but should always be short enough to read aloud or print.

### 12.3 Queue Lifecycle

```text
Created → Waiting → Almost Turn → Called → Confirmed → In Service → Completed
```

Exception paths from `Called`: if the customer is confirmed present, they proceed to `In Service` as normal. If the barber can't find them, the ticket moves to `Grace Period` (see section 21 for the exact timing and escalation) and from there either back to `Called`/`Confirmed` if the customer responds in time, or to `No Show → Cancelled` if the grace period lapses. A barber may also actively `Skip` a called customer without starting the no-show timer — for example, if the customer visibly asks for a couple more minutes — which returns the ticket to `Waiting` at a position staff can adjust, rather than starting the formal absence escalation; this is a deliberately lighter-weight path than a full no-show and should be a distinct, explicit action a barber takes, not an automatic fallback. From `Waiting`, a customer can self-cancel, staff can cancel, or the ticket can be reassigned to a different barber (section 16).

### 12.4 What the Customer Sees

Their ticket number, current position, number of customers ahead, assigned barber, selected service, an estimated wait range (not false-precision — see section 17), the branch's current status, live queue movement (section 18), the expected service window, their notification preferences, and — when location sharing is on — arrival/travel guidance (section 19).

---

## 13. Walk-In Registration by Staff

For a customer without a smartphone, without data, or who simply prefers to walk in, a receptionist opens the "add walk-in" panel and enters the customer's name, a phone number if available (email optional), the requested service, and an optional barber preference. The system creates a ticket exactly as it would for self-service — same numbering, same lifecycle, same live tracking — assigns or recommends a barber, and sends an SMS ticket confirmation if a phone number was given. That ticket then appears on the staff dashboard tagged as staff-created, with the assigned barber visible. If the customer has no phone at all, they rely on a printed or displayed ticket number and the front-desk board rather than a personal tracking link — the dashboard remains the tracking surface of record for staff either way.

---

## 14. Appointment Management

### 14.1 Creation

A customer chooses a branch, service, a specific barber or "any suitable barber," a date, and an available time slot.

### 14.2 What the Appointment Engine Must Account For

Branch opening hours; the chosen service's duration; the chosen barber's working hours, skills, and existing appointments; current queue load at that time; configured appointment capacity per slot; barber breaks; and any temporary barber unavailability.

### 14.3 Arrival Scenarios

An early arrival can check in ahead of their slot, but their exact position still depends on the branch's configured policy (immediate slot vs. rejoining behind whoever's already being served). An on-time arrival is served according to their reserved slot. A late arrival is treated the same way a called-but-absent walk-in ticket is (section 21) once they're past their slot plus the grace period — contacted, and if unreachable, converted to a standby queue position or offered a rebooking, rather than holding the slot open and delaying everyone else. A true no-show follows the same no-show workflow as any other ticket.

### 14.4 Queue and Appointment Interaction

Appointments are not a separate system from the walk-in queue — the engine reserves a short buffer around each scheduled appointment time so walk-ins queued around it aren't pushed behind a no-show or an early arrival, and factors expected appointment demand into the walk-in capacity it shows customers for that time window.

---

## 15. Barber Management

Each barber profile includes name, branch assignment (home branch, plus any scheduled floating assignment), work schedule, current status, the services they're skilled and authorized to perform, their average service time per service type, their average customer rating, their current customer if any, their current workload, and break status. Statuses: Offline, Scheduled, Available, Busy/In Service, On Break, Temporarily Unavailable, End of Shift. A barber should never be assignable to a service outside their configured skill set.

---

## 16. Intelligent Barber Allocation

Three assignment modes: the customer chooses a specific barber (their wait is calculated only against that barber's own queue); the customer chooses "any barber" (pooled across everyone currently working, for the shortest realistic wait); or, during a load-balancing event, the system recommends moving a customer from an overloaded specific-barber queue into the pool — always with that customer's explicit acceptance, never silently, since perceived fairness matters more than a marginal speed gain (see section 35). The allocation engine weighs barber availability, required skill, current workload, customer preference, and any appointment obligations already on a barber's schedule; it should never override a configured priority, fairness, or appointment rule purely to optimize speed.

---

## 17. Dynamic Wait-Time Prediction

The estimate shown for a given ticket is the sum of the remaining time for whoever that barber (or queue pool) is currently serving — that customer's service's expected duration minus their elapsed time so far — plus the expected duration of each service ahead of the target ticket in that same queue, using each service's own typical duration rather than one flat average across all services. Where a barber has enough completed-service history for a given service type, their own historical average speed for it should be used instead of the shop-wide default, since barbers genuinely vary. This recalculates continuously as real events happen — a service running long updates every affected downstream estimate immediately, rather than leaving early estimates stale — which is what actually makes the number trustworthy. The customer sees a range (e.g., "25–35 min") rather than false precision, and, where the underlying data is thin (a brand-new barber, an unusually quiet day), the estimate can be shown with a simplified confidence label — High confidence, Moderate confidence, Variable conditions — rather than a number that looks more certain than it is.

---

## 18. Queue Visualization: Avatars and Animation

The customer's own avatar, picked at onboarding (section 9.2), moves along a simple visual line as tickets ahead of them complete — advancing only when the customer's actual queue position changes, so the animation reflects real state rather than outrunning it.

**Rule: the avatar is a visual representation of queue state, not the source of truth.** The queue engine — the ticket state and position described in sections 12 and 36 — always determines a customer's actual position, wait estimate, and ticket status; the avatar animation only visualizes changes the engine has already made. No client-side animation, timer, or interpolation is ever allowed to imply a position or status the engine hasn't actually reached — if a network hiccup delays the animation, the textual position and wait estimate (section 12.4) must still be correct and visible even while the avatar hasn't caught up to it yet.

Other customers in the same queue are shown as anonymized avatars or ticket labels only — never another customer's name or contact details. The customer's own screen also shows the shop-wide picture: how many barbers are working, how many customers are ahead of each, and total people waiting, so they can tell at a glance whether the whole shop is busy or it's just their barber. Suggested journey framing: Waiting Room → Almost There → Called → Barber Chair → Service → Completed. Animation must be lightweight, optional, and paired with a reduced-motion alternative — queue status should never depend on animation as its only channel, both for accessibility and because animation alone is a poor substitute for the actual numbers.

**Phase 2 enhancement — expanded personalization and animation states.** Beyond the Phase 1 avatar above (picked from a predefined library at onboarding), Phase 2 lets a customer build a more personal avatar from a set of interchangeable parts and colors rather than choosing one of a fixed set — the design system document's avatar section carries the exact construction rules once this ships. The animation itself also becomes more expressive, with a distinct state for each stage of the journey — Waiting, Moving Forward, Almost Your Turn, Called, Arrived, In Service, Completed, and Cancelled — replacing the simpler Phase 1 journey framing above with purpose-built motion for each transition, plus a celebratory transition the moment the customer's avatar reaches the barber chair. None of this changes the rule stated above: every one of these states and transitions is still driven entirely by the queue engine's actual state, never guessed or predicted client-side. The visual style stays original to Pixel Barber rather than echoing any specific existing social or consumer app's avatar system — inspiration for the sense of movement and personalization is fine, direct visual imitation is not.

---

## 19. Location and Arrival Intelligence

Location access is permission-based and the product must remain fully usable without it — a customer who declines still gets the fixed-time notifications in section 20 and a manual "I'm on my way" / "I've arrived" toggle. Where permission is granted, three states matter. Far from the branch: the app shows travel time from a real routing service (not straight-line distance, which is badly wrong in dense areas) and combines it with the live wait estimate into guidance like "Leave in ~8 min to arrive as your turn starts," recalculating as either number changes. En route: the countdown simply ticks down as the customer moves. Within the branch's geofence — a configurable radius, roughly 50–100 meters as a starting default to allow for GPS drift, tunable per branch depending on how dense the surrounding area is — the app switches to "You're here" and the dashboard shows the ticket as arrived automatically, without the customer doing anything, though a manual "I'm here" from either the customer or staff always overrides in case GPS is unreliable indoors. Travel mode (walking vs. driving) can be asked once per trip or inferred from movement speed once the customer starts moving. Location checks should be event-driven and battery-conscious rather than continuous streaming, and tracking should stop automatically once a ticket is marked arrived or completed — there is no reason to keep polling a customer's location after they no longer need arrival guidance, and no location history should be retained past that point (see section 33).

---

## 20. Notifications and Communication

Launch channels are SMS and push notification — email and WhatsApp are not required for v1 and can be added later without changing the underlying notification model. Channel selection follows what's actually reachable: push if the app is installed and permitted, SMS otherwise, and a customer can always add SMS as a backup even if push is their primary channel, since push is the least reliable channel in practice (OS-level throttling, an app that's been force-closed).

Default notification triggers: ticket created / appointment confirmed; appointment reminder ahead of the scheduled time; a significant queue position change; a significant increase or decrease in estimated wait; 10 minutes and 5 minutes before estimated turn (the customer can adjust these two lead times, but this is the default); the dynamic "leave now" travel prompt from section 19, layered on top of the fixed-time ones, not replacing them; "you're up" when called; the no-show warning and any resulting cancellation (section 21); a barber reassignment; service completed; and the feedback request (section 29). Not every minor position change should generate a push — only milestones — to avoid notification fatigue. Phase 2 adds one further trigger to this list: a new in-app message from the assigned barber (or, on the staff side, from a customer) — see section 45.

---

## 21. No-Show and Availability Management

When a ticket reaches the front of its queue, it moves to `Called` and the customer is notified. A grace period of 2 minutes then starts (configurable per branch, but this is the default) during which the barber can mark the customer present — moving the ticket to `Confirmed` and then `In Service` — or flag them absent, which starts the visible countdown to staff described below. If the customer doesn't respond within the grace period, staff can attempt an in-app message or a call — the admin dashboard surfaces the ticket with an alert and whatever contact details are available for exactly this purpose. If the customer responds and arrives within the window, service proceeds normally. If the window lapses with no response, the ticket moves to `No Show → Cancelled`, the customer is notified plainly that their ticket was released because they weren't available, and they're immediately offered a one-tap way to rejoin the queue — this is never treated as a ban. Staff are never required to delete the customer's record to process a no-show. A pattern of repeated no-shows or late cancellations can be tracked quietly on the customer's profile (section 28) as an informational signal only; by default it should not change how that customer is treated, though a business may later choose to require a confirmation call before honoring that customer's future tickets (see section 43).

This same grace-period mechanism is what governs a late-arriving appointment (section 14.3) — there is one no-show state machine in the product, used by both walk-in and appointment tickets, not two separate ones.

---

## 22. Check-In

A customer can check in via an "I Have Arrived" tap in the app, a QR code posted at the branch, staff check-in at the front desk, or the location-assisted automatic detection from section 19. Check-in time is recorded for analytics regardless of which method was used.

---

## 23. Service Session Management

When a barber starts a service, the ticket moves to `In Service`, a start timestamp is recorded, and every other affected wait estimate recalculates (section 17). When the barber marks the service complete, the ticket moves to `Completed`, an end timestamp is recorded, actual duration is calculated (feeding back into future estimates for that barber and service), the queue recalculates again, and the feedback workflow triggers (section 29).

---

## 24. Cancellation, Stepping Out, and Rebooking

A customer can cancel their own ticket or appointment at any point before being called, optionally choosing a reason (wait too long, can't make it, changed plans, found another barber, emergency, other) — these reasons roll into reporting (section 30). Separately, a customer who needs to briefly step away without losing their place can set a self-service "Stepped Out" status, which requires a quick re-check-in tap before their turn is actually called — this is deliberately distinct from a no-show, so a coffee run doesn't get treated as an absence. After any cancellation, the customer has direct paths to rejoin the same queue, book a later appointment, or choose a different branch or barber. Cancellation rules (how late a cancellation can happen, whether a reason is required) should be configurable separately for queue tickets and for appointments, since the two carry different commitment levels.

---

## 25. Branch Comparison

Since Pixel Barber operates multiple branches under one account, the customer can compare live conditions across nearby branches before choosing where to go — for example:

| Branch | Status | Service Price | Estimated Wait | Travel Time |
|---|---|---:|---:|---:|
| Osu | Open | GH₵80 | 42 min | 8 min |
| East Legon | Open | GH₵75 | 9 min | 14 min |
| Spintex | Open | GH₵65 | 18 min | 20 min |

The system may highlight a recommended branch based on a configurable combination of wait time, travel time, and price, but the final choice stays with the customer. Where the business allows it, a customer may transfer an active ticket to a different branch — the system cancels the original ticket safely, creates a new one at the destination branch, and preserves an audit trail linking the two (whether cross-branch transfer is enabled at all is still an open decision — section 43).

---

## 26. Staff Operations Dashboard

The branch dashboard shows, in real time: customers waiting, in service, called, and checked in; barbers available, busy, and on break; average wait and average service time for the day; appointment count vs. walk-in count; no-show and cancellation counts; and an explicit queue-health alert once average wait crosses a configurable threshold (e.g., 20 minutes), so a stretching queue is surfaced rather than discovered from complaints. The live queue list shows, per ticket: position, ticket number, customer name and avatar, service, assigned/preferred barber, wait time so far, check-in state, appointment status, and notification state. Each barber's card shows their status, current customer, time in service, estimated remaining time, next customer, and current workload. When wait times are stretching, staff have direct levers: pull in a barber from break, temporarily open pooled "any available" assignment for customers who'd accept the switch (section 16), or add a barber to the schedule — and, over time, use the reporting in section 30 to staff proactively for recurring busy windows rather than reacting each time.

---

## 27. Future Direction: Predictive and Conversational AI (Out of MVP Scope)

The original vision for this product included AI-generated staffing recommendations, anomaly detection on wait times, demand forecasting, automatic barber-workload balancing suggestions, and a conversational assistant for both customers and managers. All of that is deliberately out of MVP scope for now — v1's "intelligence" is the deterministic logic in sections 17, 19, and 21: real-time recalculation, geofencing, and rule-based no-show handling, not machine learning. This section exists to preserve the direction, not to spec it: if and when the business revisits this, any recommendation engine should sit clearly on top of the deterministic rules as advisory output requiring human confirmation for material changes, never replacing them, and any conversational assistant should treat booking or cancellation actions the same way — propose, then require explicit confirmation, with every resulting action logged like any other staff or customer action (section 37). Building this later on top of solid queue, appointment, and event data (rather than before that data exists) is the right order of operations.

---

## 28. Customer Database / CRM

Every customer who has ever joined a queue or booked an appointment — self-service or staff-registered — is searchable in the CRM, showing visit history, appointment history, cancellation and no-show counts, average rating given, last visit, feedback history, and communication preferences. The business may segment customers into categories such as new, returning, frequent, dormant, or at-risk, with segmentation logic kept transparent rather than a black box. Staff can message an individual customer directly (the same channel used in the no-show flow, for instance) or send a broadcast to a segment — but transactional queue/appointment messages and marketing broadcasts should rely on separate consent, since agreeing to be told your haircut is next doesn't imply agreeing to promotional texts.

---

## 29. Feedback and Service Quality

Shortly after a service completes, the customer gets a feedback request — in-app if they're in the app, SMS with a link otherwise — covering overall satisfaction, service quality, barber professionalism, waiting experience, cleanliness, and value for money, plus an optional free-text comment, all tied to that specific visit, barber, and branch. A rating below a configurable threshold should trigger an internal alert to the branch manager rather than any customer-facing consequence, so problems get seen without turning the survey into a dispute mechanism.

---

## 30. Reporting and Analytics

Daily: customers served, walk-ins vs. appointments, average wait and service time, no-shows, cancellations, ratings, queue volume. Weekly/monthly: peak hours, branch comparison, barber utilization, service popularity, average wait and service duration by barber and service type, no-show and cancellation trends and reasons, retention indicators. Business-wide: the owner can compare branches on queue pressure, average wait, volume, barber utilization, popular services, and no-show/cancellation rates. All of this is built on the same event log described in section 37 — getting that log right from day one is what makes both this reporting and the wait-time engine reliable, rather than something reconstructed after the fact.

---

## 31. Key Performance Indicators

Customer experience: average and median wait, wait-time variance, appointment punctuality, no-show rate, cancellation rate, satisfaction rating, repeat-visit rate. Operations: customers served per hour, barber utilization, average service duration, queue throughput, peak queue length, staff availability rate. Business: revenue by branch and by service (once tracked), repeat customer value, service mix, branch performance comparison.

---

## 32. Roles and Permissions (RBAC)

| Role | Sees | Can do |
|---|---|---|
| Owner / Super Admin | All branches, all data | Everything: manage branches, staff accounts, services & pricing, business-wide reports, business-wide messaging |
| Branch Manager | Their branch(es) | Manage barber schedules, edit that branch's services/pricing/hours, view branch reports, handle escalations (no-shows, low ratings), branch-level messaging |
| Receptionist / Front Desk | Their branch's live queue and customer database | Register walk-ins, edit/cancel tickets, message individual customers, check customers in; no pricing edits, no financial-style reports |
| Barber | Their own queue only | Acknowledge next customer, flag not-present, mark service complete; no access to other barbers' queues, pricing, or reports |
| Analyst (read-only) | Reports and dashboards across authorized scope | View only — no operational changes |
| Customer | Their own ticket(s), appointments, and profile | Join/cancel queue, book/cancel appointments, choose barber/service, set notification preferences, view shop-wide (not staff-level) status, leave feedback |

Permissions should be implemented as composable capabilities (view_reports, edit_pricing, manage_staff, message_customers, and so on) assigned to roles, rather than hard-coded per-role checks, so a role can be added or adjusted later — for example, a Regional Manager role if branch count grows large enough to need one — without a data-model change. All actions taken under a role are individually attributed to the staff account that took them (no shared logins) and enforced server-side, not just hidden in the UI.

Phase 2's in-app messaging (section 45) adds one further capability to this model, `view_message_content`, held only by Branch Manager and Owner — every other role with visibility into a ticket sees only that a conversation exists and its delivery/read state, never the message content itself (section 45.5 has the full model, including the audit requirement on that capability's use).

This table describes what a role can do once its account exists. How a staff account — Owner, Branch Manager, Receptionist, Barber, or Analyst — comes into existence in the first place, including the one-time exception for the very first Owner account, is covered in section 46. Creating or inviting a staff account of any role is itself gated by `manage_staff`, held only by Owner (section 46.2) — this is a deliberate scope decision, not an oversight: it is not extended to Branch Manager, even though Branch Manager otherwise manages a lot of their branch's day-to-day staffing, because account creation reaches across the whole business (a new hire needs a role and, potentially, a branch assignment decided) in a way this table reserves for Owner alone.

---

## 33. Security and Privacy

Authentication uses the account model from section 9.2 (password plus phone OTP verification), with standard protections: session management, rate limiting, and defenses against common web vulnerabilities. Data is encrypted in transit and at rest. Every material action — cancellations, walk-in registrations, reassignments, price changes — is captured in the audit log (section 36). Location data (section 19) is used only to compute that customer's own ETA in the moment, never stored as a location history, and tracking stops automatically once no longer needed; ordinary staff see an approximate signal ("about 8 minutes away"), never a customer's live coordinates. Transactional and marketing consent are tracked separately (section 28). As the operating jurisdiction, Ghana's Data Protection Act, 2012 (Act 843) and the oversight of the Data Protection Commission are the relevant framework to design consent, access, and retention practices around — including giving a customer a real way to request their data be deleted, and a defined retention period rather than indefinite storage by default (the exact period is still an open decision — section 43). Phase 2's in-app messaging (section 45) follows its own, shorter retention rule given its more ephemeral, per-visit nature rather than reusing this one: a conversation becomes read-only the moment its ticket or appointment completes, cancels, or expires, and its content is anonymized 30 days after that point (section 45.4). Neither party's real phone number or other direct contact detail is ever exposed to the other through that channel; enabling direct contact would be a new, explicitly opted-in capability, not a byproduct of messaging existing (section 45.3). Phase 2's optional biometric login (section 47) follows the same "no bespoke handling of sensitive data" posture as the rest of this section: it never captures, transmits, or stores any actual fingerprint or face data — that stays entirely on the person's own device via the standard WebAuthn/passkey mechanism, with Pixel Barber's systems only ever holding a device-bound cryptographic credential, not biometric data itself (section 47.5 has the full model).

---

## 34. Reliability, Fault Handling, and Edge Cases

Two categories of failure need explicit, tested answers rather than hope: technical faults, and product situations that are unusual but not rare.

**Technical fault handling.** A repeated tap or a retried request must never create a duplicate ticket, appointment, or service session — actions need to be idempotent. If two staff members act on the same ticket at nearly the same moment, the system must prevent an inconsistent result and tell the second actor the state has already changed, rather than silently letting the later write win. If the internet drops at a branch, the front-desk device should keep working from its last-known queue state and sync once connectivity returns; a documented manual fallback (paper tickets, calling names aloud) is still worth having for a total outage. Failed or undelivered notifications should be tracked with their delivery status and retried per policy, with a critical message (like "you're up") falling back from push to SMS automatically if push isn't confirmed delivered within a short window. A failure in anything AI-adjacent (section 27, once it exists) must never block basic queue operations.

**Product edge cases.**

| Scenario | Expected behavior |
|---|---|
| No smartphone / no data | Staff registers the walk-in (section 13); customer relies on SMS ticket link or the front-desk board |
| Requested barber unavailable | Recalculate against remaining eligible barbers; offer the pool (section 16) with the customer's consent |
| Barber goes on break | Pause new assignment to them; recalculate estimates for their existing queue |
| Barber calls in sick mid-shift | Manager bulk-reassigns their pending tickets; affected customers notified of new barber and updated estimate, with the option to cancel instead |
| Service runs long | Every downstream estimate recalculates from real elapsed time (section 17); a large jump can trigger an apologetic notification |
| Service finishes early | Queue recalculates and wait estimates drop immediately |
| New barber starts mid-day | Capacity increases and estimates recalculate |
| GPS inaccurate indoors | Geofence has a tunable radius; manual "I'm here" from either side always overrides (section 19) |
| Location permission denied | Full functionality remains via fixed-time notifications and manual arrival toggle |
| SMS fails to deliver | Delivery status tracked; staff alerted to verify the number or use another channel |
| Push silently fails | Falls back to SMS for time-critical messages (section 20) |
| Customer steps away briefly | Self-service "Stepped Out" status with re-check-in required (section 24) — not treated as a no-show |
| Appointment customer arrives late | Same grace-period/no-show mechanism as a called walk-in (sections 14.3, 21) |
| Queue projected to run past closing | Staff alerted in advance (section 11); business decides whether to keep accepting walk-ins |
| Branch closes unexpectedly | New entries frozen, affected customers notified, existing records preserved |
| Repeated no-shows from one customer | Tracked informationally on the profile only, no automatic penalty by default (section 21, section 43) |
| Duplicate join attempt (double tap, retry) | Idempotent handling prevents a second active ticket for the same customer at the same branch |
| Two staff edit the same ticket | Optimistic concurrency protection — second actor is shown the current state, not allowed to silently overwrite |

---

## 35. Queue Business Rules

Default ordering within any queue (a specific barber's or the pooled "any available" queue) is strict first-come-first-served — this is the single biggest driver of perceived fairness in any queuing system, and departing from it, even for a good reason, erodes trust fast. Configurable policies layered on top of that default cover: appointment priority within a defined arrival window (section 14.4); barber preference and service-eligibility matching (sections 15–16); a no-show/grace-period policy (section 21); a maximum queue capacity per branch, if the business chooses to cap rather than just show a longer wait; late-day admission rules (section 11); and whether cross-branch transfer is permitted (section 25). Any deviation from FIFO — such as pooling a specific-barber ticket into "any available" during a surge — requires the affected customer's explicit acceptance in the moment. The system must never continuously push a waiting customer backward without a valid, configured, auditable reason.

---

## 36. Data Model

| Entity | Key fields | Notes |
|---|---|---|
| Business | name, default currency (GHS), default policies | Single row — Pixel Barber itself |
| Branch | name, address, coordinates, hours, special closures, status | Owns its own service list, barber roster, and queue |
| Customer | name, phone (E.164-normalized), email (optional), password hash, avatar, preferred branch, notification preferences, consent settings, reliability flag | One profile shared across all branches |
| StaffUser | name, role, assigned branch(es), credentials | Role determines the capability set (section 32) |
| Barber | name, home branch, today's branch (if floating), schedule, skills, average service duration by service type, status | A schedulable resource, decoupled from a single branch |
| Service | name, description, category, default duration | Business-wide catalog entry |
| BranchService | branch, service, price, active status, local duration override | Branch-specific price/availability layer on top of Service |
| QueueTicket | ticket number, customer, branch, service, preferred barber, assigned barber, state, position, estimated wait, appointment reference (if any), check-in status, created_by (self/staff), timestamps (created, called, confirmed, completed, cancelled), cancel/no-show reason | The core record everything else reads from |
| Appointment | customer, branch, barber, service, scheduled time, status | Converts into a QueueTicket when its window arrives (14.4) |
| ServiceSession | ticket, barber, start time, end time, actual duration | The actual chair-time event, distinct from the ticket itself |
| Notification | recipient, channel, type, template, sent time, delivery status | Backs the fallback logic in section 20/34 |
| Feedback | customer, ticket/session, ratings, free text | Tied 1:1 to a completed ticket |
| QueueEvent | ticket, event type, actor, timestamp, before/after state | Append-only log — see section 37 |
| AuditLog | user, action, entity, timestamp, result | Covers non-queue administrative actions (pricing, roles, staff accounts) |
| Conversation *(Phase 2)* | ticket or appointment reference, customer, barber, status | One active conversation per customer at a time — see section 45.4 |
| Message *(Phase 2)* | conversation, sender, type (text / voice note / quick reply), body or voice-note reference, delivered/read timestamps | Voice notes capped at 60 seconds — see section 45.2 |

---

## 37. Queue Event Logging

Every queue-state transition writes an append-only event, for example:

```text
10:03  Customer joined (self-service)
10:04  Ticket PB-OSU-104 generated
10:05  Barber assigned: Kwame
10:28  Queue position changed (customer ahead completed)
10:42  Notification sent: 10-minute warning
10:47  Customer called
10:49  Customer confirmed present
10:50  Service started
11:18  Service completed
11:19  Feedback request sent
```

This is the backbone for reporting (section 30), the wait-time model (section 17), dispute resolution, and any future analysis of the data — it should exist from the first release, not be added retroactively.

---

## 38. Non-Functional Requirements

**Performance:** customer-facing screens load quickly on typical Ghanaian mobile connections; queue updates are near real-time via event-driven push rather than polling; dashboard metrics update without a full page refresh where practical.

**Availability:** queue and service operations stay highly available during each branch's configured hours; critical staff workflows have clear failure and retry states rather than silent hangs.

**Scalability:** the architecture supports one branch today and several branches tomorrow without a redesign, and handles growing concurrent customer and staff activity as branch count grows.

**Accessibility:** keyboard navigation where relevant, color-independent status indicators, readable contrast, a reduced-motion mode for the queue animation, and no reliance on animation as the sole channel for queue status (section 18).

**Observability:** logging, metrics, and monitoring for API failures, queue processing errors, notification delivery failures, authentication anomalies, and sync conflicts.

---

## 39. MVP and Phased Roadmap

**Phase 1 — Core Operations (MVP):** branch structure and hours; customer accounts with OTP verification; services and branch-specific GHS pricing; walk-in queuing and staff registration; appointment booking (per the decision to launch both together); ticket lifecycle and live tracking with avatar visualization; the dynamic wait-time calculation from section 17; SMS and push notifications with the default triggers in section 20; check-in; service session start/end; the no-show/grace-period workflow; cancellation and the "stepped out" status; basic feedback; the staff dashboard; RBAC; and basic reporting. This is deliberately larger than a bare-minimum MVP because appointment booking was chosen to ship alongside the queue rather than after it — worth revisiting if timeline pressure appears during build.

**Phase 2 — Intelligence and Multi-Branch Depth:** location-based travel-time and geofencing (section 19); historical barber/service duration learning feeding back into estimates; branch comparison and cross-branch transfer, if enabled (section 25); a richer CRM with segmentation (section 28); fuller reporting and KPI dashboards; in-app customer–barber messaging (section 45); the expanded avatar personalization and animation system (section 18's Phase 2 enhancement); and biometric (fingerprint/face) quick login for both customer and staff, added alongside every existing login path (section 47).

**Phase 3 — Exploratory:** the predictive/conversational AI direction from section 27, approached only once Phase 1–2 data exists to build on; optional payments and loyalty, if the business decides to revisit those non-goals (section 5).

---

## 40. Acceptance Criteria for Core MVP

A customer can join a valid, open branch's queue and receive exactly one active ticket containing branch, customer, service, and state. Queue position and wait estimate update without manual reconstruction, and staff and customer views always reflect the same underlying state. A closed branch cannot accept ordinary queue entries, and the correct branch-specific price displays before commitment. Only barbers eligible for a given service can be assigned to it, barber unavailability updates allocation options immediately, and manual reassignment is captured in the audit log. A called customer is notified, the 2-minute grace period is enforced, a no-show is recorded without deleting the customer record, and the next eligible customer can be called. Service start/end actions generate timestamps and an actual duration, and the queue recalculates on completion. A single customer account works across every branch, staff see only their authorized branch(es), and the owner sees business-wide data.

---

## 41. Success Metrics

**Customer:** reduction in average wait, reduction in time spent physically waiting at the shop, increase in appointment completion rate, reduction in avoidable no-shows, increase in satisfaction rating and repeat visits.

**Business:** increase in barber utilization, reduction in unproductive capacity, reduction in queue-related complaints, improved staffing accuracy during peak windows, more customers served without a proportional increase in wait.

**Product:** share of customers using digital queue/appointment features vs. pure walk-in, notification delivery rate, queue estimate accuracy, staff task completion time, uptime during business hours.

---

## 42. Product Principles

Customer control: customers should understand what's happening and have real choices, not just a number. One source of truth: customer, barber, and staff views all read from the same queue state — never a separately maintained copy. Predict, then communicate: when conditions change, recalculate and say so early rather than let the customer discover it. Rules first, future AI second: deterministic operational rules govern the product; anything AI-driven, when it exists, enhances rather than overrides them (section 27). Branch-aware by design, single-business in scope: branches are first-class objects; other businesses are not (section 5). Privacy by default: use only the customer information a given feature actually needs. Graceful failure: basic queue and service operations stay understandable even when something else fails (section 34). Auditability: material changes are traceable to a person and a time. Accessibility: animation should enhance, never gate, the experience.

---

## 43. Remaining Open Decisions

A handful of choices are still genuinely open and worth resolving deliberately rather than defaulting silently: the maximum queue capacity per branch, if any, versus simply showing an ever-longer wait; whether cross-branch ticket transfer (section 25) should be enabled at launch or held for Phase 2; whether a VIP/loyalty tier is worth introducing given the current non-goal status (section 5); whether a customer's no-show/cancellation history should ever carry a real consequence (e.g., requiring a confirmation call) or remain purely informational to staff indefinitely (section 21); which mapping/routing provider to use for travel-time estimation, given no technical constraint has been fixed yet (section 19); and the exact customer data retention period under Ghana's Data Protection Act before old records are purged or anonymized (section 33).

---

## 44. Recommended Initial User Journeys

**Remote walk-in:** Open app → choose branch → view hours/queue → choose service → choose barber → join queue → receive ticket → track position → receive arrival guidance → check in → service → feedback.

**Scheduled appointment:** Open app → choose branch → choose service and barber → select date/time → confirm → reminder → check in → service → feedback.

**Physical walk-in without a smartphone:** Customer arrives → staff registers them → ticket generated → SMS sent if a number was given → queue updates → staff calls the customer → service → feedback.

**Barber becomes unavailable mid-queue:** Customer waiting → barber flagged unavailable → reassignment engine proposes new barber → affected customer notified with updated estimate → customer accepts or cancels → queue continues.

**Customer at risk of missing their turn:** Queue nears customer's turn → travel-time signal indicates they won't make it → customer warned → customer confirms arrival, contacts staff, cancels, or rebooks → queue adjusts accordingly.

---

## 45. In-App Customer–Barber Messaging (Phase 2)

### 45.1 Availability and Scope

Once a queue ticket has an assigned barber (section 12, `assigned_barber_id`) or an appointment has a specific barber attached at booking (section 14.1) rather than "any suitable barber," a private, two-way messaging channel opens between that customer and that barber, scoped to exactly that ticket or appointment — never a standing, ongoing channel between a customer and a barber independent of an active visit. A customer with no active ticket or appointment, or whose ticket is still pooled to "any available" with no barber yet assigned, has no conversation to open.

### 45.2 What the Channel Supports

Two-way text messages; voice notes, capped at 60 seconds each, recorded and played back in-app; delivered and read-status indicators on every message; a timestamp on every message; a push/SMS notification (through the same channel-fallback logic as section 20) when a new message arrives and the recipient isn't currently looking at the conversation; and a fixed set of quick-reply messages covering the situations that come up constantly and don't deserve a typed message: "I have arrived," "I am on my way," "I will be approximately 5 minutes late," and "Are you ready for me?" A quick reply sends instantly as an ordinary message in the thread, distinguishable only by not requiring the sender to type.

### 45.3 Privacy

Neither party ever sees the other's real phone number, email, or any other direct contact detail through this feature — the conversation is the only channel available, by design, unless the business explicitly turns on a separate "allow direct contact" capability in the future. That capability does not exist yet and isn't half-built in anticipation of it; it would be introduced the same deliberate way any other deferred setting in this document is (see section 43's pattern), only once the business actually asks for it.

### 45.4 Lifecycle

The conversation is active for exactly as long as its ticket or appointment is active. The moment that ticket or appointment reaches `Completed`, `Cancelled`, or `No Show` (section 12.3, section 21), the conversation becomes read-only immediately — either party can still scroll back through it, but neither can send a new message into it. If a barber reassignment happens mid-ticket (section 16), the conversation with the original barber becomes read-only at the moment of reassignment, and a new, separate conversation opens with the newly assigned barber — a customer only ever has one active conversation at a time, with whoever is actually assigned to them right now.

A read-only conversation is anonymized 30 days after it became read-only: message content and any voice-note audio are permanently deleted, leaving only the fact that a conversation existed and its aggregate metadata (message count, first/last message time) for historical/reporting purposes — this is a separate, shorter retention rule than the 3-year customer-data retention period in section 33, reflecting how much more ephemeral a single visit's conversation is compared to a customer's account and visit history.

### 45.5 Staff Access

Staff do not casually browse customer–barber conversations. By default, any staff member with visibility into a given ticket (section 32's branch scope) can see conversation *metadata* — that a conversation exists, when it started, its message count, and its delivery/read state — the same operational signal they'd get from knowing a call was made without hearing it. Reading the actual message content is a distinct, narrower capability held only by a Branch Manager or the Owner (`view_message_content`, section 32), and every time it's used, that access is itself recorded to the audit log (section 37) with the staff member, the conversation, and the stated reason. This is meant for genuine operational and dispute-resolution use — a customer complaint about what a barber said, for instance — not routine oversight, and the audit trail is what keeps it that way.

### 45.6 Data Model Additions

Two new entities support this feature, listed in section 36: `Conversation` (linked to exactly one queue ticket or appointment, one customer, one barber, and a status of active/read-only/anonymized) and `Message` (linked to a conversation, a sender, a type — text, voice note, or quick reply — a body or voice-note reference, and delivered/read timestamps).

---

## 46. Staff, Barber, and Administrator Onboarding

Section 9.2 covers how a customer signs up. This section covers the equivalent question for the other side of the product: how an Owner, Branch Manager, Receptionist, Barber, or Analyst account comes to exist at all. Nothing in sections 26 or 32 addresses this — those describe what a role can see and do once its account exists, not how the account got there — and it is worth stating as its own section because Pixel Barber is a single business with one Owner, not multi-tenant software where "sign up as a business" is itself a product flow.

### 46.1 The First Owner Account

There is no self-service "create your business" flow, because there is only ever one business. The very first Owner account is created once, manually, as part of initial deployment — an operational setup step performed directly against the system (Supabase Auth and the corresponding `staff_users` row), not a screen a person fills in. It is the one staff account in the entire system that does not originate from an invite. Every staff account after it, regardless of role, is created the way section 46.2 describes.

### 46.2 Inviting Staff

Creating any other staff account — any role, at any branch — is something only the Owner can do, using the `manage_staff` capability (section 32). The Owner provides the new person's name, role, branch assignment, and a phone number or email address, and the system sends them an invite: a link, delivered by SMS or email depending on which contact method was given, that lets that person set their own password. The Owner never sees or sets the invitee's password — the invite link is the only thing that changes hands.

Until the invitee opens the link and completes setup, the invite sits in a pending state, visible to the Owner in a pending-invites list, where it can be resent (if the person didn't get it, or it expired) or revoked (if it was sent in error, or the hire fell through) at any time. Once the invitee sets their password, the account becomes active immediately and behaves like any other staff account of that role from that point on — there is no separate approval step after password setup.

This is deliberately the one and only way any staff account beyond the first Owner gets created — there is no secondary "add a Branch Manager" flow, and no direct-password-creation shortcut for any role, including Owner-to-Owner delegation. One mechanism, one capability gate, applied uniformly.

### 46.3 Barbers Specifically

A barber's account is created through the exact same invite flow described in section 46.2 — there is no separate barber onboarding wizard, and no reason for one, since a barber's login identity is no different from any other staff member's. What is specific to being a barber isn't decided at invite time; it's filled in afterward, through Barbers Management (section 15), by the Owner or a Branch Manager — which lines up with Branch Manager's existing capability to manage barber schedules (section 32). That includes which services the barber is qualified to perform, their working schedule, and their home branch. Setting up their PIN for the shared front-desk-station login (section 9's barber-facing login pattern) is a further, distinct admin action taken after the account exists — not part of invite acceptance, and not something the barber sets for themselves at first login.

---

## 47. Biometric (Fingerprint / Face) Login (Phase 2)

### 47.1 What This Is, and What It Deliberately Isn't

Both the customer app and the staff/admin portal should let a returning person on a device they've already used unlock the app with their device's own fingerprint or face sensor instead of typing their password — the same everyday convenience as unlocking a banking app. This is a faster way back in on a device that's seen that account before, not a replacement account system: the underlying account for a customer is still created exactly as section 9.2 describes (phone number, OTP verification, password), and a staff account is still created exactly as section 46 describes (invite, self-set password). A password always keeps working, on every device, whether or not biometric login has ever been set up — this is additive, never a dependency the rest of the product comes to rely on.

Concretely, this is built on the device's own platform authentication (Face ID, Touch ID, Android fingerprint/face unlock, Windows Hello) via the standard **WebAuthn/passkey** mechanism, not a custom biometric system of Pixel Barber's own. Section 47.5 is explicit about what that means for privacy: no fingerprint or face data of any kind is ever captured, transmitted, or stored by Pixel Barber, at any point.

### 47.2 Customer Experience

After a customer signs in with their password on a device (personal phone, most commonly), the app offers a one-time, dismissible prompt: "Use your fingerprint or face to sign in faster next time?" Accepting enrolls that device's biometric sensor against that customer's account. From then on, opening the app on that same device shows the fingerprint/face prompt as the fast path alongside the password field, never in place of it — a customer who prefers to type their password, or who's on a device without a fingerprint/face sensor, sees exactly the login screen they see today. Declining the initial prompt, or a failed biometric attempt, always falls back to the password field with no penalty and no repeated nagging. Biometric login can be turned off at any time from Profile (App Flow section 7.9/7.13); doing so does not touch the account's password.

### 47.3 Staff Experience (Personal Device)

The same shape applies to an Owner, Branch Manager, Receptionist, or Analyst on their own personal phone or laptop: password/email login (section 46) still creates and always recovers the account, and biometric unlock is an opt-in accelerator enrolled per device from that staff member's own account settings, never something an Owner sets up on someone else's behalf. This is deliberately unchanged for the shared-station barber case, which section 47.4 covers on its own terms.

### 47.4 Barber Shared Station

Section 9's barber-facing PIN login for a shared front-desk tablet keeps working exactly as-is and remains the required baseline every station must support — it is not being replaced. On a shared station whose hardware includes a fingerprint sensor, a barber who has enrolled their fingerprint on that specific station gets an additional option alongside the PIN pad: touch the sensor, and the station recognizes which barber it is and signs them in directly, without them typing their PIN. A barber enrolls their fingerprint on a given shared station as a short one-time setup step performed after they've already signed in there once (by PIN), from that same station; enrolling on one station's sensor does not carry over to a different station's hardware. Any station without fingerprint hardware, or a barber who hasn't enrolled on a given station, uses the PIN exactly as before — this is additive to section 9's existing pattern, not a hardware requirement added to every branch.

### 47.5 Privacy and Data Handling

No fingerprint image, face scan, or any other biometric data ever leaves the customer's or staff member's own device, and none of it is ever transmitted to or stored by Pixel Barber — the device's own operating system does the actual biometric matching locally and only ever tells the app "yes, this is the enrolled person" or "no." What Pixel Barber's systems store is a cryptographic credential tied to that device, which is useless on its own without the physical device and its sensor; this is the same trust model as any other passkey-based login used across the web today, not a bespoke or weaker version of it. Turning off biometric login for an account, or an Owner deactivating a staff account, immediately invalidates any credential associated with it.

### 47.6 Availability

This is Phase 2 scope, built after the MVP ships with password/OTP/PIN login exactly as sections 9.2, 46, and section 9's barber pattern already specify — it is an enhancement layered on top of that foundation, not a change to it.
