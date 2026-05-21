# Commit and document the in-flight PWA work

**Source:** "Commit and document the in-flight PWA work (sw.js, manifest.webmanifest, offline.html, public/icons/, scripts/generate-pwa-icons.ps1)"
**Created:** 2026-05-19
**Completed:** 2026-05-19
**Status:** done

## Goal
Get the PWA ("Add to Home Screen" / installable web app) work out of the working tree and into `main` on `Daniel-Thrive-Gso/client_database`, with a short changelog entry so Daniel — and a future fork — can see what was added and why. After this task, `git status` in `client_database` should be clean except for unrelated work, the live site at `admin-automation-74110.web.app` should serve a valid manifest + service worker, and a phone visiting the site should see the "Install app" prompt.

## Context

The uncommitted diff in `client_database/` is actually **three things tangled together**, not just PWA. Splitting them cleanly is the main planning question:

1. **PWA scaffolding (the named task)** — new files and tag/header wiring:
   - `public/sw.js` (new) — network-first service worker with offline fallback; deliberately does **not** cache Firebase Auth/Firestore calls
   - `public/manifest.webmanifest` (new) — name "GSO Thrive Program", standalone, dark theme `#111111`, three icon entries
   - `public/offline.html` (new) — dark-themed "you're offline" page
   - `public/icons/` (new) — 5 PNGs: 192, 512, maskable-512, apple-touch (180), favicon-32
   - `scripts/generate-pwa-icons.ps1` (new) — regenerates the icons from `public/forms/gso-logo.png`; safe to re-run any time the logo changes
   - `public/index.html` — manifest link, `theme-color`, apple-touch + apple-mobile-web-app tags, `viewport-fit=cover`, title bumped from "GSO Staff — Self-Evaluation Tracker (Prototype)" to "GSO Thrive Program", SW registration script at end of `<body>` (gated on `https:` + `serviceWorker in navigator`)
   - `public/config.js` — `pageTitle` updated to match the new manifest name
   - `public/styles.css` — ~138 lines of mobile polish: safe-area-inset padding, `overscroll-behavior-y: contain`, `-webkit-tap-highlight-color`, 16px input font (kills iOS auto-zoom on focus)
   - `firebase.json` — Cache-Control headers: `/sw.js` no-cache, `/manifest.webmanifest` 5min, `/icons/**` 30d immutable

2. **2026-05-19 client-app feature batch (smoke-tested, already in changelog 2026-05-19):**
   - `firestore.rules` — `staffRequest` submission type added with validation
   - `public/app.js` — staffRequest form binding, `lostEmployment` status type, new scanned-doc types (`vaCard`, `dd214`, `programCert`), new exit-housing options (`drugRehab`, `mentalHealthInpatient`), `REQUEST_SUBJECT_LABELS`
   - `public/index.html` (a subset of its diff) — "Ask staff for help" section, "Lost job" status option, three new document-type options, two new exit-housing radios

3. **Required-field indicators (already has its own changelog file `docs/changelog/required-field-indicators.md`):**
   - `public/styles.css` — the `label:has(:required) > .lbl::after { content: " *"; }` rule (5 lines, near the top of the diff)
   - `public/index.html` — sprinkled `<span class="lbl">…</span>` wrappers around required-field labels

The PWA registration is gated on `https:`, so the SW won't run on `localhost` (just on the live Firebase Hosting URL). Service-Worker-Allowed header in `firebase.json` lets a root-scoped SW served from `/sw.js` control the whole origin.

**Repo:** `Daniel-Thrive-Gso/client_database`. Two commits on `main` so far: `c7d467d` (initial) and `6c0eddc` (multi-tenant refactor). No `.git` issue — line-ending warnings are normal.

**Deploy:** `firebase deploy --only hosting,firestore:rules` from `client_database/`. Functions weren't touched.

## Out of scope
- Custom domain cutover to `clients.thrivegso.com` — that's a separate todo line, and the manifest's `start_url`/`scope` (`/`) is host-agnostic so it doesn't need to change.
- Push notifications, background sync, periodic sync — sw.js is intentionally minimal.
- Caching Firebase Auth / Firestore traffic — explicitly avoided in `sw.js` so the app always talks to the live backend.
- A real install-prompt UI ("Install on home screen" button + `beforeinstallprompt` handling) — defer until staff actually want it.
- The unrelated todo items below the PWA line (artifacts policy, Node 22, etc.) — separate plans.

## Phases

### Phase 1: Decide the commit split and document it
- [x] Confirm with Daniel: split the uncommitted diff into **two commits** — (a) PWA scaffolding (incl. mobile/safe-area CSS + title rebrand), and (b) "2026-05-19 client app updates" (staffRequest, lostEmployment, doc types, exit housing, required-field indicators bundled together since they were tested as one release). **Decided 2026-05-19: bundle required-field indicators into commit (b).**
- [x] Write `client_database/docs/changelog/pwa.md` (new file inside the `client_database` repo, not the gso-root `docs/changelog/`) with: what shipped, why (mobile install + offline fallback, no Firebase caching), how to regenerate icons (`pwsh scripts/generate-pwa-icons.ps1`), how to bump the SW (`SW_VERSION` constant in `sw.js`), and the deliberate non-goals from "Out of scope" above. Audience: a future maintainer who has never seen this code.

### Phase 2: Stage and commit the PWA bundle
- [x] In `client_database/`: `git add` the new files — `public/sw.js`, `public/manifest.webmanifest`, `public/offline.html`, `public/icons/`, `scripts/generate-pwa-icons.ps1`, and the new `docs/changelog/pwa.md` from Phase 1.
- [x] `git add firebase.json` — the whole diff is PWA-related (three new headers blocks for sw.js, manifest, icons), safe to add wholesale.
- [x] `git add public/config.js` — only one line changed (`pageTitle`), part of the PWA rebrand.
- [x] Use `git add -p public/index.html` to stage **only**: the PWA `<head>` block (manifest link, theme-color, apple-touch tags, etc.), the `viewport-fit=cover` change, the title change, the styles.css/app.js cache-buster version bumps (`?v=20260519-pwa-mobile-1`), and the bottom-of-body SW registration script. **Skip** the `<span class="lbl">` wrappers and the staffRequest/lostEmployment/doc-types/exit-housing hunks — those go in Phase 3.
- [x] Use `git add -p public/styles.css` to stage **only** the PWA + mobile polish block at the bottom (`/* ─── PWA + mobile polish ─── */` comment and below). **Skip** the `label:has(:required) > .lbl::after` rule near the top.
- [x] Run `git diff --cached` and eyeball — make sure nothing from the feature batch slipped in.
- [x] Commit (`94679f0`). Message:
  ```
  Add installable-PWA scaffolding (manifest, service worker, icons)

  Clients and staff can now "Add to Home Screen" on phones and get an
  app-shell icon + standalone window. Service worker provides an offline
  fallback page only — Firebase Auth/Firestore traffic is deliberately
  NOT cached so the app always talks to the live backend.

  Files:
  - public/sw.js, public/manifest.webmanifest, public/offline.html
  - public/icons/ (192, 512, maskable-512, apple-touch, favicon-32)
  - scripts/generate-pwa-icons.ps1 (re-run to regenerate after logo change)
  - firebase.json — Cache-Control headers for sw, manifest, icons
  - public/index.html — manifest link, apple-touch tags, SW registration
  - public/styles.css — mobile polish (safe-area, no-bounce, 16px inputs)
  - public/config.js — pageTitle rebrand to "GSO Thrive Program"

  See docs/changelog/pwa.md for regeneration + SW versioning notes.
  ```

### Phase 3: Stage and commit the 2026-05-19 feature batch
- [x] `git add firestore.rules public/app.js` (both diffs are entirely feature work, no PWA bleed).
- [x] `git add public/index.html public/styles.css` — the remainder of the diff after Phase 2's partial adds. Confirm with `git diff --cached` that this hunk contains the staffRequest "Ask staff for help" section, the "Lost job" option, the three doc-type options, the two exit-housing radios, the `.lbl` wrappers, and the `label:has(:required) > .lbl::after` CSS rule.
- [x] Commit (`0439617`). Message:
  ```
  Add staffRequest flow, lost-job status, new doc types, exit housing,
  and visual required-field indicators

  Smoke-tested 2026-05-19 (see docs/changelog/changelog.txt and
  docs/changelog/required-field-indicators.md).

  - Clients can submit "Ask staff for help" requests (10 subjects);
    staff approve in Inbox like any other submission. Nothing is
    mirrored to the canonical client record — the request itself is
    the artifact.
  - Status updates: added "Lost job" → milestones.lostEmployment
  - Document uploads: added VA Card, DD-214, Program Certifications
  - Exit Housing: added "Drug rehabilitation" and "Mental health inpatient"
  - Required-field indicators: gold asterisk after labels for any
    field with the `required` attribute, via `.lbl` span + :has() CSS
  ```

### Phase 4: Push + deploy + verify on phone
- [x] `git push origin main`.
- [x] From `client_database/`: `firebase deploy --only hosting,firestore:rules`. Hosting URL https://admin-automation-74110.web.app , released 2026-05-19.
- [x] Server-side verification via curl: `sw.js` returns 200 with `Cache-Control: no-cache, no-store, must-revalidate` and `Service-Worker-Allowed: /`; `manifest.webmanifest` parses and lists three icons; `icons/icon-192.png` returns 200 with `Cache-Control: public, max-age=2592000, immutable`.
- [ ] **Daniel TODO:** on a real phone, visit `https://admin-automation-74110.web.app/` — confirm browser offers "Add to Home Screen" / "Install app", install it, launch from the home screen, and check the icon + window chrome look right (no URL bar; status bar dark). Then toggle airplane mode and reload to confirm `offline.html` renders.
- [x] In todo.txt, remove the PWA line and add a 2026-05-19 changelog entry: "Add installable PWA + 2026-05-19 client app feature batch (see client_database/docs/changelog/pwa.md and required-field-indicators.md)".

## Risks / open questions
- **Should required-field indicators be a third commit?** They have their own changelog file (`docs/changelog/required-field-indicators.md`), which suggests they were treated as a distinct feature. Splitting them out is doable but tedious — the `.lbl` wrappers are scattered across ~15 hunks of `index.html` interleaved with the feature work. Default in this plan is to bundle, but ask Daniel before Phase 3.
- **Service-worker scope and HTTPS gating** — the registration script only runs on `https:`, so `localhost` testing won't exercise the SW. That's intentional (avoids stale-cache foot-guns during dev), but worth flagging if Daniel wants to test offline behavior locally — workaround is `firebase serve` (not supported) or a quick `python -m http.server` on a self-signed cert (overkill).
- **Maskable icon safe zone** — the maskable-512 icon uses a 0.62 logo scale (vs 0.80 on the regular icons) so the OS mask doesn't crop the wordmark. If the icons ever look cropped on Android, re-tune `LogoScale` in `scripts/generate-pwa-icons.ps1` and re-run.
- **App-name appearance** — the manifest `name` is "GSO Thrive Program" and `short_name` is "GSO Thrive". iOS uses `short_name` for the home-screen label, Android uses `name`. If the label looks wrong on either platform, edit the manifest and bump `SW_VERSION` in `sw.js` to force a refresh.

## Verification
- `git status` in `client_database/` shows a clean working tree (or only files unrelated to this plan).
- `git log --oneline -5` shows two new commits: PWA scaffolding, then 2026-05-19 features.
- `curl -I https://admin-automation-74110.web.app/sw.js` returns `200` with `Cache-Control: no-cache, no-store, must-revalidate` and `Service-Worker-Allowed: /`.
- `curl -s https://admin-automation-74110.web.app/manifest.webmanifest | python -m json.tool` parses as JSON and lists three icons.
- On a phone (real, not desktop emulation): visit the site, install to home screen, launch — standalone window, GSO sunrise icon, no URL bar. Toggle airplane mode, relaunch — offline.html renders instead of the network error.

## Outcome

Shipped 2026-05-19 to `admin-automation-74110.web.app` as two commits on `Daniel-Thrive-Gso/client_database` `main`:

- **`94679f0`** — *Add installable-PWA scaffolding (manifest, service worker, icons)* — 14 files, +470/−5 lines. New files: `public/sw.js`, `public/manifest.webmanifest`, `public/offline.html`, `public/icons/{icon-192,icon-512,icon-maskable-512,apple-touch-icon,favicon-32}.png`, `scripts/generate-pwa-icons.ps1`, `docs/changelog/pwa.md`. Modified: `firebase.json` (Cache-Control headers), `public/config.js` (pageTitle rebrand), `public/index.html` (manifest link, apple-touch tags, SW registration script — only those hunks), `public/styles.css` (mobile/safe-area polish — bottom block only).
- **`0439617`** — *Add staffRequest flow, lost-job status, new doc types, exit housing, and visual required-field indicators* — 4 files, +279/−29 lines. The 2026-05-19 feature batch you smoke-tested today, bundled together because they were tested as one release. Includes the required-field-indicator `.lbl` wrappers + `:has(:required)` CSS rule (which had its own changelog at `docs/changelog/required-field-indicators.md`).

Both commits pushed to `origin/main`. `firebase deploy --only hosting,firestore:rules` succeeded — firestore rules released, 16 files uploaded to hosting. Server-side verification passed: sw.js / manifest / icon URLs all return correct headers and content.

The reason this took planning rather than a one-liner: the working tree had three things tangled together (PWA + feature batch + required-field indicators), so the bulk of the work was partial-staging `public/index.html` (21 hunks — kept 2, skipped 19) and `public/styles.css` (2 hunks — skipped 1, kept 1) to land PWA in its own commit.

**Daniel TODO before this is fully verified:** on a real phone, visit `https://admin-automation-74110.web.app/`. The browser should offer "Add to Home Screen" / "Install app" — install it, launch from the home screen, confirm the GSO sunrise icon and standalone window (no URL bar). Then toggle airplane mode and reload to confirm the dark `offline.html` page renders. If anything looks wrong (icon cropped, wrong app name on home screen, offline page doesn't show), tweak `LogoScale` in `scripts/generate-pwa-icons.ps1` or `name`/`short_name` in `public/manifest.webmanifest`, bump `SW_VERSION` in `public/sw.js`, redeploy.
