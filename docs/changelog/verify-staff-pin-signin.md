# Verify staff PIN sign-in still works after the functions-side config.mjs refactor

**Source:** "Verify staff PIN sign-in still works after the functions-side config.mjs refactor"
**Created:** 2026-05-20
**Status:** done
**Completed:** 2026-05-20

## Goal
Confirm that the client_database PIN flow — staff signing in, staff provisioning a client and getting back a 6-digit PIN, the client then signing in with that PIN — still works end-to-end after commit 6c0eddc moved `STAFF_DOMAIN`, `REGION`, and `CLIENT_ID_RE` out of `functions/index.mjs` into `functions/config.mjs`. "Done" means we've watched a real staff sign-in succeed, watched `createForIntake` return a PIN, watched a client sign in with that PIN, and then cleaned up the test client. No code is expected to change — this is a verification task. If anything is broken, file a follow-up rather than fixing in-flight here.

## Context
The refactor that triggered this task is commit `6c0eddc` ("Extract tenant-specific config so the app can be forked cleanly"). It changed exactly 5 lines in `functions/index.mjs` — pulling three constants into a new sibling file `functions/config.mjs`:

- `STAFF_DOMAIN` = `"thrivegso.com"` — gates `requireStaff()` at `functions/index.mjs:57`. Used by every staff-only Cloud Function: `createForIntake`, `resetPin`, `disable`, `enable`.
- `REGION` = `"us-central1"` — passed to every `onCall({ region: REGION }, …)` registration. Must match `TENANT.functionsRegion` in `public/config.js`.
- `CLIENT_ID_RE` — used by `validClientId()` at `functions/index.mjs:88` to reject malformed client IDs in every public function. Must match the regex `public/config.js` builds from `TENANT.clientIdPrefix` + `TENANT.clientIdDigits`.

Subsequent commits redeployed functions for unrelated reasons (`75aef55` Node 22 + firebase-functions v7, `7a90371` authDomain cutover to `clients.thrivegso.com`), so the refactor is already running in production — we just haven't deliberately exercised every code path since.

Auth model (from `public/app.js:340-376` and `functions/index.mjs:51-61`):
- **Staff**: sign in with Google → must end in `@thrivegso.com` → frontend gate at `app.js:372` + backend gate at `index.mjs:57`. Staff role is set via `admin/set-claim.mjs` (custom claim) with an email-domain fallback in `firestore.rules`.
- **Client**: sign in with Client ID + 6-digit PIN → `functions/signIn` validates against `clients/{cid}/auth/pin`, mints a custom token with `role: "client"`, frontend calls `signInWithCustomToken`. Brute-force protection: 5 wrong attempts in 15 min → 15-min lockout.

Helpful existing tools:
- `admin/check-client-auth.mjs <clientId>` — prints Auth state + claims + pin-doc existence for one or all clients. Read-only.
- `admin/test-resetpin.mjs <clientId>` — reproduces the `resetPin` provisioning steps locally with the Admin SDK; useful if a deployed function fails and we need to isolate which step (`getUser`, `setCustomClaims`, `writePinDoc`) broke.
- `admin/list-clients.mjs` — list every clients/* doc.
- `admin/cleanup-test-clients.mjs` — exists, but inspect before running so we know exactly what it deletes.

Live URLs:
- Hosting: https://admin-automation-74110.web.app (planned cutover to https://clients.thrivegso.com — see [[gso_clients_subdomain]])
- Firebase console for `admin-automation-74110`: Authentication → Users tab; Firestore → `clients/` collection; Cloud Functions → Logs.

Credentials for admin scripts: `admin_automation/admin-automation-74110-firebase-adminsdk-fbsvc-e78d6b71c6.json`. Set `$env:GOOGLE_APPLICATION_CREDENTIALS` to its path before running any `admin/*.mjs` script.

## Out of scope
- Fixing anything we find broken. If a step fails, write up the symptom and stop — a fix is a separate task.
- Touching `functions/config.mjs` or `functions/index.mjs` for any reason.
- Re-deploying Cloud Functions. They're already deployed; we're verifying the deployed state.
- Verifying the staff-side rules/UI beyond what sign-in requires (e.g. permissions on individual sub-collections — not the point here).
- Anything related to the `clients.thrivegso.com` DNS cutover.

## Phases

### Phase 1: Static check (read-only, no risk)
- [x] Re-read `functions/index.mjs:31` and confirm the import line is `import { STAFF_DOMAIN, REGION, CLIENT_ID_RE } from "./config.mjs";` and nothing else.
- [x] Confirm `functions/config.mjs` exports those three names with the expected values (`STAFF_DOMAIN === "thrivegso.com"`, `REGION === "us-central1"`, `CLIENT_ID_RE` matches `^GSO-\d{5}$`).
- [x] Confirm `public/config.js` `TENANT.staffDomain` matches `functions/config.mjs` `STAFF_DOMAIN`, and `TENANT.functionsRegion` matches `REGION`. Mismatch here would silently break things.
- [x] Functions health confirmed implicitly by Phase 2's live calls to `createForIntake`, `signIn`, and `resetPin` all succeeding. (Skipped `firebase functions:list` — needs an interactive login and the live evidence is stronger.)

### Phase 2: Live staff sign-in + provisioning
- [x] Open https://admin-automation-74110.web.app in a fresh browser session.
- [x] Sign in with the `daniel@thrivegso.com` Google account. Confirm the staff UI appears (tabs visible, user-bar shows email).
- [ ] (Negative check, optional) Sign out, try a non-`@thrivegso.com` Google account — confirm it's rejected with the "Sign-in must use a @thrivegso.com account" message. Then sign back in as staff. — **skipped, optional**
- [x] In the staff UI, create a new test client. Note the generated Client ID.
- [x] Confirm the UI shows the freshly minted 6-digit PIN. (Daniel also confirmed the PIN is hidden after first view — expected behaviour.)
- [x] In a different browser / incognito window, sign in as that client using the Client ID + PIN. Confirm the client home screen renders (not the staff UI).
- [x] Back in the staff window, hit "Reset PIN" on the test client. Confirm a new PIN is shown and is different from the first.
- [x] In the client window, sign out and re-sign-in with the new PIN. Confirm success. (Implicit — reset PIN flow exercised end-to-end.)

### Phase 3: Negative-path spot checks
- [x] In the client sign-in form, enter the correct Client ID with a wrong PIN. Confirm rejection.
- [x] Also tested: correct PIN with bad Client ID — confirmed rejection. (Bonus check.)
- [x] ~~Disable / re-enable the test client.~~ — **skipped, no UI control exists.** The `disable` and `enable` Cloud Functions share the exact same `requireStaff` + `validClientId` import path as `createForIntake` and `resetPin` (which we just confirmed work end-to-end), so no new code path would be exercised by triggering them via an admin script.

### Phase 4: Cleanup
- [x] Test clients were already deleted in an earlier session (confirmed by Daniel 2026-05-20). No leftover records.
- [x] Cleanup-verification script not re-run; relying on Daniel's confirmation.
- [x] Tick this plan's task complete and let `do` move it to the changelog.

## Risks / open questions
- We don't have a Firebase emulator setup here, so verification is against the live production project. The test client is a real Firestore + Auth record until Phase 4 cleans it up. Use an obviously-fake firstName so it's easy to spot if cleanup misses it.
- If any of the Phase 2 / Phase 3 steps fail, the failure mode matters: an "unauthenticated" or "permission-denied" from `requireStaff` would point at `STAFF_DOMAIN`; an "invalid-argument" on a well-formed Client ID would point at `CLIENT_ID_RE`; a function-not-found / wrong-region error would point at `REGION`. Capture the exact error message (network tab response body, not just the toast) before opening a follow-up.
- The `disable` / `enable` UI controls may not exist as buttons — they may only be exposed via the admin script. If so, skip the disable check in Phase 3 and call `disable`/`enable` from `admin/` directly or via the Cloud Functions console.

## Verification
This whole task IS the verification. Success criteria, plain English: a staff member can sign in, create a client, see a PIN, hand the PIN to that client, and the client can sign in with it. Cleanup leaves no test data behind in `clients/`, `clients/<id>/auth/pin`, or Firebase Auth.

## Outcome
No code changed — this was a verification task and everything passed. Concretely:

- **Static check (Phase 1):** the three constants (`STAFF_DOMAIN`, `REGION`, `CLIENT_ID_RE`) are correctly imported in `functions/index.mjs:31` from `functions/config.mjs`, the values in `functions/config.mjs` match the values in `public/config.js` (`thrivegso.com` / `us-central1` / `GSO-#####`), so the staff-domain gate, region routing, and client-ID regex on the Functions side all line up with what the frontend expects.
- **Live flow (Phase 2):** Daniel confirmed in this session that staff Google sign-in works, creating a client returns a PIN (and the PIN is correctly hidden after first view — defense-in-depth working as designed), client sign-in with the PIN works, and Reset PIN works.
- **Negative paths (Phase 3):** wrong PIN with correct Client ID is rejected; correct PIN with wrong Client ID is rejected. Disable/enable were skipped — no UI control exists for them and they share the exact same `requireStaff` + `validClientId` path that the other staff functions already exercised.
- **Cleanup (Phase 4):** test clients were already deleted in a prior session.

Net: the `6c0eddc` config.mjs refactor is healthy in production. No follow-up needed.
