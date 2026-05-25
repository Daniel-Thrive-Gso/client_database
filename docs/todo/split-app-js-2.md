# Split public/app.js into native ES modules — Part 2 (continuation)

**Source:** "Continue the public/app.js split — break the remaining Phase 2-5 work into ~8-10 truly-self-contained slices."
**Created:** 2026-05-24
**Status:** planned
**Supersedes:** Phases 2-5 of `docs/todo/split-app-js.md` (which itself stays as historical context — Phase 0, Phase 1, and the audit-log slice from that doc already shipped to production).

## Goal

Finish extracting `public/app.js` (currently 11,844 lines) into native ES modules under `public/shared/` and `public/features/`. The end state remains what the original plan described: `app.js` becomes a thin entry point (~80 lines), each feature lives in its own file, and the `typeof X === "function"` guards in the auth router (and elsewhere) are replaced by real `import` statements.

The new plan differs in **ordering and granularity**: 8 sub-phases, each one a 1-3 commit slice that's deployable + verifiable in isolation. The original plan's "extract 4 leaves together in Phase 2" framing was wrong because only the Audit Log was a true leaf.

## Context

### What's already in place

| Module                            | Purpose                                                  |
| --------------------------------- | -------------------------------------------------------- |
| `shared/firebase.js`              | Firebase SDK init, ALLOWED_DOMAIN, callables             |
| `shared/helpers.js`               | escapeHtml, capitalize, isOnProbation, levelDisplay, etc.|
| `shared/auth-state.js`            | currentUserRole / currentUserClientId + setters          |
| `shared/dom-shell.js`             | 8 app-shell DOM refs                                     |
| `shared/audit-log-writer.js`      | AUDIT_ACTIONS + logAccess (used by every feature module) |
| `features/audit-log.js`           | Admin-only Audit Log tab UI                              |

### The actual coupling map (what bit us last round)

The auth router (`onAuthStateChanged` in app.js, lines ~210-310) has these `typeof X === "function"` guards still in place:

| Guard                                | Owner                                | Phase that retires it |
| ------------------------------------ | ------------------------------------ | --------------------- |
| `stopBedsListener` (x2 — teardown)   | Beds                                 | **2.5**               |
| `startBedsListener`                  | Beds                                 | **2.5**               |
| `stopCheckInOutListener`             | Check-in-out                         | **2.4**               |
| `startCheckInOutListener`            | Check-in-out                         | **2.4**               |
| `mountCheckInOutQuickPicker`         | Check-in-out                         | **2.4**               |
| `stopInboxListener`                  | Inbox                                | **2.3**               |
| `startInboxListener`                 | Inbox                                | **2.3**               |
| `stopStaffPerEventListener`          | Roster (per-event hydrator)          | **2.6**               |
| `startStaffPerEventListener`         | Roster                               | **2.6**               |
| `stopClientAppListeners` (x2)        | Client App                           | **2.7**               |
| `loadMedicationCatalog`              | Intake (medication picker)           | **2.8**               |

Plus a second cluster inside `startClientsListener` (lines ~674-687):

| Guard                                | Owner                                | Phase                 |
| ------------------------------------ | ------------------------------------ | --------------------- |
| `renderClientBedAssignment`          | Beds (Client Detail subsection)      | **2.5**               |
| `renderClientProgram`                | Client Detail                        | **2.7+**              |
| `tryInitRoster`                      | Roster                               | **2.6**               |
| `tryInitSchedules`                   | Schedule                             | **2.6**               |
| `tryInitReports`                     | Reports                              | **2.6**               |

And several inside `openClientDetail` / consents flow (lines 2318-2320, 3557) — those move with Client Detail itself in Phase 2.7+.

### Why every previous "leaf" wasn't actually a leaf

- **Self-Eval** → uses `createClientPicker` → reads `cachedClients` (state owned by app.js's Clients-cache section).
- **Beds** → has a per-client bed fieldset (`renderClientBedAssignment`) that lives in Client Detail because it renders inside the open client panel. The Beds tab and the Client Detail fieldset are two views of the same data.
- **Inbox** → renders weekly-schedule submissions with conflict diffs that need `eventsOverlap`, `formatTime12`, `formatEventLi`, `DAY_LABELS`, `EVENT_TYPE_LABELS` — all schedule infrastructure.
- **Clients-cache** → its live listener calls `renderClientBedAssignment` + `renderClientProgram` (Client Detail) on every snapshot, and bootstraps Roster + Schedule + Reports on first fire.

### The unblocker: clients-store as an event emitter

The cleanest way to break the Clients-cache coupling without dragging Client Detail along is to **convert the Clients listener into a small event emitter**. Consumers `subscribe()` to either the snapshot stream or a per-client updated event. Client Detail still lives in app.js for a while, but it subscribes instead of being called by the listener. Same for Roster / Schedule / Reports init.

Once `shared/clients-store.js` exists with this shape, `createClientPicker` can move to `shared/client-picker.js` (it imports `getClients()` from the store), and then any feature that needs the picker — Self-Eval, Reports, Schedule, Exit, Intake re-entry — can move independently.

### Schedule formatters as a separate slim module

Inbox depends on schedule formatters but not on schedule UI. Extracting `shared/schedule-helpers.js` (with `DAY_LABELS`, `EVENT_TYPE_LABELS`, `EVENT_TYPES`, `formatTime12`, `eventsOverlap`, `formatEventLi`) is a tiny, low-risk move that lets Inbox extract cleanly without waiting for the whole Schedule tab to move.

## Out of scope

- Same exclusions as the original `split-app-js.md`: no bundler, no TypeScript, no internal logic refactoring beyond what import-cleanup forces.
- Splitting `index.html` or `styles.css`.
- Splitting `functions/index.mjs`.
- Adding tests (separate todo item).
- Renaming or restructuring the section banners as we move them — minimal touch beyond extract + import.

## Phases

Each phase = 1-3 commits, each commit deployable + smoke-tested. Phases ordered so each unblocks the next.

### Phase 2.1: Foundation — clients-store + client-picker + schedule-helpers

Unblocks every later phase. No `typeof` guards retired here; the win is pure capability unlock.

- [x] Create `public/shared/clients-store.js` — owns `cachedClients` + `clientsSearchText` (exported as live `let` bindings) + the live `clients` collection listener. Exports start/stop, `getClients()`, `setSearchText()`, `subscribe(callback)`, `subscribeError(callback)`, `clientMatchesSearch`. Side-effect calls into Client Detail / Roster / Schedule / Reports stay in app.js as top-level store subscribers — each retires as its owning feature module moves.
- [x] Create `public/shared/schedule-helpers.js` — `DAY_LABELS`, `EVENT_TYPES`, `EVENT_TYPE_LABELS`, `timeToMinutes`, `formatTime12`, `eventsOverlap`, `formatEventLi`. Pure, no state.
- [x] Create `public/shared/client-picker.js` — `createClientPicker`. Imports `getClients` + `clientMatchesSearch` from clients-store, `escapeHtml` + `fmtDate` from helpers. `selfEvalPickerRoot` init stays in app.js for now.
- [x] Update app.js to import the moved symbols. *(`cachedClients` / `clientsSearchText` are live-binding imports so the 24+ existing references didn't need to change. Also moved `fmtDate` + `fmtTimestamp` to `shared/helpers.js` since the picker needs `fmtDate` for DOB display.)*

**Smoke-test gate:** Self-Eval picker still selects clients; Clients tab still renders + searches; Schedules client picker still works.

### Phase 2.2: Self-Eval

- [x] Create `public/features/self-eval.js` — extracts the Self-Eval submit form, picker init, report listener, render, resolve button, seed button. Exports `initSelfEval()` + `stopSelfEval()`, called from the auth router on staff sign-in/out. app.js: 11,649 -> 11,463 lines.

**Smoke-test gate:** Sign in, submit one self-eval, see it in the report, mark resolved, watch it disappear.

### Phase 2.3: Inbox

- [x] Create `public/features/inbox.js` — extracts the entire inbox section (listener, filter toggle, render, conflicts, hydrate-canonical-events, all 3 approval handlers, printStaffRequest, rejectSubmission). Exports `startInboxListener`, `stopInboxListener`, plus `invalidateInboxThriftCache` (called by Schedule's thrift-save handler). Retires the `typeof startInboxListener` + `typeof stopInboxListener` guards in the auth router. *(Also extracted: `shared/program-constants.js` with `STATUS_UPDATE_*` + `CLIENT_SUB_TYPES` + `REQUEST_SUBJECT_LABELS` + `statusUpdateCategory`; and `scheduleExpiresAt` + `SCHEDULE_TTL_DAYS_AFTER_WEEK` to `shared/schedule-helpers.js`.)* app.js: 11,463 -> 10,755 lines.

**Smoke-test gate:** Sign in as a client, submit an info-update + a weekly-schedule. Sign back in as staff, open Inbox, see both rows, approve one, watch it leave.

### Phase 2.4: Check-in-out

The Sign In/Out tab + the "currently out" tile + the per-client check-in/out history fieldset all move together. The history fieldset technically renders inside Client Detail, but it's tightly coupled to the check-in-out feature.

- [ ] Create `public/features/check-in-out.js` — last-24h listener (9658-current), tab render (9706), staff quick-pick (9796), reason modal (9896), event-write helper (9962), per-client history fieldset (10043). Exports `startCheckInOutListener()`, `stopCheckInOutListener()`, `mountCheckInOutQuickPicker()`, `writeCheckInOutEvent(...)`, `loadClientCheckInOut(cid)`.
- [ ] Wire `client-detail`'s per-client section to call `loadClientCheckInOut(cid)` directly — retires that typeof guard.

**Smoke-test gate:** "Currently out" tile shows correct count; staff backfill a sign-out; client signs in via PIN and signs themselves out; open client detail and check the history fieldset renders.

### Phase 2.5: Beds

Same shape as 2.4 — Beds tab + per-client bed fieldset are two views of the same data, move together.

- [ ] Create `public/features/beds.js` — beds listener (8886-area), Beds tab UI (8975-9070), pick-a-bed modal (9072-9278), transactional writes (9280-9654), per-client bed fieldset (the part of Client Detail that calls `renderClientBedAssignment`). Exports `startBedsListener()`, `stopBedsListener()`, `renderClientBedAssignment(cid, data)`, plus a `subscribe()` if needed.
- [ ] Have the clients-store subscriber in Client Detail call `renderClientBedAssignment` directly (no typeof guard). Retires that guard + the two auth-router beds guards.

**Smoke-test gate:** Beds tab loads; assign + release a bed; open client detail, confirm bed fieldset renders and updates live.

### Phase 2.6: Roster + Schedule + Reports

These three share an init-on-first-clients-snapshot pattern. They move together because they all subscribe to the clients-store and clean up the `tryInit*` + `*Initialized` guards. The staff-per-event listener also moves with Roster.

- [ ] Create `public/features/schedule.js` — the full Schedules tab (lines 6541-7656). Exports `tryInitSchedules()`, `stopSchedule()`. Uses `shared/schedule-helpers.js` from 2.1.
- [ ] Create `public/features/reports.js` — Reports tab (7770-8972). Exports `tryInitReports()`.
- [ ] Create `public/features/roster.js` — Daily Roster (lines 6249+) + the staff-per-event listener (6328-6363). Exports `tryInitRoster()`, `startStaffPerEventListener()`, `stopStaffPerEventListener()`.
- [ ] Wire all three as clients-store subscribers (one per feature). The auth router stops calling them on staff sign-in — they self-init when the first snapshot fires.

**Smoke-test gate:** Sign in fresh; roster + schedules + reports all populate without manual tab-clicking; switch dates / weeks / modes; per-event mealLog hydration auto-ticks roster boxes.

### Phase 2.7: Client App (entire client-facing UI)

The client PWA — PIN sign-in, home, info update, staff request, scanned docs, my-schedule. Move all of it together. Retires the `stopClientAppListeners` + `clearCurrentIdentity` client-path branch.

- [ ] Create `public/features/client-app/sign-in.js` — PIN-based sign-in form (10258-10318).
- [ ] Create `public/features/client-app/home.js` — initClientApp, today listeners, state pill, feed (10322-10815).
- [ ] Create `public/features/client-app/info-update.js`.
- [ ] Create `public/features/client-app/staff-request.js`.
- [ ] Create `public/features/client-app/scanned-docs.js`.
- [ ] Create `public/features/client-app/my-schedule.js`.
- [ ] Move `currentClientDisplayName` (currently still in app.js because of the `clientAppMaster` dependency) into `client-app/home.js`.
- [ ] Wire the client-path branch of `onAuthStateChanged` in app.js to call `initClientApp` + `stopClientAppListeners` directly.

**Smoke-test gate:** Full PIN-flow end-to-end — sign in, view home, submit info update, submit staff request, view scanned docs, view my schedule, sign out cleanly.

### Phase 2.8: Client Detail + Intake (the giant)

The cross-cutting hub. Probably 2-3 commits since the file would be > 3k lines otherwise.

- [ ] Create `public/features/client-detail/index.js` — orchestrator: open/close/reset (2451), header + master (2555), bed fieldset wiring (already moved in 2.5; just imports), program summary (`renderClientProgram`).
- [ ] Create `public/features/client-detail/medications.js` — sensitive medical reveal, medications add/discontinue, the two medication modals (2731, 2846, 2916-3169).
- [ ] Create `public/features/client-detail/odh206.js` — ODH-206 authorizations (3213-4548).
- [ ] Create `public/features/client-detail/consents.js` — consents block (4549-4739).
- [ ] Create `public/features/client-detail/uploads.js` — the two upload modals (4740, 4978).
- [ ] Create `public/features/client-detail/exit-history.js` — exit history view (5805-6248).
- [ ] Create `public/features/client-detail/intake-history.js` — intake history (3170-3212) + reset PIN (10130).
- [ ] Create `public/features/client-detail/photo-modal.js` — update/take photo modal (11907-end).
- [ ] Create `public/features/intake/intake-form.js` — the Intake tab top-level form: Section 1 Identity (1021), conditional sub-sections (1543), Drug Screen (1628), medication picker (1681), photo capture (1936), signature pad (2056), consent modal driver (2147), Photo/Video + ODH-206 modals as launch points (2191-2245), Storage upload helper + post-save uploads (2251-2450).
- [ ] Create `public/features/intake/add-medication-modal.js` (1815-1934 + 2916-3087).
- [ ] Create `public/features/intake/discontinue-medication-modal.js` (3089-3170).
- [ ] Retire the typeof guards inside `openClientDetail` (loadClientPhiRecords, loadClientCheckInOut already done in 2.4, resetStatusUpdateForm, loadClientConsents) by switching to direct imports.

**Smoke-test gate:** Full intake — new client end-to-end with photo, signature, all consents, ODH-206, medications. Open client detail and exercise every section. Run an Exit. Submit a status update.

### Phase 2.9: Extract auth router → features/auth.js + final shrink

By now most guards are gone. The auth router becomes mostly direct imports.

- [ ] Create `public/features/auth.js` — `onAuthStateChanged`, the idle-timeout block, sign-in/out button handlers, Google redirect handler. Imports all the start/stop hooks directly.
- [ ] Shrink `app.js` to a thin entry point: should be under 80 lines, mostly imports.
- [ ] Move `provisionClientPin` to a shared/clientauth-helpers.js or fold into intake — it's a one-liner around `clientAuthCreate`.

**Final smoke-test gate:** the full plan-original checklist (sign in, exercise every tab, both auth paths, sign out cleanly, no console errors).

## Risks / open questions

1. **Events-emitter overhead in clients-store.** Subscribing 4-5 features (Client Detail, Roster, Schedule, Reports, Beds fieldset) to one store is fine, but the order of subscriber invocation matters — if Beds renders before Client Detail finishes opening, you can see a frame of stale state. **Mitigation:** make `subscribe()` synchronous (callback fires inside the snapshot handler) and document that subscribers shouldn't `await` inside.

2. **Schedule helpers and Inbox formatters share state names.** `EVENT_TYPES`, `EVENT_TYPE_LABELS`, `DAY_LABELS` are referenced in 7+ places. Make sure the import-side names match exactly to avoid silent shadowing. **Mitigation:** grep before merging each phase.

3. **Client Detail is genuinely huge** (~6 sub-modules in 2.8). Risk of accidental coupling between sub-modules during the move. **Mitigation:** treat 2.8 as 3 commits, not 1. First commit: index.js + medications + odh206 (the biggest sections). Second: consents + uploads + exit-history. Third: intake/* + intake-history + photo-modal. Smoke test between each.

4. **CHECKINOUT_REASONS, INTAKE_BENEFIT_TYPES, LEADERSHIP_ROLES** are program constants currently in app.js. As features that use them move, decide per-constant: move to `shared/program-constants.js` if used cross-feature, or keep with the feature module if used only there. Decide during each phase — don't pre-extract.

5. **Cache-buster on submodules** — already handled by `scripts/deploy.ps1` per Phase 0 of the original plan. No work needed.

## Verification

### Smoke-test checklist (run after every phase)

The same 12-step checklist from `docs/todo/split-app-js.md` § Verification. Repeated here for ease:

1. Staff Google sign-in lands on Self-Eval tab with no console errors.
2. Self-Eval submit / mark-resolved round trip.
3. Clients tab loads, search filters live, click into one, detail opens.
4. Beds tab loads, assign + release one.
5. Sign In/Out tab — quick-pick a client, backfill a sign-out, see it in recent activity.
6. Schedules tab — load current week, edit a thrift slot, save, reload to confirm persistence.
7. Reports tab — switch modes, no errors.
8. Intake — new client end-to-end including photo, signature, consents, ODH-206; success screen shows PIN.
9. Inbox approval round-trip — client submits, staff approves, master updates.
10. Client PWA — PIN sign-in, home renders, sign-out works.
11. Sign out (staff + client) returns to dual sign-in cleanly, no orphaned listeners.
12. Console-error sweep — open DevTools, exercise 1-11, no red / no "uncaught" / no "is not a function".

### Greppable end-state checks

- `wc -l public/app.js` → under 80 lines.
- `grep -c "typeof.*function" public/app.js public/features/**/*.js public/shared/**/*.js` → only the legit ones (createClientPicker's onChange callback check, the Roster/Schedule/Reports init-once flags) survive.
- `grep -rn "// TODO" public/shared public/features` → no orphaned in-flight markers from the split.
