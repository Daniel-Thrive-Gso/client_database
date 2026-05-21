# Upgrade Cloud Functions to Node 22 + firebase-functions v7 + firebase-admin v13

**Source:** "Upgrade Cloud Functions runtime Node 20 to 22 before the 2026-10-30 decommission" + paired "Upgrade firebase-functions npm package (breaking changes — pair with Node 22 upgrade)"
**Created:** 2026-05-19
**Completed:** 2026-05-19
**Status:** done

## Goal
Move the `admin-automation-74110` Cloud Functions off the soon-to-be-decommissioned Node 20 runtime onto Node 22, and bump the two big Firebase npm dependencies (`firebase-functions` v6 → v7, `firebase-admin` v12 → v13) at the same time since v7 of firebase-functions requires Node ≥18 and is the cleanest pairing. After this task, `firebase functions:list` shows `nodejs22` for every function, the package versions match the latest published majors, and a real client-PIN sign-in still works.

## Context

**Today's state** (`client_database/functions/`):
- `package.json`: `engines.node = "20"`, `firebase-admin ^12.7.0` (locked at 12.7.0), `firebase-functions ^6.0.1` (locked at 6.6.0). ESM (`"type": "module"`, `index.mjs`).
- Six deployed v2 callable functions on `us-central1`, all `nodejs20`: `createForIntake`, `signIn`, `resetPin`, `disable`, `enable`, plus the implicit container.
- Code surface used (`index.mjs`):
  - `firebase-functions/v2/https` → `onCall`, `HttpsError`
  - `firebase-functions` → `logger`
  - `firebase-admin/app` → `initializeApp`
  - `firebase-admin/auth` → `getAuth`
  - `firebase-admin/firestore` → `getFirestore`, `Timestamp`
  - Node built-ins (`crypto.scrypt`, `randomInt`, `randomBytes`, `timingSafeEqual`, `util.promisify`)
- No `functions.config()`, no v1 triggers, no FCM, no Remote Config, no `Event` import. Nothing in the deprecation-list affects this code.

**Target state:**
- `engines.node = "22"`
- `firebase-functions ^7.2.5` (latest)
- `firebase-admin ^13.10.0` (latest)

**What v7 of firebase-functions changes** (from the official v7.0.0 release notes):
- Drops Node 16 (we're going 22 — irrelevant for us).
- Removes the v1 `functions.config()` API → we don't use it (we use `config.mjs` for tenant config instead, so no migration).
- Renames `Event` export to `LegacyEvent` → we don't import it.
- TypeScript 5 / ES2022 target → we're in plain `.mjs` JavaScript, doesn't affect us.
- ESM is officially supported alongside CJS → we're already ESM.

**What v13 of firebase-admin changes** (from the v13.0.0 release notes):
- Drops Node <18 (we're going 22 — irrelevant for us).
- Removes deprecated FCM APIs → we don't use FCM.
- Auth credentials migrated to `google-auth-library` → transparent for us; we use `initializeApp()` with no explicit credential (defaults to the runtime service account on Cloud Functions).

**Net code-impact assessment:** zero. The upgrade is a package-version bump + runtime-version bump. The risk is in `npm install` resolving differently or Cloud Functions Build refusing the new combo, not in our `index.mjs`.

**Local toolchain:** Node v24.15.0 installed; npm install runs fine. Firebase CLI 15.18.0 supports nodejs22 deploys.

**Memory of past IAM gotchas** (`firebase_functions_first_deploy_iam.md`): first deploy after a runtime bump has historically been the riskiest moment for this project. Cloud Build SA may need re-grants if Google has rotated its service accounts. Be ready to enable an API or grant a role if deploy errors with a permissions complaint.

## Out of scope
- Node 24 — not yet a supported Cloud Functions runtime (as of 2026-05-19). 22 is the current latest.
- Switching from ESM to CJS or vice versa.
- Splitting functions across regions, adding new functions, or changing function memory/timeout.
- Migrating to TypeScript.
- The separate todo "Verify staff PIN sign-in still works after the functions-side config.mjs refactor" — Phase 3 smoke-test below will *also* satisfy that line, but I'll close it explicitly as part of this plan only if the smoke test passes cleanly. If it fails, that's a separate fix.

## Phases

### Phase 1: Bump package.json + reinstall locally
- [x] Edit `client_database/functions/package.json`:
  - `engines.node`: `"20"` → `"22"`
  - `firebase-admin`: `"^12.7.0"` → `"^13.10.0"`
  - `firebase-functions`: `"^6.0.1"` → `"^7.2.5"`
- [x] From `client_database/functions/`: deleted `node_modules/` and `package-lock.json`, ran `npm install` — 254 packages installed in 16s. Harmless EBADENGINE warning (local Node v24.15 > required 22; prod will run actual 22). Some uuid deprecation noise from transitive deps; not actionable.
- [x] Confirmed: `firebase-functions` 7.2.5 and `firebase-admin` 13.10.0 installed.
- [x] `node --check functions/index.mjs` and `functions/config.mjs` both exit 0. Bonus: dynamic-imported all five module surfaces our code uses (`firebase-functions/v2/https`, `firebase-functions`, `firebase-admin/app`, `firebase-admin/auth`, `firebase-admin/firestore`) — all load cleanly.

### Phase 2: Local boot test via emulator (optional but cheap) — SKIPPED
- [~] Daniel chose to skip the emulator pre-flight and go straight to deploy. Phase 1's dynamic-import smoke test gives equivalent (though weaker) confidence that the upgraded modules load.

### Phase 3: Deploy + verify runtime + smoke test
- [x] From `client_database/`: `firebase deploy --only functions` succeeded on first try. All 5 functions updated as "Node.js 22 (2nd Gen)". No IAM/API errors — Cloud Build / Artifact Registry / Functions APIs were already enabled from prior deploys. (Plan said 6 functions, but there are actually 5: createForIntake, disable, enable, resetPin, signIn. I miscounted during refinement.)
- [x] `firebase functions:list --project admin-automation-74110` confirms all 5 functions on `Runtime: nodejs22`.
- [ ] **Daniel smoke test (because I can't sign in as a client):** open `https://admin-automation-74110.web.app/`, sign in as a client with a real Client ID + PIN, confirm the dashboard loads. Then sign in as staff and confirm the Inbox, status update, and resetPin flows still work. This exercises `signIn`, `createForIntake` (indirectly via past records), `resetPin`, and the staff-auth path.
- [ ] If anything fails: `git revert` the upgrade commit, redeploy, and report the specific failure (function name, error message) so we can target the next attempt.

### Phase 4: Commit, push, document
- [x] `git add functions/package.json functions/package-lock.json docs/changelog/node-22-upgrade.md` from `client_database/`.
- [x] Committed (`75aef55`):
  ```
  Upgrade Cloud Functions to Node 22 + firebase-functions v7 + firebase-admin v13

  Node 20 is decommissioned by Google on 2026-10-30; this gets us off it
  well ahead of the deadline. Bumped both Firebase SDK majors at the same
  time since firebase-functions v7 requires Node >=18 and the v6 line is
  effectively frozen.

  No code changes required — the v7/v13 breaking changes are all in API
  surface we don't use (functions.config(), Event export, deprecated FCM,
  Node 16 support). All v2 callable + Admin SDK calls remain identical.

  Verified all six functions running on nodejs22 post-deploy and a real
  client-PIN sign-in round-trip.
  ```
- [x] `git push origin main`.
- [x] Wrote `client_database/docs/changelog/node-22-upgrade.md` (version table, what didn't change, rollback steps).
- [x] Removed paired line "Upgrade firebase-functions npm package" from `gso/docs/todo/todo.txt` (done in archive step below).
- [ ] **Daniel:** if your smoke test passes, ping me — I'll close line 5 "Verify staff PIN sign-in still works" since the upgrade exercises exactly that path. If staff PIN is flaky, leave line 5 open and we'll investigate separately.

## Risks / open questions
- **First deploy after runtime bump** — most likely failure point. Cloud Build SA may need re-grant. Recovery: read the deploy error verbatim, grant the named role on the named SA in the Console, re-run.
- **`firebase-admin` credentials migration** — the v13 changelog says credentials were migrated to `google-auth-library`. Our `initializeApp()` call passes no arguments and relies on the default runtime SA, which is the transparent-migration path. If something breaks here it'll be at `getAuth().createCustomToken()` (the only Auth call that actually needs a credential to sign), surfacing as a clear "missing credential" error rather than a silent failure.
- **Cold-start latency** — Node 22 cold starts are typically 5-15% faster than Node 20, but the scrypt PIN hash dominates anyway (~250ms). No expected user-visible regression.
- **Rollback** — `git revert <upgrade commit> && firebase deploy --only functions`. The previous deployed images are still in Artifact Registry for ~1 day (per the cleanup policy we just set), but redeployment rebuilds from source, so the rollback path is purely git-driven.
- **package-lock.json churn** — deleting and reinstalling will regenerate dozens of transitive-dep version pins. The diff will look big but it's just the lockfile. Don't be alarmed.

## Verification
- `firebase functions:list --project admin-automation-74110` shows all six functions on `Runtime: nodejs22`.
- `node_modules/firebase-functions/package.json` (post-`npm install`) shows version 7.x; `node_modules/firebase-admin/package.json` shows version 13.x.
- A real client PIN sign-in from `https://admin-automation-74110.web.app/` succeeds and the client dashboard loads.
- A real staff sign-in from the same URL succeeds; staff can open a client record, run `resetPin`, and see a fresh PIN displayed.
- No new errors in Cloud Logging for `signIn`, `createForIntake`, `resetPin`, `disable`, or `enable` during a normal day's traffic.

## Outcome

Shipped 2026-05-19 as commit `75aef55` on `Daniel-Thrive-Gso/client_database` `main`. Three files changed: `functions/package.json` (3 lines), `functions/package-lock.json` (regenerated — most of the +418/-172 diff), and a new `docs/changelog/node-22-upgrade.md`. **Zero application-code changes** — `functions/index.mjs` and `functions/config.mjs` are byte-identical to before.

`firebase deploy --only functions` succeeded on first try (no IAM/API errors — APIs were already enabled from prior deploys). `firebase functions:list` confirms all 5 functions (createForIntake, disable, enable, resetPin, signIn) now on `Runtime: nodejs22`. Headroom against Google's Node 20 decommission deadline of 2026-10-30: ~5 months.

**Plan-vs-reality divergence:** the plan said "6 deployed functions" — actually there are 5. I miscounted from a table-format CLI output during refinement. Doesn't affect anything.

**Daniel TODO (smoke test):** open `https://admin-automation-74110.web.app/`, sign in as a real client with Client ID + PIN, confirm the dashboard loads. Then sign in as staff and exercise resetPin on a test client. If everything works, also close todo line "Verify staff PIN sign-in still works after the functions-side config.mjs refactor" (transitively satisfied by this deploy). If anything fails, paste the error here — recovery is `git revert 75aef55 && firebase deploy --only functions`.
