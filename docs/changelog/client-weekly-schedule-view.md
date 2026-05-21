# Show clients their approved weekly schedule (current + previous week)

**Source:** "Need to make some updates to client.thrivegso.com — after staff has approved client schedule and/or added clients to the thrift store schedule I want the clients personal schedule for the current and preceeding week to be seen by the client."
**Created:** 2026-05-20
**Completed:** 2026-05-20
**Status:** done

## Goal
Right now a client signs in to their home screen and sees only a list of submissions with status badges ("pending", "approved", "rejected"). They cannot see what their actual approved schedule looks like, and they cannot see which thrift-store shifts staff have assigned them.

After this change, the client home screen will show a "My schedule" panel above the recent-submissions feed. The panel shows two weeks — the current week (Mon–Sun starting from the most recent Monday) and the preceding week — with each day listing the client's approved personal events (appointments, classes, etc.) and the thrift store shifts assigned to them, sorted by time. No more guessing what staff approved or what thrift shift they're on.

## Context

**Where staff data already lives** (no schema changes needed):

- `clientWeeklySchedule/{clientId}-{weekStart}` — the canonical per-client weekly schedule. Document has fields `clientId`, `weekStart` (YYYY-MM-DD Monday), and `events` (array of `{ day, startTime, endTime, type, ... }`). Written when staff approves a weekly submission in the Inbox. See `client_database/public/app.js:6744` (`loadClientSchedule`) and `app.js:11113`+ (approval transaction).
- `thriftStoreSchedule/{weekStart}` — single document per week, field `shifts` is an array of `{ day, startTime, endTime, clientId, clientName, role }`. Mon–Sat × three shifts (9–12, 12–3, 2–5). See `app.js:6638` (template) and `app.js:6727` (loader).

**What the client currently sees** on the home screen (`#client-app-section` in `client_database/public/index.html:1532`+):

- Greeting + sign-in/out pill (`#client-status-pill`)
- "Today's activity" feed (`#client-today-feed`)
- Schedule editor for submitting next week's schedule (`#client-schedule-section`, line 1567)
- Info-update form
- Ask-staff-for-help form
- **My recent submissions** (`#client-submissions-list`, line 1610) — this is the "X schedules approved" UI Daniel referenced. Rendered by `renderClientSubmissionsList` at `app.js:10699`.
- My documents

There is no UI today that reads `clientWeeklySchedule` from the client side.

**Firestore rules (`client_database/firestore.rules:289`):**

- `clientWeeklySchedule` already permits a client to read their own docs (`request.auth.token.role == 'client' && resource.data.clientId == request.auth.token.clientId`). No rule change needed.
- `thriftStoreSchedule` is currently **staff-only** (`firestore.rules:297`). Needs to be loosened so clients can read the weekly doc; client-side code will filter the `shifts` array down to just their own shifts.

**Existing helpers we'll reuse:**

- `mondayOf(input)` at `app.js:6671` — returns the Monday of any given date as a YYYY-MM-DD string.
- `addDays(yyyymmdd, n)` at `app.js:6687` — date arithmetic on YYYY-MM-DD strings.
- `formatTime12(hhmm)` at `app.js:6704` — pretty-prints "09:00" as "9:00am".
- `DAYS` / `DAY_LABELS` / `EVENT_TYPE_LABELS` at `app.js:6624`+.
- `escapeHtml`, `onSnapshot`, `query`, `where`, `doc`, `collection`, `db`, `getDoc` are already imported / in scope.

**Memory note that bit us before:** `client_database/public/app.js` is ~11k lines and a duplicate top-level `function`/`const`/`let` declaration is a parse-time SyntaxError that silently kills the entire module. Before adding any new top-level helper, grep the file for the name. Memory file: `feedback_grep_before_helper.md`.

## Out of scope

- Editing schedules from the client side — the existing "Submit for approval" workflow stays untouched.
- Push notifications when staff approves a schedule — not asked for; can be a follow-up.
- Showing more than 2 weeks of history.
- Letting clients see other clients' thrift shifts (decision: clients see their own shifts only).
- Renaming/removing the "My recent submissions" feed. It stays below the new panel.
- The `clients.thrivegso.com` cutover (separate task — currently the app lives at `admin-automation-74110.web.app`).

## Phases

### Phase 1: Loosen the Firestore rule for thrift schedule reads
- [x] In `client_database/firestore.rules:297`, change the `thriftStoreSchedule/{docId}` block so signed-in clients can `read` (alongside the existing staff allow). Pattern matches the `clientWeeklySchedule` rule above it, but without a per-client filter — Firestore rules can't iterate the `shifts` array to enforce "only your own", so the rule allows reading the whole weekly doc and the client app filters in JS.
- [x] Deploy rules in isolation: `cd client_database; firebase deploy --only firestore:rules`.
- [x] Verify in the Firebase console that the rule diff matches expectations before continuing. _(CLI compile + release succeeded; spot-check in console deferred — will catch any issue during phase 4 verification.)_

### Phase 2: Add the "My schedule" panel to the client home screen
- [x] In `client_database/public/index.html`, insert a new `<div class="client-section" id="client-my-schedule-section">` directly above the existing `<div class="client-section">` that contains `#client-submissions-list` (currently line 1608).
- [x] Panel structure: a heading "My schedule", a "This week" subhead with weekStart label + a `<div id="client-my-schedule-this-week">`, then a "Last week" subhead + `<div id="client-my-schedule-last-week">`. Each container starts with a `<p class="note">Loading…</p>` placeholder so the empty state during first paint is honest.

### Phase 3: Wire up the JS — fetch, merge, render
- [x] In `client_database/public/app.js`, grep first for any existing top-level names you plan to use (e.g. `startClientMyScheduleListener`, `renderClientMySchedule`) to avoid the duplicate-declaration trap.
- [x] Add a new module-scope state block near the other client-app state (around `app.js:9884`–`9888`). _Adjusted: switched personal data to a single query-by-clientId so a not-yet-existing weekly schedule doesn't trigger a permission-denied error on the strict per-doc rule. State block became `clientMyScheduleAllUnsub` + `clientMySchedulePersonalAll[]` + the thrift slots._
- [x] Add a function `startClientMyScheduleListener(clientId)` that subscribes (single `clientWeeklySchedule` query by clientId, plus two `thriftStoreSchedule` doc listeners), updates state, re-renders, and registers cleanup in `clientAppListeners`.
- [x] Add a function `renderClientMySchedule()` that builds the day-grouped, time-sorted list per week, merging personal events with the client's own thrift shifts, with empty state and a date-range heading.
- [x] In `initClientApp` at `app.js:9956`, add a single line `startClientMyScheduleListener(clientId);` next to the other `start*Listener` / `bind*` calls (around line 9986).
- [x] Add any CSS needed for the new section to `client_database/public/styles.css` — added `.client-myschedule-day`, `.client-myschedule-day-label`, `.client-myschedule-row`, and `.myschedule-thrift-chip`. Other styling reuses `.client-section` / `.note` / `.meta`.

### Phase 4: Deploy and verify
- [x] Deploy hosting (rules already deployed in phase 1): `cd client_database; firebase deploy --only hosting`.
- [x] Sign in as a real client account (or a test client created via the staff console) at `admin-automation-74110.web.app`.
- [x] Verify, in order:
  1. The "My schedule" panel renders above "My recent submissions".
  2. "This week" shows the client's approved personal events (if any exist) AND only their own thrift shifts (if any).
  3. "Last week" shows the same two sources for the prior Monday's weekStart.
  4. Empty state shows the "Nothing scheduled this week yet" note when both sources are empty.
  5. Approving a new schedule in the staff inbox causes the client view to update in real time (it's an `onSnapshot` listener — the page should not need refreshing).
  6. The browser DevTools console has no Firestore permission-denied errors for either collection.
- [x] Spot-check that other clients' thrift shifts are filtered out in the rendered output, even though the underlying doc contains them.

## Risks / open questions

- **Privacy of the thrift doc payload at the network level.** ✅ Resolved 2026-05-20 (Daniel): acceptable. The Firestore rule will allow any signed-in client to read the full weekly thrift doc — client-side JS filters down to just the signed-in client's shifts. Other clients' names exist in the wire payload but not in the rendered UI; that's fine for the GSO residential context.
- **Custom-token clients and `email_verified`.** Memory `firebase_rules_custom_token_email_verified.md` warns that `signInWithCustomToken` tokens lack `email_verified`, so a strict `isSignedIn()` helper can silently deny client reads. Check `firestore.rules` `isSignedIn()` definition before deploying phase 1; if it gates on email_verified, the new thrift rule must use the `role == 'client'` branch directly (same as the existing `clientWeeklySchedule` rule).
- **Definition of "preceding week".** ✅ Resolved 2026-05-20 (Daniel): Mon–Sun calendar week immediately before the current Mon–Sun week. Cadence context: clients submit their schedule on Sunday morning for the following Mon-start week — so "preceding week" is the just-finished week, "this week" is the active Mon-start. Plan as written matches this.
- **What if there's no approved schedule for the current week yet?** Plan renders the empty state per-week — clients won't see a broken UI on Monday morning before staff has done anything.

## Verification

Manual smoke test on `admin-automation-74110.web.app`:

1. As staff, approve at least one weekly submission for a test client whose `weekStart` is the current Monday. Confirm `clientWeeklySchedule/{cid}-{weekStart}` exists in Firestore.
2. As staff, fill at least one thrift shift in `thriftStoreSchedule/{thisMonday}` for that same test client.
3. Sign out of the staff side. Sign in to the client side as the test client (the client login flow uses `signInWithCustomToken`).
4. The "My schedule" panel should appear on the client home screen, above "My recent submissions".
5. "This week" should list the approved personal events AND the thrift shift assigned to that client, on the right day, in time order.
6. "Last week" should show the equivalent for `{thisMonday - 7d}` (or "Nothing scheduled" if blank).
7. Open DevTools → Network and confirm no `permission-denied` Firestore errors. Confirm the only thrift shifts shown in the rendered DOM belong to the signed-in client (use Inspect to grep for other clientIds — should be absent from the rendered output).
8. While still signed in as the client, have someone on staff approve a new event or assign a new thrift shift to that client. The client view should update without a page refresh (live `onSnapshot`).

## Outcome

Shipped and verified on production (`admin-automation-74110.web.app`) on 2026-05-20.

**What changed:**

- `client_database/firestore.rules` — `thriftStoreSchedule/{docId}` now allows reads from signed-in clients (role==client) in addition to staff. Other allow blocks unchanged. Deployed via `firebase deploy --only firestore:rules`.
- `client_database/public/index.html` — new `<section id="client-my-schedule-section">` inserted above the recent-submissions section, with "This week" and "Last week" subsections.
- `client_database/public/app.js` — added module state (`clientMyScheduleAllUnsub`, `clientMySchedulePersonalAll`, `clientMyScheduleThrift`, week-start cursors) plus three new functions: `startClientMyScheduleListener`, `renderClientMySchedule`, `renderClientMyScheduleWeekHtml`, plus helpers `renderClientMyScheduleError` and `formatClientWeekRange`. The listener subscribes via a single query-by-clientId for personal schedules + one doc-listener per week's thrift master doc. Hooked into `initClientApp`. Cleanup registered with the existing `clientAppListeners` array.
- `client_database/public/styles.css` — added `.client-myschedule-day`, `.client-myschedule-day-label`, `.client-myschedule-row`, `.myschedule-thrift-chip`.

**One deviation from the plan:** the plan called for `onSnapshot(doc(db, "clientWeeklySchedule", "${clientId}-${weekStart}"))` per week. That approach would have been denied by the existing Firestore rule when the doc didn't yet exist (rule accesses `resource.data.clientId`, which is null for a non-existent doc). Switched to a single `where("clientId","==",clientId)` query on the collection, and the renderer picks out the right week from the result set. Same observable behavior, but no permission-denied flash for clients whose week hasn't been approved yet.

**No commits made** — `client_database/` is a git repo but `CLAUDE.md` says only commit when explicitly asked. Production is updated via the live `firebase deploy`; the local file diff is uncommitted.

**Nothing pending.** Daniel verified the panel renders, shows the right shifts, filters out other clients, and updates in real time when staff approves changes.
