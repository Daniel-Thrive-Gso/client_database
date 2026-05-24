# Split public/app.js into native ES modules

**Source:** "Split public/app.js (12k lines, one ESM) into native ES modules — no bundler, no build step, keep firebase deploy unchanged. Goal: make duplicate top-level declarations impossible across files (silent SyntaxError has bitten twice) and make per-section reasoning tractable"
**Created:** 2026-05-23
**Status:** planned

## Goal

Split `public/app.js` (12,077 lines, one ES module) into ~12 smaller modules along the existing section-banner boundaries. After the split:

- A duplicate top-level `const`/`let`/`function` in one file *cannot* silently kill another section, because each section lives in its own file with its own top-level scope.
- A staff member onboarding (or Claude in a future session) can read one ~1k-line file to understand one feature, instead of grepping a 12k-line monolith.
- Nothing else changes: no bundler, no `npm run build` step, `firebase deploy --only hosting` still ships the static `public/` directory verbatim. The browser fetches modules natively via `<script type="module">`.

## Context

### What the file looks like today

- Single ES module loaded from `index.html` via `<script type="module" src="app.js?v=...">`.
- 49 `// ----- ... -----` section banners group functions thematically. Section boundaries are real and respected by the code — most state used by a section is also declared in that section.
- **~70 top-level `let`s**. Most are module-local in spirit (`rosterDirty`, `bedModalState`, etc.). About **6 are truly cross-cutting**: `currentUserRole`, `currentUserClientId`, `cachedClients`, `clientsSearchText`, `unsubscribeSnapshot`, `unsubscribeClients`.
- **94 `document.getElementById(...)` calls** at module top, between lines 131-165 and scattered later — the cached DOM references the rest of the file uses.
- **~12 cross-section function calls in `onAuthStateChanged`** are guarded by `typeof X === "function"` checks (e.g. `if (typeof startBedsListener === "function") startBedsListener()`). This works today only because hoisting lifts every function to the top of the single module. After a split, this pattern breaks — the references have to become real `import`s.

### Why the `typeof` guards are the load-bearing problem

`onAuthStateChanged` (the auth router) is the single conductor that wakes up every feature on sign-in and tears it down on sign-out. It calls `startBedsListener`, `startInboxListener`, `startCheckInOutListener`, `mountCheckInOutQuickPicker`, `loadMedicationCatalog`, `tryInitRoster`, `tryInitSchedules`, `tryInitReports`, `resetAuditState`, and their `stop*` siblings. Every one of those references will become an `import` after the split. **This refactor is mostly an exercise in untangling those handles**, not in moving code.

### Shared-state inventory

Three categories. The plan handles each differently:

1. **Truly shared, written-by-one / read-by-many:** `currentUserRole`, `currentUserClientId`. Owner: the auth router. Consumers: rules-aware UI bits (audit tab visibility, client-vs-staff branching). → live in `shared/auth-state.js`, exported as named `let` bindings (ESM live bindings — consumers see updates without polling).

2. **Truly shared, mutable cache:** `cachedClients`, `clientsSearchText`. Owner: the clients-listener feature. Consumers: Self-Eval picker, Intake re-entry picker, Reports, Schedules. → live in `features/clients-cache.js`, exported as a small store with `getClients()` / `subscribe()` so consumers don't have to know about the underlying `let`.

3. **Section-local mutable state** (everything else): stays inside the feature module that owns it. `bedModalState` lives in `features/beds.js`. `rosterDirty` lives in `features/roster.js`. Etc. — these become genuinely private and stop polluting one shared global scope.

### DOM references

94 cached `getElementById` calls cluster into:
- **App-shell refs** (signinSection, appSection, clientAppSection, userBar, signinBtn, signoutBtn, signinError) → `shared/dom-shell.js`
- **Feature-local refs** (intakeForm, reportBody, clientsBody, etc.) → live in the feature module that uses them.

### Helpers used cross-section

`escapeHtml`, `capitalize`, `isOnProbation`, `levelDisplay`, `clientDisplayName`, `isCurrentUserAdmin`, `currentClientDisplayName`, `fmtClientTimeShort` and the formatters at top of file. All pure — no state. → live in `shared/helpers.js`.

### Firebase + tenant config wiring

The Firebase SDK initialization (`initializeApp`, `getAuth`, `getFirestore`, `getStorage`, `getFunctions`) and the callable wrappers (`clientAuthCreate` etc.) — all needed by almost every feature. → live in `shared/firebase.js`. Each feature module imports `{ db, auth, storage }` from there.

### Service worker compatibility

`sw.js` is already network-first with opportunistic caching (any same-origin script/style/image is cached on first request, served from cache on offline reload). No precache list of JS files to maintain. Adding ~12 module files just means the first visit fetches a few more files; the SW pre-caches them as they're requested. No SW changes needed for the split itself.

### Deploy story

Firebase Hosting serves `public/` as static files. No build step today; none needed after the split. `firebase deploy --only hosting` continues to work. Cache-buster pattern (`app.js?v=...`) only needs to bump the entry file — submodules are imported via static `import` statements without query strings, so the SW + HTTP cache versioning is governed by the entry-file fetch.

## Out of scope

- Adding a bundler (Vite, esbuild). Already considered and ruled out — preserves the no-toolchain deploy.
- Adding TypeScript. Separate consideration; would compound the migration risk.
- Refactoring the section internals. The goal is **move + import-cleanup only**. Logic changes happen later, after the split lands.
- Splitting `index.html` or `styles.css`. Both have their own structure problems; tackle separately.
- Splitting `functions/index.mjs` (354 lines, Cloud Functions). Manageable as-is; revisit when it grows.
- Adding tests. Covered separately by the "Cloud Functions smoke tests" item already in the candidate list.

## Phases

Each phase = one commit. Each commit is independently deployable and smoke-tested before moving on. Phases ordered to land low-risk leaf modules first; the auth-router refactor (Phase 2) is the meaningful pivot.

### Phase 0: Deploy script with automatic cache-buster (prerequisite)

Lands as one small commit before any module-splitting. Retires the manual cache-buster ritual and ensures every subsequent split phase ships with reliable cache invalidation.

- [x] Add `scripts/deploy.ps1` (or `scripts/deploy.mjs`) that: computes a version stamp (`git rev-parse --short HEAD`, fallback to UTC timestamp), rewrites `SW_VERSION` in `public/sw.js`, rewrites the `?v=...` on the entry `<script>` tag in `public/index.html`, then calls `firebase deploy --only hosting` (with optional `--only functions`, `--only firestore:rules` pass-through flags). *(commits 028ffea + be8aab7 — second commit fixed a UTF-8 round-trip bug discovered on first production run)*
- [x] Document the script at the top of `docs/code-map.md` under the deploy section so the manual `firebase deploy` instruction points here instead. *(landed in docs/code-map-logic.md instead, since that file owns the deploy diagram; plus CLAUDE.md at gso/ root)*
- [x] Run it once end-to-end to confirm the version stamp lands in both files and the deployed app picks up the new SW. *(verified 2026-05-24 — first run revealed the UTF-8 bug, second run shipped clean files)*

**Smoke-test gate:** deploy the current `main` (no code change) via the new script → check DevTools → SW shows the new version stamp → reload → no cached-stale issues.

### Phase 1: Shared scaffolding + pure helpers

Lay the foundation without changing any feature behavior. After this phase, `app.js` shrinks by maybe 200 lines and the four shared modules exist for later phases to import.

- [x] Create `public/shared/firebase.js` — exports `{ app, auth, db, storage, functions, provider, clientAuthCreate, clientAuthSignIn, clientAuthReset, clientAuthDisable, clientAuthEnable, ALLOWED_DOMAIN }`. Imports from CDN, calls `initializeApp(TENANT.firebase)`, runs `applyTenantBranding()`.
- [x] Create `public/shared/helpers.js` — exports `escapeHtml`, `capitalize`, `isOnProbation`, `levelDisplay`, `clientDisplayName`, `isCurrentUserAdmin`, `fmtClientTimeShort`, plus the `LEVEL_KEYS` / `LEVEL_LABELS` / `PROBATION_DEFAULT_DAYS` constants `levelDisplay` depends on. *(Divergence: `currentClientDisplayName` deferred to Phase 5 — it reads the client-app-scoped `clientAppMaster` state, which doesn't move until then.)*
- [x] Create `public/shared/auth-state.js` — exports `currentUserRole` and `currentUserClientId` as `let` named exports (ESM live bindings), plus `setCurrentIdentity({ role, clientId })` and `clearCurrentIdentity()`.
- [x] Create `public/shared/dom-shell.js` — exports the 7 app-shell DOM refs (signinSection, appSection, clientAppSection, userBar, signinBtn, signoutBtn, signinError, userEmail).
- [x] Update `app.js`: replace its inline copies of the moved helpers with `import` statements from the new shared modules. The file still owns everything else. *(`app.js` 12,077 → 11,992 lines; 4 new shared modules total 154 lines; no `typeof X === "function"` guards touched yet — that's Phase 2.)*
- [x] *(Cache-buster bump is now automatic via `scripts/deploy.ps1` — no manual step needed at phase boundary. The next time `deploy.ps1` runs it will stamp sw.js + index.html.)*

**Smoke-test gate:** full checklist (below) must pass before committing.

### Phase 2: Auth-router refactor + leaf feature modules

This is the load-bearing phase. After this, `onAuthStateChanged` no longer uses `typeof X === "function"` guards — every start/stop hook is a real `import`. Four leaf features (Self-Eval, Audit, Beds, Inbox) move out at the same time, because each is what the auth router calls.

- [ ] Create `public/features/self-eval.js` — owns the Self-Eval tab (lines 402-580 today + the related picker init at 4542). Exports `initSelfEval()`, `stopSelfEval()`.
- [ ] Create `public/features/audit-log.js` — owns the admin-only Audit tab (lines 895-1019). Exports `initAuditLog()`, `stopAuditLog()`, `resetAuditState()`.
- [ ] Create `public/features/beds.js` — owns the Beds tab + bed-picker modal + transactional writes (lines 8975-9654). Exports `startBedsListener()`, `stopBedsListener()`, and a `getBed(bedId)` accessor for the client-detail bed fieldset that lives elsewhere for now.
- [ ] Create `public/features/inbox.js` — owns the Inbox tab and `pendingClientSubmissions` listener. Exports `startInboxListener()`, `stopInboxListener()`.
- [ ] Create `public/features/auth.js` — owns `onAuthStateChanged`, the idle-timeout block (lines 244-309), the sign-in/out button handlers, and the Google redirect handler. Imports `startBedsListener`, `stopBedsListener`, `startInboxListener`, `stopInboxListener`, `initSelfEval`, `stopSelfEval`, `initAuditLog`, `stopAuditLog`, `resetAuditState` directly. **No more `typeof` guards** for the symbols this phase moved. Remaining `typeof` guards (for sections not yet split) stay until their owning phase.
- [ ] Move `logAccess()` + `AUDIT_ACTIONS` to `shared/audit-log-writer.js` (separate from the Audit tab UI, which is `features/audit-log.js`). Every feature module that writes audit entries imports from here.
- [ ] Strip the moved code from `app.js`. Bump cache-buster.

**Smoke-test gate:** full checklist below, with extra attention to sign-in / sign-out / idle-logout, since the auth router was rewired.

### Phase 3: Schedule + Reports + Check-In/Out

Medium-isolation features. Each is largely self-contained but reads from the clients cache.

- [ ] Create `public/features/clients-cache.js` — owns `cachedClients`, `clientsSearchText`, the live clients-listener (lines 750-879). Exports `startClientsListener()`, `stopClientsListener()`, `getClients()`, `subscribe(callback)` so consumers get notified on cache updates without polling.
- [ ] Create `public/features/schedule.js` — owns the Schedules tab in full: loaders (6727), renderers (6758), conflict detection (6827), consolidated view (6924), editing (7030), save handlers (7137), printable view (7306), appointment modal (7437), week nav (7718), client picker (7772). Exports `tryInitSchedules()`, `stopSchedule()`. Imports `getClients` from `clients-cache.js`.
- [ ] Create `public/features/reports.js` — owns the Reports tab (lines 7770-8972). Exports `tryInitReports()`. Imports `getClients` and `selfEvaluations` listener accessor.
- [ ] Create `public/features/check-in-out.js` — owns the Sign In/Out tab: last-24h listener (9658), tab render (9706), staff backfill quick-log (9796), reason picker modal (9896), event-write helper (9962). Exports `startCheckInOutListener()`, `stopCheckInOutListener()`, `mountCheckInOutQuickPicker()`, and `writeCheckInOutEvent(...)` for callers in other modules (client app uses it).
- [ ] Wire the new init/stop functions into `features/auth.js` — drop the corresponding `typeof` guards.
- [ ] Strip moved code from `app.js`. Bump cache-buster.

**Smoke-test gate:** full checklist + the specific schedule round-trips noted at the bottom.

### Phase 4: Intake + Client Detail + the modal swarm

The big one — most cross-cutting code, most modals, most state. Split into sub-modules so any one file stays under ~1500 lines.

- [ ] Create `public/features/intake/intake-form.js` — owns the Intake tab top-level form: Section 1 Identity (1021), conditional sub-sections (1543), Drug Screen 15-panel (1628), medication picker (1681), photo capture (1936), signature pad (2056), the consent modal driver (2147), Photo/Video consent launch (2191), ODH-206 read-only modal (2225), Cloud Storage upload helper (2251), post-save uploads (2260-2914).
- [ ] Create `public/features/intake/add-medication-modal.js` — the modal-driven "+ Add new medication to catalog" flow (lines 1815-1934 + 2916-3087).
- [ ] Create `public/features/intake/discontinue-medication-modal.js` — lines 3089-3169.
- [ ] Create `public/features/client-detail/index.js` — the orchestrator for the client-detail panel (open/close/reset at 2451; header + master at 2555; sensitive identity reveal at 2644; sensitive medical reveal at 2731; medications add/discontinue at 2846; intake history at 3170; ODH-206 authorizations at 3213; consents at 4549; upload modals at 4740 + 4978; exit history at 5805; per-client bed fieldset at 9072; per-client check-in/out history at 10043; reset PIN at 10130; update/take-photo modal at 11907).
- [ ] Split the client-detail orchestrator further if any single sub-section exceeds 1000 lines — e.g. `client-detail/medications.js`, `client-detail/odh206.js`, `client-detail/consents.js`, `client-detail/uploads.js`, `client-detail/exit-history.js`, `client-detail/reset-pin.js`.
- [ ] Wire the new init/stop functions into `features/auth.js`. Most of this code is invoked lazily (when staff opens a client detail or starts an intake), so most modules don't need a startup hook — they self-register their event listeners on import. Document which is which.
- [ ] Strip moved code from `app.js`. Bump cache-buster.

**Smoke-test gate:** the full checklist plus an intake-end-to-end run (new intake → photo → signature → consents → ODH-206 → submit → PIN appears).

### Phase 5: Client app + final shrink

The CLIENT-side counterpart, then `app.js` becomes a thin entry point.

- [ ] Create `public/features/client-app/sign-in.js` — PIN-based sign-in form (lines 10258-10318).
- [ ] Create `public/features/client-app/home.js` — `initClientApp`, today listeners, state pill, today feed (lines 10322-10815).
- [ ] Create `public/features/client-app/info-update.js` — client info-update submission (10819-10898).
- [ ] Create `public/features/client-app/staff-request.js` — staff help request submission (10900-10974).
- [ ] Create `public/features/client-app/scanned-docs.js` — read-only documents view (10976-11020).
- [ ] Create `public/features/client-app/my-schedule.js` — approved personal events + assigned thrift shifts (11022-11905).
- [ ] Wire all six into `features/auth.js`'s client-path branch. Drop the last `typeof` guards.
- [ ] Shrink `app.js` to a thin entry point — should be under 80 lines: imports, applyTenantBranding(), then re-exports nothing (modules self-register).
- [ ] Bump cache-buster.

**Final smoke-test gate:** full checklist, plus a deliberate sign-in/out cycle on both staff and client to catch any teardown leak.

## Risks / open questions

1. **Live ESM bindings + sign-in timing.** ESM `let` exports are live bindings — when `auth.js` writes `setCurrentIdentity({ role: 'staff' })`, every consumer that imported `currentUserRole` sees the new value on its next read. This works, but a consumer that captured the value into a local at module load time would see `null` forever. **Mitigation:** code review every consumer of `currentUserRole` / `currentUserClientId` after Phase 1 to ensure they read the binding, not a snapshot.

2. **`isCurrentUserAdmin()` placement.** It currently reads from `auth.currentUser.email`. After Phase 1 it lives in `shared/helpers.js` but still needs to import `auth` from `shared/firebase.js` and `isAdminEmail` from `config.js`. This creates a cycle risk (`shared/helpers.js` → `shared/firebase.js` → ...). **Mitigation:** confirm during Phase 1 that the dependency chain stays acyclic. If it's tight, move `isCurrentUserAdmin` into `shared/auth-state.js` instead.

3. **Self-registering modules vs explicit init.** Some modules are best invoked from the auth router (`startBedsListener` — needs to start *only* on staff sign-in). Others are best self-registering (the "+ Add medication" modal — just needs its click handler bound on load). The plan calls for both, but the line isn't always clean. **Mitigation:** when in doubt during a phase, prefer explicit init in `auth.js` — easier to reason about teardown.

4. **Cache-buster on submodules.** ✅ **Decided 2026-05-23: add a deploy script.** Modules imported via `import './features/foo.js'` get cached by the HTTP layer + SW with no version query string. A standalone change to a submodule wouldn't invalidate the cache. The script (`scripts/deploy.ps1` or `scripts/deploy.mjs`) does three things before calling `firebase deploy`:
   1. Compute a version stamp (git short SHA, falling back to UTC timestamp if not in git).
   2. Rewrite `SW_VERSION` in `public/sw.js` to that stamp — on activate, the SW deletes all caches not matching, invalidating every cached submodule in one stroke.
   3. Rewrite the `?v=...` query string on the entry `<script>` tag in `public/index.html` to the same stamp — defends against the browser's HTTP cache serving a stale entry before the SW takes over.

   This retires the manual "remember to bump cache-buster on every app.js edit" foot-gun (memory: `feedback_bump_appjs_cachebuster`). The script should be landed *before* Phase 1 so the rest of the split phases can rely on it. Listed as a prerequisite below.

5. **Risk of "the wrong split."** The phasing assumes the section banners reflect real boundaries. They mostly do, but the client-detail orchestrator in Phase 4 may need finer-grained sub-modules that we can't fully predict until we're in it. **Mitigation:** Phase 4 explicitly allows further splitting mid-phase if any sub-module crosses 1000 lines.

6. **Cloud Run cold-start trick.** None — this is browser-only. Phasing is safe to deploy at any time.

## Verification

### Smoke-test checklist (run after every phase, before committing)

1. **Staff Google sign-in** lands on the Self-Eval tab with no console errors.
2. **Self-Eval submit:** type a reason → pick a client → submit → row appears in the report below → click "Mark resolved" → row disappears.
3. **Clients tab:** open → search box filters in real time → click a row → client detail opens with name, ID, status pill rendering.
4. **Beds tab:** loads with bed list → click an empty bed → assign a client → bed flips to occupied → release it.
5. **Sign In/Out tab:** "currently out" tile renders → quick-pick a client → backfill a sign-out → event appears in recent activity.
6. **Schedules tab:** load current week → click a thrift slot → edit it → save → "Saved" toast appears → reload page, change persists.
7. **Reports tab:** switch between daily / weekly / monthly / yearly / per-client → numbers render, no console errors.
8. **Intake (new client):** New Intake → fill Section 1 → take photo → capture signature → trigger Photo/Video consent → trigger ODH-206 → submit → success screen shows GSO-##### and a 6-digit PIN.
9. **Inbox approval round-trip:** Sign in as the just-created client (PIN above) → tap "Update my info" → change phone → submit. Sign back in as staff → Inbox shows pending row → click Approve → row disappears, client master shows new phone.
10. **Client home:** PIN sign-in → Hi banner → today feed renders → sign-out button works.
11. **Sign out (staff + client):** both should return to the dual sign-in screen cleanly; no orphaned listeners (check console for `Firestore: Listener detached` vs leaked warnings).
12. **Console-error sweep:** open DevTools → reload → sign in → exercise 1-11 → verify the console is clean (no red, no "uncaught", no "is not a function").

### What to grep for if the split breaks something

- **"is not a function":** an `import` somewhere is misspelled or the symbol isn't exported. Check the offending module's `export` list.
- **Silent "nothing happens" on a click:** an event listener didn't bind because the module wasn't imported. Check `app.js` (entry) — does it import the feature module?
- **`Cannot read properties of null (reading 'addEventListener')`:** a feature module ran before its DOM element existed. Either the script tag for the entry needs to be after the relevant HTML (it is — script is at end of body), or the module is doing `document.getElementById` at top level for an element rendered later. Move the lookup into the init function.
- **Stale data on screen:** likely the consumer captured a value at module load time instead of reading a live binding. See Risk #1.

### How to verify the end state

- `wc -l public/app.js public/features/**/*.js public/shared/**/*.js` — sum should be roughly equal to the original 12,077 (allow ±5% for the import boilerplate). `app.js` itself should be under 80 lines.
- `grep -c "typeof.*function" public/app.js public/features/auth.js` — should be 0 in `auth.js`; should not appear at all unless documented.
- A second pair of eyes (or a fresh Claude session) can navigate the codebase by feature name without grep — open `public/features/`, pick a folder, that's the whole feature.
