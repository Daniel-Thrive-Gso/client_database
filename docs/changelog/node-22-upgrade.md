# Cloud Functions: Node 22 + firebase-functions v7 + firebase-admin v13

**Shipped:** 2026-05-19
**Driving deadline:** Google decommissions the Node 20 runtime on 2026-10-30. We're upgrading ~5 months ahead so a forced upgrade doesn't catch us at a bad moment.

## Version bumps

| Package / runtime | Before | After |
|-------------------|--------|-------|
| Cloud Functions runtime | `nodejs20` | `nodejs22` |
| `firebase-admin` | `^12.7.0` (locked 12.7.0) | `^13.10.0` |
| `firebase-functions` | `^6.0.1` (locked 6.6.0) | `^7.2.5` |

`firebase-functions` v7 requires Node ≥18, which is why we paired the SDK bump with the runtime bump rather than doing them in two steps.

## Code changes

**None.** Both major-version SDK bumps removed/changed only API surface this project doesn't touch:

- `firebase-functions` v7: removed `functions.config()` (we use `config.mjs`), renamed `Event` to `LegacyEvent` (we don't import it), dropped Node 16 (we were on 20), TypeScript 5 / ES2022 (we're plain .mjs JS).
- `firebase-admin` v13: removed deprecated FCM APIs (we don't use FCM), migrated credentials to `google-auth-library` (transparent — we use the runtime SA via no-arg `initializeApp()`).

All five deployed functions (`createForIntake`, `signIn`, `resetPin`, `disable`, `enable`) kept their `onCall` / `HttpsError` / `logger` / Admin SDK call sites identical.

## How to verify the upgrade is live

```
firebase functions:list --project admin-automation-74110
```

Every row should show `Runtime: nodejs22`.

## Rollback

```
git revert <upgrade-commit>
cd functions && rm -rf node_modules package-lock.json && npm install
firebase deploy --only functions
```

Old container images are retained for ~1 day per the Artifact Registry cleanup policy (see `artifact-cleanup-policy.md`), but rollback always redeploys from source rather than restoring an image.
