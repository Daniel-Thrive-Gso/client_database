# Staff schedule UI: 2 clients per thrift slot, in-place appointment edits, visible save confirmation

**Source:** "On the staff side of the schedule there is 3 changes that needs to be made. 1. on the thrift Store schedule … 2 clients per schedule … 2. … Need to be able to click on a schedule in the consolidated view so changes can be made to either the date or the time for a client. There is also no way for a staff member to add an appointment for a client … 3. When the submit button is pushed staff need a confirmation that the submission was successful."
**Created:** 2026-05-20
**Completed:** 2026-05-20
**Status:** done

## Goal

Three independent improvements to the staff-side weekly schedule UI in `client_database/public/`. After this task ships:

1. **Thrift store schedule supports 2 clients per shift slot.** Each row in the thrift editor (e.g. Monday 9–12) has two client + role pickers side by side. Total fillable slots per week becomes 3 shifts × 6 days × 2 clients = 36.
2. **Staff can edit or add a client's appointment from the consolidated view in one click.** Clicking an event card in the consolidated view opens a modal with that event's fields pre-filled. A new "+ Add appointment" button at the top of the consolidated view opens the same modal in blank mode with a client picker.
3. **Visible "Saved" confirmation on both staff Save buttons.** The current tiny inline "Saved 12:34:56 PM" text is replaced with a clearly visible green confirmation that stays for a few seconds.

## Context

**Files in play:**

- `client_database/public/app.js` — all logic. Existing relevant landmarks: `renderThriftScheduleTable` at `app.js:6803`, `detectConflicts` at `app.js:6824`, `renderConsolidated` at `app.js:6948`, `saveClientSchedule` at `app.js:~7060`, `saveThriftSchedule` at `app.js:7165`, the just-shipped `renderClientMyScheduleWeekHtml` (client-side) at `app.js:~10800`.
- `client_database/public/index.html` — schedule editor markup. Thrift table header at line ~640; consolidated view container; save buttons (`#client-schedule-save` at line 633, `#thrift-schedule-save` at line 657).
- `client_database/public/styles.css` — minor additions for the new modal + confirmation banner.
- `client_database/firestore.rules` — no changes expected; existing rules cover both collections.

**Current shift schema** (stored on `thriftStoreSchedule/{weekStart}.shifts[]`):

```
{ day, startTime, endTime, clientId, clientName, role }
```

**Current event schema** (stored on `clientWeeklySchedule/{cid}-{weekStart}.events[]`):

```
{ day, startTime, endTime, type, title, location, notes }
```

**Current confirmation pattern** in `saveClientSchedule` and `saveThriftSchedule`: just sets `#client-schedule-status` / `#thrift-schedule-status` to `Saved ${new Date().toLocaleTimeString()}` in muted style. Easy to miss.

**Two memory notes that apply here:**

- `feedback_grep_before_helper.md` — `app.js` is 11k+ lines; duplicate top-level declarations are a silent SyntaxError that kills the whole module. Grep before naming any new helper.
- `firebase_rules_custom_token_email_verified.md` — irrelevant here (we're not changing rules), noted for completeness.

## Out of scope

- **Editing thrift shifts from the consolidated view** — thrift edits still happen in the thrift schedule editor (different data model, different conflict semantics). The modal in phase 2 only handles personal appointments (`kind === "client"` in the consolidated view).
- **Three+ clients per thrift slot** — the schema upgrade is exactly two slots; if a third client ever needs to share a slot, that's a future task.
- **Migrating old saved shifts** — existing thrift docs only have slot-1 fields. The new code treats missing slot-2 fields as "empty slot", so no backfill needed.
- **Client-side "Submit for approval" confirmation** — Daniel scoped phase 3 to the two staff Save buttons only.
- **Auto-conflict-resolution** — adding/editing an appointment that overlaps an existing event will still surface in the existing conflicts panel; no new auto-detection logic in the modal itself beyond the live conflicts re-render.

## Phases

### Phase 1: Thrift store schedule — two clients per shift slot

Schema decision: keep the existing `clientId/clientName/role` fields as "slot 1" (so old saved shifts remain valid with no migration) and add parallel `clientId2/clientName2/role2` fields for "slot 2". An empty `clientId2` means slot 2 is unassigned.

- [x] Update `renderThriftScheduleTable` at `app.js:6803` to render two additional cells per row: a second `clientDropdown(s.clientId2)` and a second `role` text input bound to `data-field="role2"`. Update the table header in `index.html` (around line 640) to add `Client 2` / `Role 2` columns. _Also: extended `clientDropdown(selected, field = "clientId")` to take a field name, and bumped the empty-state colspan from 6 to 8._
- [x] Update `applyEditToRow` callers — confirmed the existing handler at `app.js:~7036` writes `eventArr[idx][field] = e.target.value` directly from `data-field`, so the new `clientId2` / `role2` fields flow through unchanged.
- [x] When `clientId2` changes via the dropdown, look up the name into `clientName2` _at save time, mirroring how slot 1 works today (no live name sync needed)._
- [x] Update `saveThriftSchedule` at `app.js:7165` to include `clientId2`, `clientName2`, `role2` in each saved shift payload. Name-resolution from `cachedClients` for slot 2 mirrors slot 1. _Also: extended the "row is non-empty" filter to consider slot-2 fields._
- [x] Update `buildThriftTemplateShifts` at `app.js:6644` to seed empty `clientId2: ""`, `clientName2: ""`, `role2: ""` on each new template shift so a fresh week renders the second column as a blank picker (not a missing cell).
- [x] Update `detectConflicts` at `app.js:6824` so the thrift-overlap loop iterates both slots: for each shift, check `clientId` AND `clientId2` against that client's personal events. Keep the existing "two events overlapping within one client's own schedule" check unchanged.
- [x] Update the inbox conflict-detection path that reads canonical thrift shifts. _Filter at `app.js:11226` now accepts a shift where either `clientId` or `clientId2` matches; the downstream consumer at line 11091 only iterates the filtered shifts so no further changes needed._
- [x] Update `renderConsolidated` at `app.js:6948` so each thrift shift contributes up to TWO entries to `byDay` (one per filled slot). Each entry should set `clientId` and `clientName` to the slot-specific value, plus carry `role` from that slot. _Also: shifts with no client in either slot still surface as "(unassigned)" so empty time blocks remain visible to staff._
- [x] Update the printable thrift matrix (`handleThriftPrint`, find via grep on the click-handler at `app.js:7236`) so each cell shows both clients when present. _Did this via `buildThriftPrintMatrix` at `app.js:7305` — it now pushes both names into the slot's day cell; the existing renderer already pads to 2 lines per cell._
- [x] **Update the just-shipped client-side `renderClientMyScheduleWeekHtml`** so the `myThrift` filter checks both slots and tags the role from whichever slot matched.
- [x] CSS: added `.schedule-table .thrift-slot-divider { border-left: 1px solid var(--border); }` and applied the class to the slot-2 `<th>` + first slot-2 `<td>` so staff see a clear column boundary.

### Phase 2: Edit / add appointment modal driven from the consolidated view

Modal lives in `index.html` as a hidden `<dialog>` (or styled `<div>` overlay if `<dialog>` is awkward to wire up — check what the codebase already uses; grep for `<dialog`). Opens in two modes:

- **Edit mode** — triggered by clicking a `.consolidated-event` card whose `data-kind="client"`. Pre-fills day/startTime/endTime/type/title/location/notes from the clicked event and stores the client's docId + event index so Save knows where to write. Client field is shown but disabled.
- **Add mode** — triggered by a new `#consolidated-add-appointment` button rendered at the top of the consolidated view. Client field is enabled (dropdown of active clients, same as `clientDropdown(...)` at `app.js:6771`); other fields start blank.

Steps:

- [x] In `index.html`, add a `<dialog id="appointment-modal">` block (preferred — closest match to browser-native UX). Inside: client dropdown, day select, startTime, endTime, type select, title input, location input, notes textarea, plus Save / Delete / Cancel buttons.
- [x] In `app.js`, grep first for any name collisions — none found.
- [x] Render-side change in `renderConsolidated`:
  - Added `data-kind="client" data-client-id="…" data-event-key="…"` to each personal `.consolidated-event` div (composite key `day|startTime|endTime|type|title`); class `.is-clickable`; `role="button" tabindex="0"` for keyboard access.
  - Added `<button id="consolidated-add-appointment">+ Add appointment</button>` in a `.consolidated-toolbar` placed above `#schedule-consolidated`.
- [x] New function `openAppointmentModal(mode, prefill)` that fills inputs, disables the client picker in edit mode, shows Delete only in edit mode, and shows the dialog.
- [x] New function `saveAppointmentModal()` that validates required fields, runs `runTransaction` against `clientWeeklySchedule/{cid}-{weekStart}` (matches `saveClientSchedule`'s pattern), updates the in-memory cache, re-renders conflicts + consolidated, and writes an audit entry via `logAccess`. Re-finds the target event by composite key in the live array to survive reorders; throws a "changed by someone else" error if the original event vanished.
- [x] New function `deleteAppointmentModal()` that runs the same transaction shape with a `splice` and a `confirm()` prompt.
- [x] Wire up handlers: delegated click + keyboard (Enter/Space) on `#schedule-consolidated`; click on `#consolidated-add-appointment`; click on the modal's Save / Delete / Cancel buttons.
- [x] CSS: no existing modal pattern in the codebase — authored from scratch in `styles.css` (modal box, backdrop, form rows, action row with Delete pulled left, clickable card hover/focus affordance, toolbar layout).

### Phase 3: Visible save confirmation on both staff Save buttons

- [x] Decide on banner style. _Went with a fixed-position toast (top-right) so it's visible regardless of which pane the user is looking at; uses a single `<div id="staff-save-toast">` added to `index.html` and a `showStaffSaveConfirmation(text)` helper that mirrors `showClientActionStatus`._
- [x] In `saveClientSchedule`, call `showStaffSaveConfirmation("Client schedule saved")` on success. _Kept the existing muted `Saved HH:MM:SS` inline text alongside the toast — quiet timestamp + visible confirmation. Cleaner than dropping it since the inline status pre-dates this change._
- [x] In `saveThriftSchedule`, same change with text "Thrift schedule saved".
- [x] CSS for the banner: green background, light-green border, dark-green text, ~1rem padding, slide-in animation. Fixed-position top-right with shadow.
- [x] Error path: the existing `catch (err) { alert("Save failed: ${err.message}"); }` stays — no change.

### Phase 4: Deploy and verify

- [x] Sanity-check `app.js` syntax: `cd client_database/public; node --check app.js`.
- [x] Deploy hosting: `cd client_database; firebase deploy --only hosting`. Rules unchanged so no rules deploy.
- [x] Sign in as staff at `admin-automation-74110.web.app`, open the schedule editor for the current week.
- [x] **Phase 1 verification** — thrift editor has two client + role columns; assignments persist; consolidated view shows both; client-side panel surfaces slot-2 shifts.
- [x] **Phase 2 verification** — clicking a client card opens the modal pre-filled; saving persists the change; "+ Add appointment" opens a blank modal with client picker; Delete confirms and removes. _Cache-bust fix: bumped `app.js?v=` query string in `index.html` so the new JS actually loaded._
- [x] **Phase 3 verification** — green confirmation toast appears top-right on both staff Save buttons; auto-fades.

## Risks / open questions

- **Inbox approval flow may double-write slot 2 names.** The approve-submission transaction at `app.js:~11113` copies `events` from the submission into `clientWeeklySchedule`. That path doesn't touch thrift shifts, so slot-2 should be unaffected — but worth grepping during phase 1 to confirm no inbox code naïvely reads `shift.clientId` only.
- **Consolidated-event click target on touch devices.** Phase 2's clickable cards need a cursor-pointer hover affordance and decent touch target size. Check existing `.consolidated-event` styles before adding.
- **What if staff edits an event for a client whose `clientWeeklySchedule/{cid}-{weekStart}` doc doesn't exist yet?** The modal save handler must `set` with `merge: true` and initialize `clientName` / `clientId` / `weekStart` / `weekStartTimestamp` / `createdAt` / `createdBy` the same way `saveClientSchedule` does. The plan calls this out but the implementer must not miss it.
- **Event matching by composite key vs. array index.** Editing/deleting needs a stable identifier. Index is fragile if the events array gets reordered between render and save. Composite key (`day-startTime-endTime-type-title`) is safer but has a tiny edge case if two events share all five fields. Mitigation: encode the event's array index AT RENDER TIME into the modal's stored state, then re-validate at save time that the indexed event still matches the composite key — if not, fall back to a fresh search by composite key. Slight extra code, much safer than either alone.

## Verification

Manual smoke test on `admin-automation-74110.web.app`:

1. As staff, open the weekly schedule editor.
2. Phase 1: assign two clients to a thrift slot, save, refresh, verify persistence, verify both appear in consolidated. Sign in as the slot-2 client, verify their "My schedule" panel includes the shift.
3. Phase 2: from the consolidated view, click an existing personal appointment → modal opens pre-filled → change the time → save → refresh → change persists. Click "+ Add appointment" → fill out a new appointment for a different client → save → appears in consolidated and in that client's schedule. Edit again → Delete → confirm prompt → disappears.
4. Phase 3: click "Save client schedule" and "Save thrift schedule"; both surface a clearly visible green confirmation that auto-fades. Inline "Saved HH:MM:SS" text either gone or kept as a secondary timestamp (per phase-3 decision).
5. Audit log spot-check: open the audit log view (find via existing `logAccess` consumers) and confirm both modal save and modal delete write entries with the right `clientId` and action.

## Outcome

Shipped and verified on production (`admin-automation-74110.web.app`) on 2026-05-20.

**What changed:**

- `client_database/public/index.html` — two new `Client 2` / `Role 2` columns on the thrift schedule editor; a `+ Add appointment` toolbar above the consolidated view with a hint about clickable cards; an `<dialog id="appointment-modal">` with client / day / start / end / type / title / location / notes fields plus Save / Delete / Cancel buttons; a fixed `<div id="staff-save-toast">` for success confirmations; bumped the `app.js?v=` cache buster.
- `client_database/public/app.js` — extended `clientDropdown(selected, field)` to take a field name; `renderThriftScheduleTable` now renders the two-client row; `saveThriftSchedule` and `buildThriftTemplateShifts` persist/seed slot-2 fields; `detectConflicts` checks both slots; `renderConsolidated` emits a card per filled slot and tags each client card with composite `data-event-key` so the modal can match it back; `buildThriftPrintMatrix` pushes both names; `hydrateInboxRowThrift` filters by either slot; client-side `renderClientMyScheduleWeekHtml` filters by either slot and picks the right role. New module-level state and ~10 helpers added for the appointment modal: `appointmentEventKey`, `openAppointmentModal`, `closeAppointmentModal`, `saveAppointmentModal`, `deleteAppointmentModal`, plus `handleConsolidatedClick` / `handleConsolidatedKeydown`; `showStaffSaveConfirmation` toast helper; both `saveClientSchedule` and `saveThriftSchedule` now fire the toast on success.
- `client_database/public/styles.css` — `.thrift-slot-divider`, `.consolidated-toolbar`, `.consolidated-event.is-clickable` hover/focus, the `<dialog>` modal styling (box + backdrop + form rows + Delete pulled to the left + status text), and the `.staff-save-toast` fixed-position banner with slide-in animation.

**One bug caught during verification:** the first deploy didn't pick up the new JS because the `<script src="app.js?v=…">` cache-buster query string was unchanged from a prior deploy. Browser served the cached old `app.js`, so the new buttons rendered but their handlers weren't registered. Bumped to `v=20260520-staff-sched-edits-1` and redeployed.

**No commits made** — `client_database/` is a git repo but `CLAUDE.md` says only commit when explicitly asked. Production is updated via `firebase deploy --only hosting`; the local file diff is uncommitted.

**Nothing pending.** Daniel verified phases 1, 2, and 3 all behave on production after the cache-bust fix.
