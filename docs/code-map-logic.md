# client_database — logic flow map

Focus: data + deploy. Files-oriented version lives at [code-map.md](code-map.md).

```
═══════════════════════════════════════════════════════════════════════════════
            client_database — logic flow map  (focus: data + deploy)
═══════════════════════════════════════════════════════════════════════════════

┌─ 1. SOURCE-OF-TRUTH & DEPLOY ────────────────────────────────────────────────┐
│                                                                              │
│   Daniel's laptop (C:\Users\gsomi\gso\client_database)                       │
│        │                                                                     │
│        │   git push origin main                                              │
│        ▼                                                                     │
│   ┌────────────────────────────────┐                                         │
│   │ GitHub                         │   ← source archive only.                │
│   │ Daniel-Thrive-Gso/             │     No GitHub Action.                   │
│   │ client_database (main)         │     No auto-deploy.                     │
│   └────────────────────────────────┘                                         │
│                                                                              │
│        │   .\scripts\deploy.ps1   (run from local laptop)                    │
│        │     Bumps SW_VERSION in sw.js + ?v= on app.js entry, then           │
│        │     calls firebase deploy with the args you pass (default:          │
│        │     --only hosting). The fresh stamp invalidates the SW cache       │
│        │     on every visitor's next visit so clients pick up the new        │
│        │     JS/CSS/HTML in one stroke.                                      │
│        │       .\scripts\deploy.ps1                       # hosting only     │
│        │       .\scripts\deploy.ps1 --only functions      # functions only   │
│        │       .\scripts\deploy.ps1 --only firestore:rules                   │
│        │     Plain `firebase deploy` still works but won't bump the          │
│        │     cache-buster — users may serve stale JS until the SW            │
│        │     re-fetches on its own schedule.                                 │
│        ▼                                                                     │
│   ┌────────────────────────────────┐                                         │
│   │ Firebase project               │                                         │
│   │ admin-automation-74110         │                                         │
│   └────────────────────────────────┘                                         │
│                                                                              │
│   GitHub and Firebase are SIBLING outputs of the laptop, not a pipeline.     │
│   It IS possible for them to diverge — `firebase deploy` doesn't check git.  │
└──────────────────────────────────────────────────────────────────────────────┘


┌─ 2. WHO IS USING THE APP, AND HOW THE FRONTEND ROUTES THEM ─────────────────┐
│                                                                              │
│             https://clients.thrivegso.com                                    │
│                       │                                                      │
│                       ▼                                                      │
│           ┌─────────────────────────┐                                        │
│           │ Browser loads PWA shell │  (index.html + app.js + config.js)     │
│           │ Service worker caches   │                                        │
│           └───────────┬─────────────┘                                        │
│                       │                                                      │
│                       ▼                                                      │
│         onAuthStateChanged() decides which view to show:                     │
│                                                                              │
│   ┌──────────────────────┐  ┌──────────────────────┐  ┌──────────────────┐  │
│   │ Google sign-in       │  │ Custom-token sign-in │  │ Signed out       │  │
│   │ + @thrivegso.com     │  │ + role=='client'     │  │                  │  │
│   │   (email_verified)   │  │   custom claim       │  │                  │  │
│   ├──────────────────────┤  ├──────────────────────┤  ├──────────────────┤  │
│   │ → STAFF view         │  │ → CLIENT view        │  │ → Sign-in screen │  │
│   │   #app-section       │  │   #client-app-section│  │   #signin-section│  │
│   │                      │  │                      │  │                  │  │
│   │ Tabs:                │  │ Tiles:               │  │ Two paths:       │  │
│   │  Self-Eval           │  │  My home / schedule  │  │  • Google btn    │  │
│   │  Roster              │  │  Update my info      │  │    (for staff)   │  │
│   │  Sign In/Out         │  │  Ask staff for help  │  │  • GSO-##### +   │  │
│   │  Clients             │  │  My scanned docs     │  │    PIN form     │  │
│   │  Beds                │  │  (read-only)         │  │    (for clients) │  │
│   │  Inbox               │  │                      │  │                  │  │
│   │  Schedules           │  │                      │  │                  │  │
│   │  Reports             │  │                      │  │                  │  │
│   │  Intake / Exit       │  │                      │  │                  │  │
│   │  Audit (admin only)  │  │                      │  │                  │  │
│   └──────────────────────┘  └──────────────────────┘  └──────────────────┘  │
└──────────────────────────────────────────────────────────────────────────────┘


┌─ 3. AUTH — TWO COMPLETELY DIFFERENT PATHS ──────────────────────────────────┐
│                                                                              │
│  STAFF                              CLIENT                                   │
│  ─────                              ──────                                   │
│  Click "Sign in with Google"        Type "GSO-12345" + 6-digit PIN           │
│         │                                  │                                 │
│         │                                  │ httpsCallable('signIn')         │
│         │                                  ▼                                 │
│         │                       ┌──────────────────────────┐                 │
│         │                       │ Cloud Function: signIn   │ (public)        │
│         │                       │  runTransaction:         │                 │
│         │                       │   read clients/{cid}/    │                 │
│         │                       │        auth/pin          │                 │
│         │                       │   scrypt verify          │                 │
│         │                       │   lock at 5 fails/15min  │                 │
│         │                       │   admin.auth()           │                 │
│         │                       │    .createCustomToken(   │                 │
│         │                       │      cid,                │                 │
│         │                       │      { role:'client' })  │                 │
│         │                       └────────────┬─────────────┘                 │
│         │                                    │ returns token                 │
│         ▼                                    ▼                               │
│  Firebase Auth                      Firebase Auth                            │
│  Google OAuth flow                  signInWithCustomToken(token)             │
│         │                                    │                               │
│         └──────────────┬─────────────────────┘                               │
│                        ▼                                                     │
│         currentUser now has either                                           │
│           • email @thrivegso.com + email_verified=true       (STAFF)         │
│           • customClaims.role == 'client' + uid == clientId  (CLIENT)        │
│                        │                                                     │
│                        ▼                                                     │
│         All subsequent Firestore / Storage reads carry this identity.        │
│         firestore.rules + storage.rules switch on it (see §5).               │
└──────────────────────────────────────────────────────────────────────────────┘


┌─ 4. FRONTEND ↔ DATA — WHAT EACH UI SECTION READS AND WRITES ────────────────┐
│                                                                              │
│  STAFF UI                                                                    │
│  ────────                                                                    │
│   Clients tab ─────── live snapshot ──────────► clients/*                    │
│       │  (search is in-memory filter on cached snapshot)                     │
│       │                                                                      │
│       └─ Client detail ─┬─ read/write ──► clients/{cid}                      │
│                         ├─ read/write ──► clients/{cid}/sensitive/*          │
│                         ├─ read/write ──► clients/{cid}/odh206/*             │
│                         ├─ read/write ──► clients/{cid}/consents/*           │
│                         ├─ read/write ──► clients/{cid}/scannedDocs/*        │
│                         ├─ uploads ─────► gs://.../clients/{cid}/photos/     │
│                         ├─ uploads ─────► gs://.../clients/{cid}/signatures/ │
│                         ├─ uploads ─────► gs://.../clients/{cid}/odh206/     │
│                         ├─ uploads ─────► gs://.../clients/{cid}/consents/   │
│                         └─ uploads ─────► gs://.../clients/{cid}/documents/  │
│                                                                              │
│   Intake tab ─────── createNewClient ──► clients/{cid} + intakes/*           │
│                      provisionClientAccount() Cloud Function:                │
│                          → Firebase Auth user (uid=cid)                      │
│                          → clients/{cid}/auth/pin (scrypt hash)              │
│                                                                              │
│   Exit tab ───────── writes ──────────► exits/* + clients/{cid}.status       │
│                      Cloud Function disable() flips auth user.disabled=true  │
│                                                                              │
│   Sign In/Out tab ── writes ──────────► checkInOuts/* + dailyGuestRoster/*   │
│       (also "currently out" tile listens to last-24h checkInOuts)            │
│                                                                              │
│   Beds tab ──────── transactional ─────► beds/* + clients/{cid}.bedId        │
│                                                                              │
│   Self-Eval tab ─── writes ──────────► selfEvaluations/*                     │
│                                                                              │
│   Schedules tab ─── writes ──────────► clientWeeklySchedule/*                │
│                                          thriftStoreSchedule/*               │
│                                                                              │
│   Inbox tab ─────── reads + approve ─► pendingClientSubmissions/*            │
│                       │  on approve, copies fields into clients/{cid}        │
│                       └  and deletes the pending doc                         │
│                                                                              │
│   Reports tab ───── ad-hoc queries ───► (any of the above)                   │
│                                                                              │
│   Audit tab ─────── reads only ──────► accessLog/* (admin only)              │
│                                                                              │
│                                                                              │
│  CLIENT UI                                                                   │
│  ─────────                                                                   │
│   My home ──────── live snapshot ─────► clients/{cid}     (own doc only)     │
│                                          clientStatusUpdates/{cid}/*         │
│                                                                              │
│   My schedule ──── reads ─────────────► clientWeeklySchedule/{cid}/*         │
│                                          thriftStoreSchedule/* (filtered)    │
│                                                                              │
│   Update my info ─ writes ────────────► pendingClientSubmissions/{newId}     │
│                      (client can ONLY create; staff approves in Inbox)       │
│                                                                              │
│   Ask staff for help ── writes ───────► pendingClientSubmissions/{newId}     │
│                                          with kind='staffRequest'            │
│                                                                              │
│   My scanned docs ─ reads only ───────► clients/{cid}/scannedDocs/*          │
│                                          gs://.../clients/{cid}/documents/   │
└──────────────────────────────────────────────────────────────────────────────┘


┌─ 5. RULES — WHO CAN DO WHAT (the bouncer between frontend and DB) ──────────┐
│                                                                              │
│   firestore.rules + storage.rules check three roles:                         │
│                                                                              │
│      A = admin    request.auth.token.email == 'daniel@thrivegso.com'         │
│      S = staff    request.auth.token.email matches @thrivegso.com            │
│                       AND request.auth.token.email_verified == true          │
│      C = client   request.auth.token.role == 'client'                        │
│                       AND request.auth.uid == clientId    (own doc only)     │
│                                                                              │
│   The auth subcollection (clients/{cid}/auth/pin) is locked to NO ONE.       │
│   Cloud Functions reach it via the Admin SDK, bypassing rules.               │
│                                                                              │
│   Because rules can't import config.js, the @thrivegso.com domain and        │
│   admin email are hardcoded in firestore.rules AND storage.rules — they      │
│   are the only two non-DRY copies of those values in the codebase.           │
└──────────────────────────────────────────────────────────────────────────────┘


┌─ 6. WRITES THAT CAN'T HAPPEN FROM THE BROWSER ──────────────────────────────┐
│                                                                              │
│   The browser cannot, even as admin:                                         │
│      • create a Firebase Auth user                                           │
│      • mint a custom token                                                   │
│      • read/write clients/{cid}/auth/pin                                     │
│      • disable/enable a user account                                         │
│                                                                              │
│   Those go through Cloud Functions (functions/index.mjs), all onCall in      │
│   us-central1:                                                               │
│                                                                              │
│      createForIntake     staff-only  →  new client master record + PIN       │
│      resetPin            staff-only  →  rehash + write auth/pin              │
│      disable             staff-only  →  auth.updateUser(disabled:true)       │
│      enable              staff-only  →  auth.updateUser(disabled:false)      │
│      signIn              PUBLIC      →  verify PIN, return custom token      │
│                                                                              │
│   requireStaff() guard runs on the first four. signIn validates only the     │
│   PIN itself (the whole point is the caller is not yet signed in).           │
└──────────────────────────────────────────────────────────────────────────────┘


┌─ 7. END-TO-END EXAMPLE — "Client updates their phone number" ───────────────┐
│                                                                              │
│   1. Client on phone:  GSO-12345 + PIN  ───► httpsCallable('signIn')         │
│   2. CF signIn:        scrypt verify   ───► custom token (role=client)       │
│   3. Browser:          signInWithCustomToken(token)                          │
│   4. Client UI:        taps "Update my info", edits phone, taps Submit       │
│   5. Browser write:    addDoc(pendingClientSubmissions, {clientId, phone})   │
│                          ↑ rules allow because uid == clientId               │
│   6. Staff opens Inbox: live snapshot surfaces the pending doc               │
│   7. Staff taps Approve: updateDoc(clients/{cid}, {phone}) + deleteDoc(pcs)  │
│   8. Client home re-renders next time it opens (live snapshot on clients/)   │
│                                                                              │
│   At no point does the browser touch clients/{cid} directly as the client —  │
│   every client-originated change is staged in pendingClientSubmissions and   │
│   gated by staff approval.                                                   │
└──────────────────────────────────────────────────────────────────────────────┘
```
