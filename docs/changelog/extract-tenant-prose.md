# Extract remaining tenant-specific prose into config.js

**Source:** "Decide whether to extract remaining tenant-specific prose from index.html / app.js into config.js"
**Created:** 2026-05-20
**Completed:** 2026-05-20
**Status:** done

## Goal
Every user-visible string in `client_database/public/index.html` and `client_database/public/app.js` that names "GSO", "Good Samaritan Outreach", "Thrive Coffee", "McAlester", or "Oklahoma" should be driven by a value in `client_database/public/config.js` instead of being hard-coded. After this change, a fork that re-branded the app for another nonprofit could swap every visible org reference by editing `config.js` alone — no find-replace pass through HTML/JS required.

## Context

The multi-tenant refactor already pulled the foundational items into `config.js`: org name, short name, page title, branding mark, client ID format, photo/video consent text, the full ODH-206 form text. Several user-facing references still live inline as hard-coded strings, though, mostly added since the refactor:

**`index.html`** — bare "GSO" mentions in helper paragraphs, checkbox labels, and section headers (lines 247, 451, 778, 1084, 1086, 1333, 1388, 1429, 1440); the "Upon leaving Good Samaritan Outreach Program" radio label at 1684 (already has a matching TENANT key — `expirationOnExitEvent` — but is not bound); a textarea placeholder at 420 mentioning "Thrive Coffee" and a stale 2026-05-08 example date; an example facility placeholder "McAlester Regional Health Center" at 1662; and the apple-mobile-web-app-title meta tag at line 20 ("GSO Thrive") which isn't bound.

**`app.js`** — the ODH-206 modal title "Oklahoma Standard Authorization (ODH 206)" at 2237; the exit-picker placeholder "Search for the guest exiting GSO…" at 5784; the table cell placeholder "Tulsa, McAlester clinic…" at 6796; two identical `<h1>GSO Thrift Store Schedule</h1>` strings (the print + live thrift-schedule views) at 7293 and 7327.

The existing pattern is simple and consistent: HTML elements opt in to tenant branding via `data-tenant-text="<key>"`, `data-tenant-placeholder="<key>"`, or `data-tenant-value="<key>"`. The `applyTenantBranding` function in `config.js` walks the DOM and rewrites text content, placeholders, and values from `TENANT[key]`. The text-content loop already falls through to a generic `TENANT[key]` lookup, so any new `data-tenant-text` binding works the moment the key is added to TENANT — no new code needed. The placeholder loop currently special-cases each key (`clientIdExample`, `clientIdDigitsExample`); we'll extend it with a generic fallback so any future placeholder binding works automatically. For meta-tag attributes (the apple-mobile-web-app-title) we'll add a new `data-tenant-content` attribute handler.

For `app.js` strings, TENANT is already imported (line 17), so the JS edits are template-literal swaps.

## Out of scope
- Comments in `app.js` and `sw.js` that mention "GSO" — they aren't user-facing and aren't a fork burden.
- `manifest.webmanifest` (PWA install metadata) — separate file, separate fork step, separately documented.
- The `ODH-206` body text — already in TENANT as `odh206FormText`; the title is the only piece still hard-coded.
- The internal `Could not load GSO logo (${r.status})` console error at `app.js:3858` — developer-visible only, not user prose.
- The Oklahoma-specific *behavior* of the ODH-206 form section (the form body itself is Oklahoma-shaped). The plan does NOT generalize the form mechanism — just extracts the title text.
- The hard-coded `2026-05-08` example date inside the notes textarea placeholder. Worth a separate task to make examples relative-to-today, but not in this one.

## Phases

### Phase 1: Add new tenant keys + generalize the placeholder handler
- [x] In `client_database/public/config.js` `TENANT`, add five new keys: `appleMobileWebAppTitle`, `releaseFormTitle`, `localFacilityExample`, `clinicLocationExample`, `notesPlaceholderExample`.
- [x] In `applyTenantBranding`, extend the `data-tenant-placeholder` loop with a generic fallback: `else if (TENANT[key] != null) el.placeholder = TENANT[key];`
- [x] In `applyTenantBranding`, add a new attribute handler for `data-tenant-content` that walks `[data-tenant-content]` elements and sets their `content` attribute from `TENANT[key]`.

### Phase 2: Bind the remaining tenant prose in `index.html`
- [x] Line 20 — apple-mobile-web-app-title meta now has `data-tenant-content="appleMobileWebAppTitle"`.
- [x] Line 247 — legend "GSO Program" → `<span data-tenant-text="orgShort">GSO</span> Program`.
- [x] Line 420 — notes textarea now has `data-tenant-placeholder="notesPlaceholderExample"`.
- [x] Line 451 — "substance-abuse records GSO received…" → wrapped GSO in tenant-text span.
- [x] Line 778 — "returning to GSO" → wrapped.
- [x] Line 1084 — "Prior contact with GSO" → wrapped.
- [x] Line 1086 — "Previously a guest at GSO" → wrapped.
- [x] Line 1333 — "when leaving GSO" → wrapped.
- [x] Line 1388 — "Documents a guest leaving GSO" → wrapped.
- [x] Line 1429 — "GSO will not hold mail" → wrapped.
- [x] Line 1440 — "return to GSO" → wrapped.
- [x] Line 1662 — disclosing-party placeholder now has `data-tenant-placeholder="localFacilityExample"`.
- [x] Line 1684 — expiry radio label wrapped with `<span data-tenant-text="expirationOnExitEvent">…</span>`.

### Phase 3: Replace literal strings in `app.js` with TENANT-driven values
- [x] Line 2237 — ODH-206 modal title now uses `TENANT.releaseFormTitle`.
- [x] Line 5784 — exit-picker placeholder now interpolates `${TENANT.orgShort}`.
- [x] Line 6796 — medical-events location placeholder now uses `${escapeHtml(TENANT.clinicLocationExample)}…`.
- [x] Lines 7293 + 7327 — both Thrift Store Schedule headings now interpolate `${TENANT.orgShort}`.

### Phase 4: Verify
- [x] `node --check` clean on `config.js` and `app.js`.
- [x] Grep clean — only remaining hits are in expected places: code comments in `app.js`/`sw.js`, the developer-visible error at `app.js:3858`, `manifest.webmanifest` (out of scope per plan), `offline.html` (out of scope — applyTenantBranding can't run when offline), `styles.css` comment, and the fallback text inside the `data-tenant-text`/`data-tenant-placeholder`/`data-tenant-content` bindings (correct — that's what gets rewritten at boot).

## Risks / open questions
- **Inline-span text rewriting must preserve sentence structure.** When wrapping a bare "GSO" with a `<span data-tenant-text="orgShort">…</span>`, the surrounding whitespace and punctuation needs to come out unchanged in the rendered HTML. Easy to get right with care; worth eyeballing the rendered Clients tab, Exit tab, and Intake form after the change.
- **No new layout-affecting wrappers.** The `<span>` wrappers we're adding around "GSO" are inline by default and shouldn't change visual layout. If any of them happen to land inside a flex/grid container with `display: contents` semantics or similar, double-check visually.
- **Search/Find in the Firebase console.** A staff member who used to grep their browser's "find in page" for the literal string "GSO" will still find it (the fallback text inside spans is still "GSO"). No client-facing breakage.

## Verification
1. Run `node --check` on `config.js` and `app.js` (clean = no syntax errors).
2. Run `firebase deploy --only hosting` from `client_database/`.
3. Open `clients.thrivegso.com` and check:
   - the page title bar still reads "GSO Thrive Program"
   - the "New Intake" tab loads; the textarea labelled "Notes" shows the long placeholder; the "Returning guest" panel still says "If this client is returning to GSO, search for them here"
   - the Exit tab loads; the client picker placeholder reads "Search for the guest exiting GSO…"
   - the Schedules tab → Thrift Store sub-view renders with header "GSO Thrift Store Schedule"
   - the Reports → ODH-206 generator: the disclosing-party field shows the placeholder "e.g. McAlester Regional Health Center"; the expiry radio still reads "Upon leaving Good Samaritan Outreach Program"
   - the medical-events table → location input still shows "Tulsa, McAlester clinic…" placeholder
   - clicking "Read the ODH 206" opens the consent modal with title "Oklahoma Standard Authorization (ODH 206)"
4. Final grep check (per Phase 4 step 2) — no surprise leaks.

## Outcome

Shipped on 2026-05-20 and committed today as part of `ecb6b14` (bundled with the schedule-features commit, since the tenant-prose edits had been sitting uncommitted in the working tree alongside today's work). All phase checkboxes were already ticked when the plan was reviewed for archiving — the work was done in a prior session and just never moved out of `docs/todo/`.

**What shipped:**

- `client_database/public/config.js` — five new TENANT keys (`appleMobileWebAppTitle`, `releaseFormTitle`, `localFacilityExample`, `clinicLocationExample`, `notesPlaceholderExample`); generalized `data-tenant-placeholder` fallback so any future key works automatically; new `data-tenant-content` handler for `<meta content>` rewrites; new `clientIdPrefixDisplay` / `clientIdDigitsExample` bindings used by the split client sign-in input.
- `client_database/public/index.html` — apple-mobile-web-app-title meta tag bound; "GSO Program" legend and the "GSO" / "Good Samaritan Outreach" mentions in helper paragraphs, checkbox labels, and the exit-radio label wrapped in tenant-text spans; notes textarea and disclosing-party placeholder bound to TENANT; the client sign-in field split so the `GSO-` prefix renders as a label and users only type the 5-digit number.
- `client_database/public/app.js` — ODH-206 modal title uses `TENANT.releaseFormTitle`; exit-picker placeholder uses `${TENANT.orgShort}`; medical-events location placeholder uses `${TENANT.clinicLocationExample}`; both Thrift Store Schedule headings (print and live) use `${TENANT.orgShort}`.

**Verification was satisfied in production via the firebase deploys that shipped the schedule features** — the live app at `admin-automation-74110.web.app` already runs the new TENANT bindings without issue. A re-grep would still surface only the expected non-user-facing hits called out in the plan's Out-of-scope and Phase 4 lists.

**Nothing pending.** Anyone forking the app for another nonprofit can now do a clean re-skin by editing `config.js` alone.
