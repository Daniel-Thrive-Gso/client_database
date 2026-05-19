# PWA (installable web app) scaffolding

**Shipped:** 2026-05-19

## What this is

The client_database app is now an installable Progressive Web App. On a phone, a visitor to `admin-automation-74110.web.app` (or any custom domain we point at the same Firebase project) gets a browser prompt to "Add to Home Screen" / "Install app". Once installed, the app launches in a standalone window — no browser URL bar, custom icon on the home screen, dark status bar. On desktop Chrome it shows the same install option in the address bar.

The service worker also provides a minimal **offline fallback page** — if a client opens the app with no connection, they see a branded "you're offline" screen with a "Try again" button instead of the browser's default error.

## What is deliberately NOT cached

The service worker (`public/sw.js`) is intentionally narrow:

- **Cross-origin requests pass through untouched.** Firebase Auth, Firestore, and Cloud Functions traffic are never intercepted. The app always talks to the live backend for sign-in, reads, and writes — no risk of stale data or stale auth state.
- **Same-origin GETs are network-first.** The SW tries the network first and only falls back to cache if the network fails. Successful responses for static asset types (CSS, JS, images, fonts) get cached opportunistically so a reload during a brief disconnect still works.
- **Navigation requests** (i.e. someone loads `/`) try the network first and fall back to `offline.html` only if the network is fully unavailable.

This means there is no "stale app shell" failure mode — every page load on a working connection is fresh. The trade-off is that the app needs a working connection to do anything meaningful (sign in, view records, submit). That's a feature, not a bug, for an app that handles client PII.

## Files

| File | Purpose |
|------|---------|
| `public/sw.js` | Service worker. Network-first, cross-origin pass-through, offline fallback for navigations. |
| `public/manifest.webmanifest` | PWA manifest — app name "GSO Thrive Program", short name "GSO Thrive", standalone display, dark theme `#111111`, three icons. |
| `public/offline.html` | Branded offline fallback page. Reload button. |
| `public/icons/` | App icons: `icon-192.png`, `icon-512.png`, `icon-maskable-512.png`, `apple-touch-icon.png` (180), `favicon-32.png`. |
| `scripts/generate-pwa-icons.ps1` | Regenerates the five icons from `public/forms/gso-logo.png` using System.Drawing. |
| `public/index.html` | Adds manifest link, theme-color, apple-touch + apple-mobile-web-app tags, `viewport-fit=cover`, SW registration script. |
| `public/styles.css` | Mobile polish: safe-area-inset padding, `overscroll-behavior: contain`, 16px input font (kills iOS auto-zoom), tap-highlight color. |
| `firebase.json` | Cache-Control headers: `sw.js` no-cache (so SW updates ship immediately), `manifest.webmanifest` 5min, `icons/**` 30d immutable. |
| `public/config.js` | `pageTitle` updated to "GSO Thrive Program" to match the manifest name. |

## How to regenerate the icons

Run from `client_database/`:

```powershell
pwsh scripts/generate-pwa-icons.ps1
```

The source is `public/forms/gso-logo.png`. Re-run any time the logo changes. The maskable icon (the one Android crops with a circular/squircle mask) uses a tighter `LogoScale` of 0.62 — if it ever looks cropped on an Android device, tweak that value in the script.

## How to push a service-worker update

Bump the `SW_VERSION` constant at the top of `public/sw.js`:

```js
const SW_VERSION = 'gso-thrive-v1';  // → 'gso-thrive-v2'
```

After deploy, the next time an installed client visits the app, the new SW installs, the old cache is purged in `activate`, and `self.clients.claim()` takes over the page on next reload. The no-cache header on `sw.js` means clients pick up the new version on their next visit.

## What is not in scope here

- No push notifications.
- No background sync, periodic sync, or web-share-target.
- No custom "Install app" UI button — we rely on the browser's native install prompt.
- No caching of Firebase Auth / Firestore — see "What is deliberately NOT cached" above.

## Local development note

The service worker registration in `index.html` is gated on `location.protocol === 'https:'`, so it does **not** run on `localhost`. Testing the SW + offline fallback requires deploying to Firebase Hosting (or any HTTPS host). This is intentional — it prevents stale-cache foot-guns during dev.
