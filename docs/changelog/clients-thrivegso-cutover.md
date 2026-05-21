# Cut over the client_database app to clients.thrivegso.com

**Source:** "Cut over admin-automation-74110.web.app to clients.thrivegso.com (Firebase custom domain + Cloudflare DNS, grey cloud A records)"
**Created:** 2026-05-19
**Status:** done
**Completed:** 2026-05-20

## Goal
Move the staff + client app from its Firebase default URL `https://admin-automation-74110.web.app` to a real branded URL: `https://clients.thrivegso.com`. The old `.web.app` URL keeps working (Firebase always keeps it live) as a fallback. After this lands, staff and clients both bookmark the new URL; the printed posters / staff-training pages should be updated to match. DNS is hosted on Cloudflare; the new hostname has to point at Firebase Hosting "grey cloud" (DNS-only) so Firebase can issue and renew the TLS certificate end-to-end.

## Context

**The app today.** `client_database/` is a Firebase Hosting site (project `admin-automation-74110`) serving `client_database/public/` as static files plus Cloud Functions in `functions/`. Live URL: `https://admin-automation-74110.web.app`. Hosting config: `client_database/firebase.json`. The Firebase config the browser actually uses lives in `client_database/public/config.js` — `authDomain: "admin-automation-74110.web.app"` is the line that controls where Firebase's sign-in redirect handler lives.

**Why authDomain matters.** From `admin_automation/BUILD_LOG.md` §13 (issues 2 + 3): modern Chrome / Edge block third-party cookies. If `authDomain` is on a different origin than where the app is served, Firebase's `getRedirectResult()` can't carry the session across origins and Google sign-in loops back to the sign-in screen. The fix on 2026-05-08 was setting `authDomain` to the same origin as the served app (`.web.app`). When we cut over to `clients.thrivegso.com`, we need to do the same dance again — point `authDomain` at the new origin and register `https://clients.thrivegso.com/__/auth/handler` on the right OAuth client.

**Which OAuth client.** The project has TWO web OAuth 2.0 clients in GCP Console → APIs & Services → Credentials. The one Firebase actually uses for browser sign-in has Client ID prefix `721603594101-ubl0c0nq0o61diurf43bkuri1nkmf95c`. Adding the new redirect URI to the OTHER one produces `redirect_uri_mismatch`. The current `.web.app/__/auth/handler` URI is already registered on the correct client — we just add `clients.thrivegso.com/__/auth/handler` alongside it.

**Cloudflare DNS.** `thrivegso.com` lives in Cloudflare. The marketing site `thrivegso.com` is on a Cloudflare Worker (orange cloud). Firebase Hosting can't sit behind Cloudflare's proxy — Firebase needs to terminate TLS itself for cert issuance and renewal — so the `clients` subdomain must be **grey cloud (DNS only)**. Firebase will issue two A records (typically `199.36.158.100` and `199.36.158.101`, but use whatever the Firebase console shows at the time) plus a one-time TXT verification record.

**Files that reference `.web.app` and need touching:**
- `client_database/public/config.js:24` — `authDomain` (the one functional change).
- `client_database/public/app.js:28-32` — explanatory comment about the OAuth handler URI. Worth updating so future-you / future-Claude has accurate context.
- `admin_automation/go_live_checklist.md:61` — "Live app: https://admin-automation-74110.web.app". Update to the new URL.
- `admin_automation/client_database_plan.md:234,526-529` — references the cutover as still-open. Mark as done with the date.

**Files that should NOT change:** the `admin/` scripts (they reference the *project ID* `admin-automation-74110`, which is permanent and unrelated to the hosting URL). Firestore rules / storage rules / functions / Firestore data — all unchanged.

## Out of scope
- Migrating the marketing site `thrivegso.com` — already handled, no change.
- Changing the Firebase **project ID** (`admin-automation-74110`). The project ID is permanent and only appears in the URL via the default `.web.app` host; the custom domain doesn't touch it.
- Renaming the Firestore project, OAuth client, or storage bucket.
- Moving to a different subdomain (`staff.` / `app.`) — see open question below.

## Phases

### Phase 1: Add custom domain in Firebase

Subdomain is **`clients.thrivegso.com`** for both staff and clients — decided 2026-05-19. Not `staff.` (excludes clients) or `app.` (too generic). Staff just have to learn that the URL says "clients" even though they use it too.

- [x] In Firebase Console → Hosting → **Add custom domain**, enter `clients.thrivegso.com`. Choose "Quick setup" so Firebase issues two A records.
- [x] Firebase will show:
  - A one-time **TXT verification record** (host: `clients` or similar, value: `google-site-verification=...`).
  - Two **A records** (host: `clients`, two IPv4 addresses).
- [x] Copy those four values somewhere Daniel can paste them into Cloudflare. (Screenshots into `admin_automation/` or just keep them in the chat.)

*All of Phase 1 already complete when this task was picked up — `clients.thrivegso.com` is "Connected" in Firebase Hosting and serving the app.*

### Phase 2: Add Cloudflare DNS records (grey cloud)

- [x] In Cloudflare → `thrivegso.com` → DNS → Records:
  - Add the **TXT** verification record exactly as Firebase showed it. Proxy: **DNS only (grey cloud)**.
  - Add the **two A records** for `clients` pointing at the IPs Firebase gave. Proxy: **DNS only (grey cloud)**. TTL: Auto.
- [x] Back in Firebase Console, click **Verify**. The TXT check is usually within a minute. The A-record verification + SSL cert issuance can take 15 min – 24 h. Re-check Firebase Console status; do not start Phase 3 until Firebase shows the domain as "Connected" with a valid certificate.

*Confirmed 2026-05-20: WebFetch of https://clients.thrivegso.com returns the GSO Thrive Program sign-in page (HTTPS, Firebase-served). DNS + cert all in place.*

### Phase 3: Add the new domain to Firebase Auth + OAuth client

- [x] Firebase Console → Authentication → Settings → **Authorized domains** → Add `clients.thrivegso.com`. (Leave the existing `admin-automation-74110.web.app` and `admin-automation-74110.firebaseapp.com` entries in place.) *Done 2026-05-20.*
- [x] GCP Console → APIs & Services → Credentials → open the OAuth 2.0 Client ID starting with `721603594101-ubl0c0nq0o61diurf43bkuri1nkmf95c` (this is the one Firebase actually uses — confirmed in `admin_automation/BUILD_LOG.md` §2). Under **Authorized redirect URIs**, add:
  - `https://clients.thrivegso.com/__/auth/handler`
  - (Leave the existing `https://admin-automation-74110.web.app/__/auth/handler` in place as a fallback.)
- [x] Save. Wait 1–2 minutes for OAuth changes to propagate. *Done 2026-05-20 — confirmed URI 3 saved alongside firebaseapp.com and web.app entries.*

### Phase 4: Update app code + deploy

- [x] Edit `client_database/public/config.js:24`: change `authDomain: "admin-automation-74110.web.app"` to `authDomain: "clients.thrivegso.com"`.
- [x] Edit `client_database/public/app.js:28-32`: rewrite the comment to reference `clients.thrivegso.com/__/auth/handler` and note the cutover date (2026-05-20). Preserve the explanation of *why* same-origin authDomain matters — it's load-bearing context.
- [x] From `client_database/`: `firebase deploy --only hosting`. (Functions, rules, indexes unchanged — no need to redeploy them.) *Deployed 2026-05-20 via service-account auth (16 files uploaded). The CLI's user OAuth was stale again — same workaround as BUILD_LOG §2: `firebase logout` + `GOOGLE_APPLICATION_CREDENTIALS` pointed at the SA key.*
- [x] Confirm the deploy succeeded in the CLI output. Note the deployed version hash. *Release complete; new `authDomain: "clients.thrivegso.com"` confirmed live via WebFetch of /config.js.*

### Phase 5: Smoke test on the new URL

- [x] Open `https://clients.thrivegso.com` in a clean browser window (incognito recommended — avoids cached service worker). Confirm the TLS cert is valid and issued by Google Trust Services.
- [x] **Staff sign-in.** Click sign-in, complete the Google flow with `daniel@thrivegso.com`. Confirm you land in the staff app (not bounced back to the sign-in screen). If it bounces, Phase 3 OAuth handler URI didn't propagate yet — wait 5 min and retry.
- [x] **Client sign-in.** On a phone, open `https://clients.thrivegso.com`, switch to Client sign-in, enter a real client's `GSO-NNNNN` + PIN. Confirm successful sign-in and that the client's home screen loads.
- [x] **Firestore read sanity check.** While signed in as staff, open the Clients tab and confirm the list renders. Open a client detail page; confirm the masked SSN reveals and re-masks. (This proves the custom claims still resolve over the new origin.)
- [x] **Audit log sanity check.** Open the Audit log Admin tab. Confirm a fresh entry appeared for your sign-in.
- [x] Leave the old `https://admin-automation-74110.web.app` URL working as a safety net — do **not** disable it. (Firebase doesn't offer a clean way to disable the default URL anyway.) *Confirmed still functional 2026-05-20.*

*All smoke tests passed 2026-05-20.*

### Phase 6: Update documentation references

- [x] `admin_automation/go_live_checklist.md:61` — change the "Live app:" URL.
- [x] `admin_automation/client_database_plan.md` — update lines ~234 and ~526-529 to mark the cutover as done with the date; the open-question entry can move to "decided".
- [x] Add a short BUILD_LOG entry under a new "Custom domain cutover (2026-05-XX)" header summarizing: which Cloudflare records, OAuth client URI added, authDomain change, smoke-test results. *Added as §13.26.*
- [ ] Brief the 5 staff: new URL is `https://clients.thrivegso.com`; old URL still works. *Daniel — outside this skill's scope.*
- [x] Commit + push the code + docs changes. *Commit `7a90371` on `Daniel-Thrive-Gso/client_database` main. `admin_automation/` doc updates stay local (not a git repo by design).*

## Risks / open questions

- **DNS / cert wait.** Firebase's cert issuance can take up to 24 h. If staff need the new URL by a specific deadline, start Phase 1–2 a day before. There's no way to short-circuit this.
- **Sign-in breakage window.** Phase 4's code change will only break sign-in if Phase 3 hasn't propagated. Mitigation: do Phase 3 first, wait, then do Phase 4. If sign-in does break, the fix is one line: revert `authDomain` to `admin-automation-74110.web.app` in `config.js` and redeploy — that's the proven-working configuration.
- **Cloudflare proxy mistake.** If anyone re-enables orange-cloud on the `clients` A records later, Firebase will fail to renew the cert and the site goes down silently after the next renewal cycle (~60 days). Worth noting in BUILD_LOG so the next person setting up DNS knows.
- **Service worker caching.** `client_database/public/sw.js` exists. After cutover, the first visit from each device may serve a stale shell from the cache. Hard-refresh + clear site data fixes it; not worth automating.

## Verification

- `https://clients.thrivegso.com` loads with a valid TLS cert (Google Trust Services issuer).
- Staff sign-in via Google works end-to-end on the new origin (Daniel personally tests with his `@thrivegso.com` account).
- A real client signs in via PIN on the new origin and sees their own dashboard.
- The Audit log Admin tab shows the staff sign-in event under the staff member's email.
- `https://admin-automation-74110.web.app` continues to work as a fallback (open in a separate tab; confirm sign-in still succeeds there too).
- `grep "admin-automation-74110.web.app" client_database/public/` returns nothing in user-facing files (the project-ID `admin-automation-74110` without `.web.app` is fine — it's the permanent project identifier).

---

## Outcome (2026-05-20)

The staff + client app is now live at **https://clients.thrivegso.com**. Both staff (Google sign-in) and clients (PIN sign-in) verified working on the new origin. The old `https://admin-automation-74110.web.app` URL is intentionally left in place as a fallback.

**What shipped:**
- `client_database/public/config.js` — `authDomain` flipped to `clients.thrivegso.com`.
- `client_database/public/app.js` — explanatory comment above `firebaseConfig` refreshed with the new URI + cutover date.
- Committed as `7a90371` on `Daniel-Thrive-Gso/client_database` main, pushed to GitHub, deployed via `firebase deploy --only hosting` (service-account auth route — CLI's user OAuth was stale again, same BUILD_LOG §2 workaround).
- GCP OAuth client `721603594101-ubl0c0n…` got `https://clients.thrivegso.com/__/auth/handler` added (alongside the existing `.web.app` handler).
- Firebase Auth → Authorized domains got `clients.thrivegso.com` added.
- BUILD_LOG §13.26, `client_database_plan.md` §5e + §10, `go_live_checklist.md` "Live app:" line all updated.

**Pleasant surprise:** Firebase Hosting + Cloudflare DNS for `clients.thrivegso.com` were already set up before the session started, so Phases 1–2 were a no-op verify rather than fresh work.

**Open follow-up for Daniel (not blocking):** brief the 5 staff that the new bookmark is `https://clients.thrivegso.com`. The old URL still works so there's no urgency.
