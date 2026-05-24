# automated_Multi_org — fork-readiness map

The folder at the workspace root (`automated_Multi_org/`) holds one doc
(`what_has_been_done.txt`) describing a refactor inside client_database that
made it forkable for another nonprofit by editing two config files instead of
grep-replacing across ~33 hardcoded sites. There is no separate project — this
map describes the multi-tenant setup AS IT LIVES INSIDE client_database.

```
═══════════════════════════════════════════════════════════════════════════════
        automated_Multi_org — fork-readiness map  (client_database)
═══════════════════════════════════════════════════════════════════════════════

┌─ 1. THE PROBLEM IT SOLVED ──────────────────────────────────────────────────┐
│                                                                              │
│   Before refactor:                          After refactor:                  │
│   ─────────────────                         ─────────────────                │
│   "Good Samaritan Outreach" in 6 files      → TENANT.orgName                 │
│   "@thrivegso.com" in 4 files               → TENANT.staffDomain             │
│   "daniel@thrivegso.com" in 3 files         → TENANT.adminEmail              │
│   /^GSO-\d{5}$/  in 4 places                → CLIENT_ID_RE (derived)         │
│   Photo/video consent prose inline          → TENANT.photoVideoConsentText   │
│   ODH-206 form prose inline                 → TENANT.odh206FormText          │
│   Firebase web SDK config inline            → TENANT.firebase                │
│                                                                              │
│   ~33 sites → 2 config files + 2 rules files (rules can't import).           │
└──────────────────────────────────────────────────────────────────────────────┘


┌─ 2. THE TWO CONFIG FILES — SOURCE OF TRUTH ─────────────────────────────────┐
│                                                                              │
│   ┌─────────────────────────────────────┐  ┌────────────────────────────┐    │
│   │ public/config.js   (BROWSER side)   │  │ functions/config.mjs (CFs) │    │
│   ├─────────────────────────────────────┤  ├────────────────────────────┤    │
│   │ export const TENANT = {             │  │ export const STAFF_DOMAIN  │    │
│   │   firebase: {apiKey, authDomain,    │  │ export const ADMIN_EMAIL   │    │
│   │              projectId, ... },      │  │ export const CLIENT_ID_   │    │
│   │   staffDomain: "thrivegso.com",     │  │        PREFIX = "GSO"      │    │
│   │   adminEmail: "daniel@...",         │  │ export const CLIENT_ID_   │    │
│   │   clientIdPrefix: "GSO",            │  │        DIGITS = 5          │    │
│   │   clientIdDigits: 5,                │  │ export const REGION =      │    │
│   │   orgName: "Good Samaritan...",     │  │        "us-central1"       │    │
│   │   orgShort: "GSO",                  │  │ export const CLIENT_ID_RE  │    │
│   │   orgTagline: "Thrive Program",     │  │   = new RegExp(`^${PREFIX}- │    │
│   │   pageTitle: "GSO Database",        │  │      \\d{${DIGITS}}$`)     │    │
│   │   orgNameWithAddress: "...",        │  └────────────────────────────┘    │
│   │   expirationOnExitEvent: "Upon...", │   Mirrors the BROWSER values        │
│   │   photoVideoConsentText: "...",     │   that Cloud Functions also need.   │
│   │   odh206FormText: "..."             │                                     │
│   │ }                                   │   Two copies, not one, because the  │
│   │                                     │   browser cannot import from        │
│   │ export const CLIENT_ID_RE = ...     │   functions/ and vice-versa. Keep   │
│   │ export const isStaffEmail = ...     │   them in lockstep when forking.    │
│   │ export const isAdminEmail = ...     │                                     │
│   │ export const generateClientId = ... │                                     │
│   │ export const applyTenantBranding =..│                                     │
│   └─────────────────────────────────────┘                                     │
└──────────────────────────────────────────────────────────────────────────────┘


┌─ 3. HOW CONFIG REACHES EACH LAYER (4 different mechanisms) ─────────────────┐
│                                                                              │
│                   ┌─────────────────────────┐                                │
│                   │   public/config.js      │                                │
│                   │   (TENANT object)       │                                │
│                   └────────────┬────────────┘                                │
│                                │                                             │
│        ┌───────────────────────┼──────────────────────┐                      │
│        │                       │                      │                      │
│        ▼                       ▼                      ▼                      │
│  ┌──────────────┐      ┌───────────────┐      ┌───────────────┐              │
│  │ A. ES IMPORT │      │ B. DOM WALK   │      │ C. VALIDATION │              │
│  ├──────────────┤      ├───────────────┤      ├───────────────┤              │
│  │ app.js does  │      │ At boot,      │      │ app.js calls  │              │
│  │              │      │ applyTenant   │      │ CLIENT_ID_RE  │              │
│  │ import {     │      │ Branding()    │      │ .test(input)  │              │
│  │   TENANT,    │      │ scans the DOM │      │               │              │
│  │   CLIENT_ID_ │      │ for elements  │      │ Generates IDs │              │
│  │     RE,      │      │ with:         │      │ via generate  │              │
│  │   isAdmin    │      │  data-tenant- │      │   ClientId()  │              │
│  │     Email,   │      │   text=       │      │               │              │
│  │   generate   │      │  data-tenant- │      │ Email checks  │              │
│  │     ClientId,│      │   placeholder │      │ via isStaff   │              │
│  │   applyTenant│      │  data-tenant- │      │   Email,      │              │
│  │     Branding,│      │   html=       │      │ isAdminEmail  │              │
│  │ } from       │      │  data-tenant- │      │               │              │
│  │ './config.js'│      │   value=      │      │ All four are  │              │
│  │              │      │ and sets the  │      │ derived from  │              │
│  │ Uses them at │      │ matching      │      │ TENANT, not   │              │
│  │ runtime.     │      │ TENANT.<key>. │      │ hardcoded.    │              │
│  └──────────────┘      └───────────────┘      └───────────────┘              │
│                                                                              │
│                                                                              │
│                   ┌─────────────────────────┐                                │
│                   │  functions/config.mjs   │                                │
│                   └────────────┬────────────┘                                │
│                                │                                             │
│                                ▼                                             │
│                  ┌────────────────────────────┐                              │
│                  │ D. CLOUD-FUNCTION IMPORT   │                              │
│                  ├────────────────────────────┤                              │
│                  │ functions/index.mjs does   │                              │
│                  │                            │                              │
│                  │   import {                 │                              │
│                  │     STAFF_DOMAIN, REGION,  │                              │
│                  │     CLIENT_ID_RE,          │                              │
│                  │   } from './config.mjs'    │                              │
│                  │                            │                              │
│                  │ Used in:                   │                              │
│                  │  • requireStaff() guard    │                              │
│                  │  • signIn() PIN validation │                              │
│                  │  • onCall region setting   │                              │
│                  └────────────────────────────┘                              │
└──────────────────────────────────────────────────────────────────────────────┘


┌─ 4. THE data-tenant-* PATTERN — HOW STATIC HTML GETS BRANDED ───────────────┐
│                                                                              │
│   index.html declares slots, NOT values:                                     │
│                                                                              │
│      <h1 data-tenant-text="orgShort">GSO</h1>                                │
│      <p  data-tenant-html="staffDomainHint">                                 │
│           Use your <code>@thrivegso.com</code> account                       │
│      </p>                                                                    │
│      <input data-tenant-placeholder="clientIdExample"                        │
│             placeholder="GSO-12345">                                         │
│      <input data-tenant-value="orgName"                                      │
│             value="Good Samaritan Outreach">                                 │
│                                                                              │
│   The default text inside is a FALLBACK for "what if the JS hasn't run yet"  │
│   — it's not the source of truth.                                            │
│                                                                              │
│   At boot:                                                                   │
│                                                                              │
│      document.addEventListener('DOMContentLoaded', () => {                   │
│         applyTenantBranding();        // walks DOM, swaps in TENANT.<key>    │
│         document.title = TENANT.pageTitle;                                   │
│      });                                                                     │
│                                                                              │
│   A fork that changes TENANT.orgShort = "ARC" doesn't have to touch          │
│   index.html — every data-tenant-* slot picks up the new value.              │
└──────────────────────────────────────────────────────────────────────────────┘


┌─ 5. THE RULES PROBLEM — WHY THE FORK STILL TOUCHES 2 NON-CONFIG FILES ──────┐
│                                                                              │
│   Firestore rules and Storage rules can NOT import JS. The rules engine      │
│   only takes literal strings/regexes inside the rules file.                  │
│                                                                              │
│   So firestore.rules and storage.rules still have hardcoded:                 │
│                                                                              │
│      • the staff email domain  ("@thrivegso.com")                            │
│      • the admin email         ("daniel@thrivegso.com")                      │
│      • the client ID regex     (^GSO-\d{5}$)                                 │
│                                                                              │
│   The refactor's compromise: a header comment block at the top of each       │
│   rules file enumerates every per-tenant literal to find-and-replace. Grep   │
│   targets are documented so forks can't miss one.                            │
│                                                                              │
│        ┌──────────────────────────────────────────────┐                      │
│        │ firestore.rules                              │                      │
│        │   // FORKING ORG: replace these literals     │                      │
│        │   //   "@thrivegso.com"                      │                      │
│        │   //   "daniel@thrivegso.com"                │                      │
│        │   //   "^GSO-\\d{5}$"                        │                      │
│        │   service cloud.firestore { ... }            │                      │
│        └──────────────────────────────────────────────┘                      │
└──────────────────────────────────────────────────────────────────────────────┘


┌─ 6. WHAT IS NOT YET CONFIGURABLE (KNOWN LIMITS) ────────────────────────────┐
│                                                                              │
│   Out-of-scope for the refactor; a fork still has to:                        │
│                                                                              │
│   • Re-seed beds      (admin/seed-beds.mjs — 24 GSO-specific bed IDs)        │
│   • Re-seed meds      (admin/seed-medication-catalog.mjs)                    │
│   • Re-author the     ODH-206 PDF template fields if not in Oklahoma         │
│   • Replace            forms/gso-logo.png + tweak styles.css :root vars      │
│   • Find-and-replace  ~10 lines of prose in index.html that read more as     │
│                        sentences than identifiers ("Previously a guest at    │
│                        GSO", "leaving Good Samaritan Outreach Program")      │
│   • Decide whether    LEVEL_KEYS / LEADERSHIP_ROLES (still hardcoded near    │
│                        top of app.js) need extracting — they didn't, yet     │
└──────────────────────────────────────────────────────────────────────────────┘


┌─ 7. END-TO-END FORK FLOW — "STAND UP A SISTER NONPROFIT ON THIS APP" ───────┐
│                                                                              │
│      1. Make a new Firebase / GCP project (one per tenant — DBs don't mix)   │
│         │                                                                    │
│         │   gcloud + Firebase console clicks                                 │
│         ▼                                                                    │
│      2. Clone client_database/ to a sibling folder for the new tenant        │
│         │                                                                    │
│         ▼                                                                    │
│      3. Edit ONE file:   public/config.js                                    │
│         │                  TENANT.firebase  ← new project's web SDK config   │
│         │                  TENANT.staffDomain, adminEmail, ids, org names    │
│         │                  TENANT.photoVideoConsentText, odh206FormText      │
│         ▼                                                                    │
│      4. Edit ONE more:   functions/config.mjs   (mirror STAFF_DOMAIN etc)    │
│         │                                                                    │
│         ▼                                                                    │
│      5. Find-and-replace in TWO rules files:                                 │
│         │                  firestore.rules    + storage.rules                │
│         │                  (header comments show what to swap)               │
│         ▼                                                                    │
│      6. firebase use <new-project-alias> && firebase deploy                  │
│         │                                                                    │
│         ▼                                                                    │
│      7. node admin/set-claim.mjs <new-admin-uid>     (admin custom claim)    │
│         node admin/seed-beds.mjs                     (their bed list)        │
│         node admin/seed-medication-catalog.mjs       (their meds)            │
│         │                                                                    │
│         ▼                                                                    │
│      8. (optional) Edit styles.css :root colors + drop in their logo.png     │
│                                                                              │
│   Steps 3+4+5 = the entire textual rebrand. Everything else is "stand up     │
│   any Firebase project."                                                     │
└──────────────────────────────────────────────────────────────────────────────┘
```
