# Artifact Registry cleanup policy for Cloud Functions

**Set:** 2026-05-19

## What this is

A cleanup policy on the `gcf-artifacts` Artifact Registry repository in `us-central1` for the `admin-automation-74110` Firebase project. The policy auto-deletes function container images older than **1 day**. The currently-running deployed image for each function is never deleted by this policy — only superseded/older versions.

## Why

Every `firebase deploy --only functions` builds and stores one container image per function. Without a cleanup policy these accumulate forever, billed as storage per GB-month. With 6 deployed functions × weekly deploys, that's ~6 unreferenced images added per deploy with no expiration.

## How it was set

```
firebase functions:artifacts:setpolicy \
  --project admin-automation-74110 \
  --location us-central1 \
  --days 1 \
  --force
```

The CLI is idempotent — re-running with different `--days` updates the policy in place. Use `--none` to opt out and stop the CLI from prompting about it during future deploys.

## How to change retention

Re-run setpolicy with a different `--days` value. Bumping to 7 or 30 days would let you inspect an old image binary before it's purged, at the cost of more stored gigabytes. Default of 1 day is fine because rollbacks happen via `firebase deploy` from git — no need to pull a stored image off the shelf.

## Caveats

- This policy applies to **one region only** (`us-central1`). If functions ever get deployed to another region, that region's `gcf-artifacts` repo needs its own setpolicy call.
- The cleanup sweep runs roughly once a day (Google-managed). After the first sweep, the image count in the Console should drop to roughly (number of deployed functions) — one active image each.
- Verified in Cloud Console: https://console.cloud.google.com/artifacts/docker/admin-automation-74110/us-central1/gcf-artifacts?project=admin-automation-74110
