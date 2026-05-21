# Run `firebase functions:artifacts:setpolicy` to stop container images accumulating

**Source:** "Run `firebase functions:artifacts:setpolicy` to stop container images accumulating"
**Created:** 2026-05-19
**Completed:** 2026-05-19
**Status:** done

## Goal
Stop paying for old Cloud Functions container images that pile up in Artifact Registry on every deploy. After this task, the `admin-automation-74110` Firebase project has a cleanup policy that auto-deletes function images older than N days, so future deploys don't leave a growing pile of unreferenced images behind. The currently-running deployed images are preserved — only superseded ones get cleaned up.

## Context

Each time you run `firebase deploy --only functions`, Firebase builds one container image per function and pushes it to a per-project Artifact Registry repository. There are currently **6 v2 callable functions** deployed (`createForIntake`, `disable`, `enable`, `resetPin`, `signIn`, and one more) — all on `us-central1`, all still on `nodejs20`. Without a cleanup policy, every deploy leaves the previous image behind in the registry, billed as storage per GB-month. Three weeks of weekly deploys = 18 stale images per function = 108 total accumulated. It's small money, but it grows linearly forever.

Firebase added a first-class CLI for this in v13.x: `firebase functions:artifacts:setpolicy`. It creates a Cloud Run/Artifact Registry **cleanup policy** scoped to the functions repository, with one retention period configurable in days. The active image (the one a deployed function is actually serving from) is never deleted; only older, superseded ones are.

**CLI version:** firebase 15.18.0 is installed locally and has the command. Help:
```
firebase functions:artifacts:setpolicy
  --location <location>  default: us-central1
  --days <days>          default: 1
  --none                 opt-out
  -f, --force            non-interactive
```

**Memory of past IAM gotchas on this project** (`firebase_functions_first_deploy_iam.md`): first-time use of any function-related Firebase CLI command on `admin-automation-74110` has historically failed because Artifact Registry / Cloud Resource Manager / Cloud Build APIs weren't enabled, or the deploying SA lacked roles. By now those APIs and roles are in place (we've successfully deployed functions multiple times), so setpolicy should "just work" — but be ready to enable an extra API or grant an extra role if the CLI complains. Specifically Artifact Registry's `artifactregistry.repositories.setIamPolicy` permission is what setpolicy actually needs.

**Why default `--days 1` is the right pick:** rollback isn't done by re-deploying a stored image (it's done by re-deploying source from git), so old images have no operational value. 1 day is plenty of buffer to catch a bad deploy + redeploy cycle. Going longer just pays for storage we'll never read.

## Out of scope
- The Node 22 / firebase-functions upgrade (separate todo lines — pair those together; setpolicy is independent and can ship first).
- Setting policies on Hosting artifacts or Storage buckets — only Cloud Functions container images are accumulating in a way that matters.
- Manually deleting the already-accumulated images. The new policy will purge them on its first sweep (typically within ~24h of policy creation).
- Setting up retention for multiple regions — only `us-central1` is in use.

## Phases

### Phase 1: Set the policy and verify
- [x] From `client_database/`, ran `firebase functions:artifacts:setpolicy --project admin-automation-74110 --location us-central1 --days 1 --force`. CLI returned: *"Successfully set up cleanup policy that deletes images older than 1 days. Cleanup policy has been set for projects/admin-automation-74110/locations/us-central1/repositories/gcf-artifacts"*. No IAM/API errors — APIs and roles from prior deploys were already in place.
- [x] No IAM fix needed (would have run `gcloud services enable artifactregistry.googleapis.com ...` if it had errored). `gcloud` isn't installed locally anyway, so an IAM error would have required a Console fix.
- [ ] **Daniel TODO:** eyeball the Cloud Console to confirm: https://console.cloud.google.com/artifacts/docker/admin-automation-74110/us-central1/gcf-artifacts?project=admin-automation-74110 — should show "Cleanup policies: 1" or similar, deleting tagged/untagged images older than 1 day.
- [ ] **Daniel TODO (optional):** note the current accumulated image count in the Console. Tomorrow it should drop to ~6 (one per active function).

### Phase 2: Confirm cleanup actually ran (next day)
- [ ] **Daniel TODO (~24h from now, 2026-05-20):** re-check https://console.cloud.google.com/artifacts/docker/admin-automation-74110/us-central1/gcf-artifacts — image count should be down to ~6 (one per active function). If it didn't drop, check Cloud Logging for Artifact Registry cleanup failures.
- [x] Wrote `client_database/docs/changelog/artifact-cleanup-policy.md` (the policy, the why, how to change retention, the one-region caveat), committed as `d270ca2`, pushed to `origin/main`.

## Risks / open questions
- **Retention days** — default `--days 1` (this plan). If Daniel ever wants to be able to inspect a previous image manually (e.g. diff a binary), bump this to 7 and re-run setpolicy. The CLI is idempotent.
- **IAM** — if setpolicy returns a permissions error, the deploying account needs `roles/artifactregistry.admin` (or finer-grained `artifactregistry.repositories.setIamPolicy`). Fix path: Console → IAM → add role to the SA listed in the error.
- **Functions repo location quirk** — Firebase puts function images in a repo named `gcf-artifacts` in the function's region. If there are ever functions in regions other than `us-central1`, each region needs its own setpolicy call.

## Verification
- The Cloud Console Artifact Registry page for `admin-automation-74110` / `us-central1` / `gcf-artifacts` lists at least one cleanup policy with a 1-day retention.
- A day later, the image count in that repo is ≤ (number of deployed functions + 1) — i.e. accumulated old images are gone, only live ones remain.
- Future `firebase deploy --only functions` runs still succeed — the policy doesn't break deploys (it shouldn't; the CLI is designed not to).

## Outcome

Ran `firebase functions:artifacts:setpolicy --project admin-automation-74110 --location us-central1 --days 1 --force` from `client_database/`. CLI confirmed: *"Successfully set up cleanup policy that deletes images older than 1 days. Cleanup policy has been set for projects/admin-automation-74110/locations/us-central1/repositories/gcf-artifacts."* No IAM or API errors (APIs and roles from prior function deploys were already in place).

Documented the policy in a new file `client_database/docs/changelog/artifact-cleanup-policy.md` — what it is, why, how to change retention, and the one-region caveat. Committed as `d270ca2` on `Daniel-Thrive-Gso/client_database` `main` and pushed.

**Daniel TODO (eyeball confirmations):**
1. Open https://console.cloud.google.com/artifacts/docker/admin-automation-74110/us-central1/gcf-artifacts?project=admin-automation-74110 and confirm the repo shows a cleanup policy (1-day retention).
2. Tomorrow (2026-05-20), re-check the same page — the image count should be down to roughly 6 (one per active function: createForIntake, disable, enable, resetPin, signIn, + one more) instead of however many had accumulated.

If either step looks wrong, the fix paths are in `client_database/docs/changelog/artifact-cleanup-policy.md` and in this plan's "Risks / open questions" section.
