# client_database — code map

Visual orientation for the repo. Keep this skimmable — for deep detail go to
the source or `admin_automation/client_database_plan.md`.

## 1. Project tree

```
client_database/
├── public/                       Static PWA — served by Firebase Hosting
│   ├── index.html                All markup; ~2.1k lines of forms + tabs
│   ├── app.js                    All client behavior; ~12k lines (see §3)
│   ├── styles.css                Design system + page styles
│   ├── sw.js                     Service worker (offline shell)
│   ├── manifest.webmanifest      PWA manifest
│   ├── offline.html              Shown when SW serves stale offline page
│   ├── icons/                    Favicons + PWA tiles
│   └── forms/                    Blank PDFs/DOCX shown to staff
│
├── functions/                    Cloud Functions (Node 22, v2 onCall)
│   └── index.mjs                 5 callable functions for client PIN auth
│
├── admin/                        One-off Node scripts (run by a human)
│   ├── seed-*.mjs                Catalog + bed seeding
│   ├── cleanup-*.mjs             Delete test data, orphans, old events
│   ├── enable-*.mjs              Toggle Firestore TTL + backups
│   ├── grant-*.mjs               IAM grants (token creator, public invoker)
│   ├── check-*.mjs               IAM/auth diagnostics
│   ├── list-*.mjs                List clients, Run services
│   ├── set-claim.mjs             Set admin custom claim on a user
│   ├── preview-odh206.{mjs,pdf}  Render the ODH-206 PDF locally
│   ├── provision-missing-pins.mjs Backfill PIN docs for legacy clients
│   ├── backfill-selfeval-clientid.mjs
│   └── test-resetpin.mjs
│
├── scripts/
│   └── generate-pwa-icons.ps1    Build icon set from a source PNG
│
├── docs/
│   ├── changelog/                Notes on notable migrations
│   └── code-map.md               (this file)
│
├── firestore.rules               Three-role security model (admin/staff/client)
├── firestore.indexes.json        Composite index definitions
├── storage.rules                 Mirrors Firestore's role model for files
├── firebase.json                 Hosting headers + service wiring
└── .firebaserc                   Firebase project alias
```

## 2. Runtime architecture

```
                       ┌───────────────────────┐
                       │  Firebase Hosting     │
                       │  clients.thrivegso.com│
                       │  serves /public       │
                       └──────────┬────────────┘
                                  │  HTML / JS / CSS / SW
                                  ▼
   ┌─────────────────────────────────────────────────────────────┐
   │                       Browser PWA                           │
   │                                                             │
   │  ┌─────────────┐         ┌──────────────────────────────┐  │
   │  │ STAFF view  │         │  CLIENT view (PIN sign-in)   │  │
   │  │ #app-section│         │  #client-app-section         │  │
   │  │  ─ tabs:    │         │   • home / schedule          │  │
   │  │   Self-Eval │         │   • update info form         │  │
   │  │   Roster    │         │   • staff help request       │  │
   │  │   Sign In/Out         │   • my schedule              │  │
   │  │   Clients   │         │   • scanned docs (read-only) │  │
   │  │   Beds      │         └──────────────────────────────┘  │
   │  │   Inbox     │                                            │
   │  │   Schedules │         Auth gate (onAuthStateChanged):    │
   │  │   Reports   │           Google + @thrivegso.com → staff  │
   │  │   Intake    │           custom claim role=client → client│
   │  │   Exit      │           neither → #signin-section        │
   │  │   Audit*    │  (*admin)                                  │
   │  └─────────────┘                                            │
   └────┬────────────────────────────────────────────────┬───────┘
        │                                                │
        │ Firebase SDK (modular, v10.14.0 ESM)           │
        ▼                                                ▼
 ┌──────────────────┐  ┌─────────────────┐  ┌─────────────────────┐
 │ Cloud Firestore  │  │ Cloud Storage   │  │ Cloud Functions     │
 │ (firestore.rules)│  │ (storage.rules) │  │ us-central1         │
 │                  │  │                 │  │  createForIntake    │
 │  clients/*       │  │  clients/{cid}/ │  │  signIn (public)    │
 │  intakes/*       │  │   photos/       │  │  resetPin           │
 │  exits/*         │  │   signatures/   │  │  disable / enable   │
 │  checkInOuts/*   │  │   odh206/       │  │                     │
 │  selfEvaluations │  │   consents/     │  │  Uses Admin SDK to  │
 │  beds/*          │  │   documents/    │  │  manage Auth users  │
 │  …(see §5)…      │  └─────────────────┘  │  + scrypt PIN hash. │
 └──────────────────┘                       └─────────────────────┘
                                                      │
                                                      ▼
                                            ┌──────────────────┐
                                            │ Firebase Auth    │
                                            │  staff: Google   │
                                            │  client: custom  │
                                            │   token (uid=cid)│
                                            └──────────────────┘
```

## 3. `public/app.js` — section map

12k lines, no bundler. Sections delimited by `// ----- … -----` banners.

```
LINE      SECTION                                       PURPOSE
────────────────────────────────────────────────────────────────────────────
   1-37   imports + firebaseConfig                      Boot Firebase
                                                        and SDK handles
  38- 95  Program constants                             Levels, leadership
                                                        roles, probation
  96-130  Singletons + clientAuth wrappers              app/auth/db/storage/
                                                        functions handles
 131-165  DOM element refs                              Cached document.get
                                                        ElementById lookups
 167-238  Audit log helpers + signin error              logAccess() writer
 244-309  Inactivity auto-logout                        15-min idle timer +
                                                        warning banner
 402-580  Self-Evaluations + report rendering           setSubmitDefaults,
                                                        startReportListener
 582-748  Client master record                          createClient,
                                                        createNewClient,
                                                        saveReentryIntake
 750-879  Clients list + search                         live snapshot, in-
                                                        memory filter
 881-893  Tab navigation                                #app-section tabs
 895-1019 Audit log tab (admin-only)                    loadAuditLog,
                                                        render + filters
1021-1626 Intake §1 Identity + conditional sub-sections SSN handling,
                                                        emergency contacts
1628-1813 Intake §8 Drug screen + medication picker     15-panel results,
                                                        catalog lookup
1815-1934 "+ Add new medication" modal
1936-2245 Photo capture + signature pad + consent modal Section 1 webcam +
                                                        HTML5 canvas sig
2247-2914 Cloud Storage upload helper + post-save uploads
2916-3087 Add-medication modal (post-intake)
3089-4738 Discontinue-med modal + huge body of client-
          detail editing handlers
4740-5803 Upload modals (two)                           Scanned doc uploads
5805-6724 Exit history (client detail view)
6725-7715 Loaders / renderers / conflict detection /    Consolidated
          consolidated schedule view / editing /        client schedule
          save handlers / printable thrift schedule /   widget (staff side)
          appointment edit modal
7716-7769 Week navigation
7770-8590 Mount client picker (intake re-entry, etc.)
8592-8971 Per-client query report                       Reports tab
8973-9070 Client-detail bed fieldset
9072-9278 Pick-a-bed modal
9280-9654 Transactional bed write paths                 Atomic bed
                                                        assign/release
9656-9792 Last-24h checkInOuts listener + recent
          activity / "currently out" tile
9794-9892 Staff backfill quick-log                      Sign In/Out tab
9894-9958 Reason picker modal
9960-10041 Write a check-in/out event
10043-10128 Client-detail per-client history fieldset
10130-10254 Reset PIN button (client detail)
                                                                 ─── STAFF ▲
                                                                 ─── CLIENT ▼
10256-10318 Client sign-in form (PIN-based)              Calls signIn CF,
                                                        signInWithCustomToken
10320-10815 Client home screen                          Landing after PIN
10817-10896 Client info-update submission               Writes to
                                                        pendingClientSubmissions
10898-10972 Client staff help request submission
10974-11018 Client scanned documents view (read-only)
11020-11905 My schedule (approved personal events +
            assigned thrift shifts)
11907-end   Update/take photo modal (client detail)
```

## 4. Cloud Functions — `functions/index.mjs`

```
                          requireStaff()            ┌─────────────────┐
   ┌─────────────────┐         ▲                    │ Firebase Auth   │
   │ createForIntake │─────────┤                    │ Admin SDK       │
   └────────┬────────┘         │   ┌──────────┐     │  setCustomClaims│
            │                  ├──→│ ensureAuthUser ├→│  createUser    │
            ▼                  │   └────┬─────┘     │  updateUser     │
   provisionClientAccount() ───┤        ▼           │  createCustomToken
            │                  │   ┌──────────┐     └─────────────────┘
            ▼                  ├──→│ hashPin  │ scrypt N=16384
   clients/{cid}/auth/pin      │   └────┬─────┘
   { algo, salt, hash,         │        ▼
     failedAttempts,           │   ┌──────────────────┐
     firstFailedAt,            │   │ Firestore write  │
     lockedUntil,              │   │  pin doc + audit │
     pinCreatedBy }            │   └──────────────────┘
                               │
   ┌─────────────────┐         │
   │ resetPin (staff)│─────────┘
   └─────────────────┘

   ┌─────────────────┐
   │ signIn (PUBLIC) │  runTransaction:
   └────────┬────────┘    read pin doc → verifyPin (scrypt + timingSafeEqual)
            │             on fail: incr counter, lock at 5 in 15min for 15min
            ▼             on success: reset counter
   auth.createCustomToken(cid, { role:'client', clientId:cid })
            │
            ▼
   browser: signInWithCustomToken(token)

   ┌─────────┐  ┌────────┐    auth.updateUser(cid, { disabled: true/false })
   │ disable │  │ enable │
   └─────────┘  └────────┘    Used on exit (disable) and re-entry (enable).
```

All five are `onCall` in `us-central1`. `requireStaff()` checks
`email_verified && @thrivegso.com`. `signIn` is the only public one.

## 5. Firestore — collections + roles

`A`=admin, `S`=staff, `C`=client (own record only).

```
clients/{cid}                          R: A S Cown    W: S    D: A
  ├─ sensitive/{docId}                 R: A S Cown    W: S    D: A
  ├─ odh206/{authId}                   R: A S Cown    W: S    D: A
  ├─ consents/{type}                   R: A S Cown    W: S    D: A
  ├─ auth/{authDoc}      ← PIN hash    R: ─          W: ─    (CF only)
  ├─ scannedDocs/{id}                  R: A S Cown    W: S    D: A
  └─ phiRecords/{id}                   R: A S         W: S    D: A
beds/{bedId}                           R: A S         W: S    D: A
medicationCatalog/{medId}              R: A S         W: S    D: A
intakes/{intakeId}                     R: A S Cown    W: S    D: A
exits/{exitId}                         R: A S Cown    W: S    D: A
dailyGuestRoster/{docId}               R: A S         W: S    D: A
checkInOuts/{eventId}                  R: A S         W: S    D: A
showerLog / mealLog                    R: A S         W: S    D: A
clientWeeklySchedule                   R: A S Cown    W: S    D: A
thriftStoreSchedule                    R: A S Cown    W: S    D: A
medications / drugTests                R: A S Cown    W: S    D: A
clientStatusUpdates                    R: A S Cown    W: S    D: A
pendingClientSubmissions/{subId}       R: A S         W: Cown→S (approve)  D:A
activityLog/{entryId}                  R: A S         W: S
accessLog/{entryId}                    R: A          W: server only (CF/admin)
users/{userId}                         R: A           W: A
selfEvaluations/{docId}                R: A S Cown    W: S Cown
```

## 6. Cloud Storage — paths + roles

```
gs://admin-automation-74110.firebasestorage.app/
└── clients/{cid}/
    ├── photos/**          R: A S Cown   W: S   (intake photos)
    ├── signatures/**      R: A S Cown   W: S   (canvas sig captures)
    ├── odh206/{authId}/** R: A S Cown   W: S   (PHI under signed release)
    ├── consents/{type}/** R: A S Cown   W: S   (scanned consent forms)
    └── documents/{type}/**R: A S Cown   W: S   (misc scanned docs)
```

Role helpers live inline (Storage rules can't read Firestore) and use the
same `@thrivegso.com` email and `role=='client'` custom claim checks as
firestore.rules.

## 7. Where GSO constants live

Hardcoded everywhere they're used. No central config file. Search for the
literal you need:

```
  STRING                            FILES
  ────────────────────────────────────────────────────────────────────────
  "thrivegso.com"                   shared/firebase.js (ALLOWED_DOMAIN),
                                    functions/index.mjs (requireStaff),
                                    firestore.rules + storage.rules
                                      (isStaff helper)
  "daniel@thrivegso.com"            shared/helpers.js (isAdminEmail),
                                    firestore.rules + storage.rules
                                      (isAdmin fallback)
  /^GSO-\d{5}$/                     shared/helpers.js (CLIENT_ID_RE),
                                    functions/index.mjs (validClientId)
  Firebase SDK config object        shared/firebase.js (initializeApp)
  ODH-206 + photo/video             app.js (PHOTO_VIDEO_CONSENT_TEXT,
    consent text                      ODH206_TEXT)
  Org name / address / tagline      app.js + features/inbox.js + index.html
                                      (inline literals)
```

## 8. PWA + offline

```
   index.html ────registers────► sw.js (service worker)
                                   ├─ install: pre-cache app shell
                                   ├─ fetch:   network-first, falls back to
                                   │            offline.html for navigation
                                   └─ no Cache-Control on HTML; SW handles it
```

Hosting headers (firebase.json) force `no-cache` on HTML and `sw.js`, long
immutable cache on `/icons/**`, short cache on the manifest.
