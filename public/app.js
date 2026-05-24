import {
  signInWithRedirect, getRedirectResult,
  signInWithCustomToken, signOut, onAuthStateChanged
} from "https://www.gstatic.com/firebasejs/10.14.0/firebase-auth.js";
import {
  collection, addDoc, getDocs, query, where, orderBy, limit, onSnapshot,
  doc, getDoc, setDoc, deleteDoc, updateDoc, serverTimestamp, Timestamp, writeBatch, runTransaction
} from "https://www.gstatic.com/firebasejs/10.14.0/firebase-firestore.js";
import {
  ref as storageRef, uploadBytes, getDownloadURL, deleteObject
} from "https://www.gstatic.com/firebasejs/10.14.0/firebase-storage.js";
import {
  TENANT,
  CLIENT_ID_RE,
  isAdminEmail,
  generateClientId,
} from "./config.js";
import {
  app, auth, db, storage, functions, provider,
  clientAuthCreate, clientAuthSignIn, clientAuthReset,
  clientAuthDisable, clientAuthEnable,
  ALLOWED_DOMAIN,
} from "./shared/firebase.js";
import {
  LEVEL_KEYS, LEVEL_LABELS, PROBATION_DEFAULT_DAYS,
  isOnProbation, levelDisplay,
  escapeHtml, capitalize, fmtClientTimeShort, fmtDate, fmtTimestamp,
  clientDisplayName, isCurrentUserAdmin,
} from "./shared/helpers.js";
import {
  cachedClients, clientsSearchText,
  startClientsListener as storeStartClientsListener,
  stopClientsListener as storeStopClientsListener,
  subscribe as subscribeClientsStore,
  subscribeError as subscribeClientsStoreError,
  setSearchText, clientMatchesSearch,
} from "./shared/clients-store.js";
import {
  DAY_LABELS, EVENT_TYPES, EVENT_TYPE_LABELS,
  timeToMinutes, formatTime12, eventsOverlap, formatEventLi,
} from "./shared/schedule-helpers.js";
import { createClientPicker } from "./shared/client-picker.js";
import {
  currentUserRole, currentUserClientId,
  setCurrentIdentity, clearCurrentIdentity,
} from "./shared/auth-state.js";
import {
  signinSection, appSection, clientAppSection,
  userBar, userEmail, signinBtn, signoutBtn, signinError,
} from "./shared/dom-shell.js";
import { AUDIT_ACTIONS, logAccess } from "./shared/audit-log-writer.js";
import { resetAuditState } from "./features/audit-log.js";

// LEADERSHIP_ROLES stays here for now — moves with the intake/client-detail
// split in Phase 4. INTAKE_BENEFIT_TYPES / INTAKE_BENEFIT_LABELS similarly
// belong with intake, so they stay too.
const LEADERSHIP_ROLES = {
  dormLeader:            "Dorm Leader",
  houseLeader:           "House Leader",
  assistantHouseLeader:  "Assistant House Leader",
  maintenance:           "Maintenance",
  laundry:               "Laundry",
  cookHelper:            "Cook Helper",
};

// Government benefit types captured on the intake form. Same keys as the
// status-update form so master.benefits.{type} is a single source of truth.
const INTAKE_BENEFIT_TYPES = [
  "foodStamps", "ssi", "ssdi", "rsdi", "vaDisability", "vaRetirement",
  "retirement", "workersComp", "tribalBenefits", "otherBenefit",
];

const INTAKE_BENEFIT_LABELS = {
  foodStamps: "Food stamps (SNAP)",
  ssi: "SSI",
  ssdi: "SSDI",
  rsdi: "RSDI / Social Security retirement",
  vaDisability: "VA disability",
  vaRetirement: "VA retirement",
  retirement: "Retirement (other)",
  workersComp: "Workers' compensation",
  tribalBenefits: "Tribal benefits",
  otherBenefit: "Other benefit",
};

// Returns the freshly generated PIN, or null on failure (intake save still
// succeeds; staff can use Reset PIN on the client detail page later).
async function provisionClientPin(clientId, displayName) {
  try {
    const result = await clientAuthCreate({ clientId, displayName });
    return result?.data?.pin || null;
  } catch (err) {
    console.warn("clientAuth.createForIntake failed:", err);
    return null;
  }
}

const submitForm = document.getElementById("submit-form");
const submitStatus = document.getElementById("submit-status");
const seedBtn = document.getElementById("seed-btn");
const reportBody = document.getElementById("report-body");
const tileUnresolvedValue = document.getElementById("tile-unresolved-value");
const tileAlerts = document.getElementById("tile-alerts");
const tileAlertsValue = document.getElementById("tile-alerts-value");
const tileAlertsList = document.getElementById("tile-alerts-list");
const clientsBody = document.getElementById("clients-body");
const clientsSearchInput = document.getElementById("clients-search");
const clientsCountEl = document.getElementById("clients-count");
const intakeForm = document.getElementById("intake-form");
const intakeStatus = document.getElementById("intake-status");
const intakeSuccess = document.getElementById("intake-success");
const successCid = document.getElementById("success-cid");
const successName = document.getElementById("success-name");
const successSsn = document.getElementById("success-ssn");
const successSsnReveal = document.getElementById("success-ssn-reveal");
const successSsnNote = document.getElementById("success-ssn-note");

let unsubscribeSnapshot = null;
let lastCreatedClientId = null;
let revealTimer = null;
let selfEvalClientPicker = null;
let intakeReentryPicker = null;
let reentryClientId = null; // null = new client; GSO-NNNNN = re-entry mode

// AUDIT_ACTIONS + logAccess now live in shared/audit-log-writer.js
// (imported at top of file).

// Use redirect for sign-in. signInWithPopup hangs silently in modern browsers
// (Chrome/Edge default to blocking third-party cookies, and the SDK promise
// often never settles, so a popup-with-fallback chain can't catch it).
// Redirect navigates to accounts.google.com and back — robust everywhere.
signinBtn.addEventListener("click", async () => {
  signinError.hidden = true;
  try {
    await signInWithRedirect(auth, provider);
    // Page navigates away; getRedirectResult on return handles the rest.
  } catch (err) {
    showSigninError(err.message || "Sign-in failed.");
  }
});

// Handle the return leg of signInWithRedirect. Runs once on load; resolves to
// null when there's no pending redirect, so it's safe to call unconditionally.
getRedirectResult(auth)
  .then(async (result) => {
    if (!result) return;
    const email = (result.user.email || "").toLowerCase();
    if (!email.endsWith(`@${ALLOWED_DOMAIN}`)) {
      await signOut(auth);
      showSigninError(`Sign-in must use a @${ALLOWED_DOMAIN} account.`);
      return;
    }
    await logAccess(AUDIT_ACTIONS.SIGN_IN, "session");
  })
  .catch((err) => {
    showSigninError(err.message || "Sign-in failed.");
  });

signoutBtn.addEventListener("click", async () => {
  await logAccess(AUDIT_ACTIONS.SIGN_OUT, "session");
  await signOut(auth);
});

function showSigninError(msg) {
  signinError.textContent = msg;
  signinError.hidden = false;
}

// --- Inactivity auto-logout (security control — go_live_checklist.md A7) ------
// Signs the user out after IDLE_TIMEOUT_MS with no interaction; pops a warning
// banner IDLE_WARNING_MS before. Any mouse / keyboard / touch / scroll activity
// resets the clock. Active for both the staff app and the client app. Adjust
// the two constants below to taste.
const IDLE_TIMEOUT_MS = 15 * 60 * 1000; // 15 minutes of inactivity → sign out
const IDLE_WARNING_MS = 60 * 1000;      // show the warning 1 minute before
const IDLE_ACTIVITY_EVENTS = [
  "mousedown", "keydown", "scroll", "touchstart", "click", "pointerdown",
];
let idleWarnTimer = null;
let idleLogoutTimer = null;
let idleWarnBanner = null;
let idleActivityBound = false;
let idleSignOut = false; // set true just before an inactivity-triggered signOut

function buildIdleWarnBanner() {
  if (idleWarnBanner) return idleWarnBanner;
  const el = document.createElement("div");
  el.id = "idle-warning";
  el.hidden = true;
  el.setAttribute("role", "alertdialog");
  el.style.cssText =
    "position:fixed;top:12px;left:50%;transform:translateX(-50%);z-index:99999;" +
    "background:#7a2e0e;color:#fff;padding:10px 14px;border-radius:8px;" +
    "font:14px/1.4 system-ui,-apple-system,sans-serif;display:flex;gap:12px;" +
    "align-items:center;max-width:92vw;box-shadow:0 2px 10px rgba(0,0,0,.35);";
  el.innerHTML =
    "<span>You’ll be signed out shortly due to inactivity.</span>" +
    '<button type="button" id="idle-stay" style="background:#fff;color:#7a2e0e;' +
    'border:0;border-radius:6px;padding:4px 10px;font-weight:600;cursor:pointer;">' +
    "Stay signed in</button>";
  document.body.appendChild(el);
  el.querySelector("#idle-stay").addEventListener("click", () => resetIdleTimers());
  idleWarnBanner = el;
  return el;
}
function hideIdleWarning() { if (idleWarnBanner) idleWarnBanner.hidden = true; }
function clearIdleTimers() {
  if (idleWarnTimer) { clearTimeout(idleWarnTimer); idleWarnTimer = null; }
  if (idleLogoutTimer) { clearTimeout(idleLogoutTimer); idleLogoutTimer = null; }
}
function resetIdleTimers() {
  if (!auth.currentUser) return;
  clearIdleTimers();
  hideIdleWarning();
  idleWarnTimer = setTimeout(
    () => { buildIdleWarnBanner().hidden = false; },
    Math.max(0, IDLE_TIMEOUT_MS - IDLE_WARNING_MS)
  );
  idleLogoutTimer = setTimeout(async () => {
    idleSignOut = true;
    hideIdleWarning();
    try { if (typeof stopClientAppListeners === "function") stopClientAppListeners(); } catch {}
    try { await signOut(auth); } catch (err) { console.warn("idle signOut failed", err); }
  }, IDLE_TIMEOUT_MS);
}
function startIdleTimeout() {
  if (!idleActivityBound) {
    for (const ev of IDLE_ACTIVITY_EVENTS) {
      window.addEventListener(ev, resetIdleTimers, { passive: true });
    }
    idleActivityBound = true;
  }
  resetIdleTimers();
}
function stopIdleTimeout() { clearIdleTimers(); hideIdleWarning(); }

onAuthStateChanged(auth, async (user) => {
  // Signed out — reset everything and show the dual sign-in screen.
  if (!user) {
    clearCurrentIdentity();
    if (unsubscribeSnapshot) { unsubscribeSnapshot(); unsubscribeSnapshot = null; }
    storeStopClientsListener();
    if (typeof stopBedsListener === "function") stopBedsListener();
    if (typeof stopCheckInOutListener === "function") stopCheckInOutListener();
    if (typeof stopInboxListener === "function") stopInboxListener();
    if (typeof stopStaffPerEventListener === "function") stopStaffPerEventListener();
    if (typeof stopClientAppListeners === "function") stopClientAppListeners();
    stopIdleTimeout();
    signinSection.hidden = false;
    appSection.hidden = true;
    if (clientAppSection) clientAppSection.hidden = true;
    userBar.hidden = true;
    if (typeof rosterInitialized !== "undefined") rosterInitialized = false;
    if (typeof scheduleInitialized !== "undefined") scheduleInitialized = false;
    if (typeof reportInitialized !== "undefined") reportInitialized = false;
    if (typeof reportMode !== "undefined") reportMode = "weekly";
    if (typeof reportYear !== "undefined") reportYear = null;
    document.querySelector('.tab-btn[data-tab="audit"]')?.setAttribute("hidden", "");
    resetAuditState();
    if (idleSignOut) {
      idleSignOut = false;
      showSigninError("You were signed out due to inactivity. Please sign in again.");
    }
    return;
  }

  // Read role from custom claims to decide which UI to show. Staff sign in
  // via Google (claims set via set-claim.mjs / email fallback rules); clients
  // sign in via clientAuth.signIn which returns a custom token carrying
  // role="client" + clientId.
  try {
    const idToken = await user.getIdTokenResult();
    setCurrentIdentity({
      role: idToken.claims.role,
      clientId: idToken.claims.clientId,
    });
  } catch (err) {
    console.warn("[auth] getIdTokenResult failed", err);
    clearCurrentIdentity();
  }

  if (currentUserRole === "client") {
    // Client home screen — see initClientApp.
    signinSection.hidden = true;
    appSection.hidden = true;
    userBar.hidden = true; // staff user bar is irrelevant for clients
    if (clientAppSection) clientAppSection.hidden = false;
    startIdleTimeout();
    initClientApp(user, currentUserClientId).catch((err) => {
      console.error("[client-app] init failed", err);
    });
    return;
  }

  // Staff path: enforce @{TENANT.staffDomain} domain. Clients never reach this branch
  // because their custom-token sign-in carries no email.
  const email = (user.email || "").toLowerCase();
  if (!email.endsWith(`@${ALLOWED_DOMAIN}`)) {
    await signOut(auth);
    showSigninError(`Sign-in must use a @${ALLOWED_DOMAIN} account.`);
    return;
  }

  signinSection.hidden = true;
  appSection.hidden = false;
  if (clientAppSection) clientAppSection.hidden = true;
  userBar.hidden = false;
  userEmail.textContent = user.email;
  const auditBtn = document.querySelector('.tab-btn[data-tab="audit"]');
  if (auditBtn) {
    if (isCurrentUserAdmin()) auditBtn.removeAttribute("hidden");
    else auditBtn.setAttribute("hidden", "");
  }
  startIdleTimeout();
  setSubmitDefaults();
  startReportListener();
  startClientsListener();
  if (typeof startBedsListener === "function") startBedsListener();
  if (typeof startCheckInOutListener === "function") startCheckInOutListener();
  if (typeof mountCheckInOutQuickPicker === "function") mountCheckInOutQuickPicker();
  if (typeof startInboxListener === "function") startInboxListener();
  if (typeof startStaffPerEventListener === "function") startStaffPerEventListener();
  if (typeof loadMedicationCatalog === "function") {
    loadMedicationCatalog().catch(() => {});
  }
});

function setSubmitDefaults() {
  const today = new Date().toISOString().slice(0, 10);
  submitForm.elements.dateGiven.value = today;
  if (!submitForm.elements.givenBy.value) {
    submitForm.elements.givenBy.value = (auth.currentUser?.displayName || "").trim();
  }
}

submitForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  submitStatus.hidden = true;
  const fd = new FormData(submitForm);

  const selected = selfEvalClientPicker?.getSelected();
  if (!selected) {
    showSubmitError("Please select a client. If this person isn't in the system yet, run a New Intake first.");
    return;
  }

  const dateGivenStr = fd.get("dateGiven");
  const dateGiven = dateGivenStr ? new Date(dateGivenStr + "T00:00:00") : null;
  if (!dateGiven || isNaN(dateGiven)) {
    showSubmitError("Invalid date.");
    return;
  }
  // clientName is denormalized for fast list rendering — clientId is the
  // canonical reference. Old docs without clientId continue to display via
  // clientName, so this change is backwards-compatible.
  const data = {
    clientId: selected.clientId,
    clientName: selected.name,
    reason: (fd.get("reason") || "").toString().trim(),
    dateGiven: Timestamp.fromDate(dateGiven),
    givenBy: (fd.get("givenBy") || "").toString().trim(),
    dateResolved: null,
    createdAt: serverTimestamp(),
    createdBy: auth.currentUser.email,
  };
  try {
    const ref = await addDoc(collection(db, "selfEvaluations"), data);
    await logAccess(AUDIT_ACTIONS.CREATE, "selfEvaluation", ref.id, { clientId: selected.clientId });
    submitForm.reset();
    selfEvalClientPicker?.clear();
    setSubmitDefaults();
    submitStatus.textContent = "Submitted.";
    submitStatus.classList.remove("error");
    submitStatus.classList.add("status");
    submitStatus.hidden = false;
    setTimeout(() => { submitStatus.hidden = true; }, 3000);
  } catch (err) {
    showSubmitError(err.message || "Submission failed.");
  }
});

function showSubmitError(msg) {
  submitStatus.textContent = msg;
  submitStatus.classList.remove("status");
  submitStatus.classList.add("error");
  submitStatus.hidden = false;
}

function startReportListener() {
  if (unsubscribeSnapshot) unsubscribeSnapshot();
  const q = query(
    collection(db, "selfEvaluations"),
    where("dateResolved", "==", null),
    orderBy("dateGiven", "desc")
  );
  unsubscribeSnapshot = onSnapshot(q, (snap) => {
    renderReport(snap.docs);
  }, (err) => {
    reportBody.innerHTML = `<tr class="empty"><td colspan="5">Could not load: ${escapeHtml(err.message)}</td></tr>`;
  });
}

function renderReport(docs) {
  tileUnresolvedValue.textContent = docs.length.toString();

  const counts = new Map();
  for (const d of docs) {
    const name = (d.data().clientName || "").trim();
    if (!name) continue;
    counts.set(name, (counts.get(name) || 0) + 1);
  }
  const flagged = [...counts.entries()].filter(([, n]) => n >= 3);
  if (flagged.length === 0) {
    tileAlerts.hidden = true;
  } else {
    tileAlerts.hidden = false;
    tileAlertsValue.textContent = flagged.length.toString();
    tileAlertsList.innerHTML = flagged
      .sort((a, b) => b[1] - a[1])
      .map(([name, n]) => `<li>${escapeHtml(name)} — ${n} unresolved</li>`)
      .join("");
  }

  if (docs.length === 0) {
    reportBody.innerHTML = `<tr class="empty"><td colspan="5">No unresolved self-evaluations.</td></tr>`;
    return;
  }
  reportBody.innerHTML = docs.map(d => {
    const data = d.data();
    const dateStr = data.dateGiven?.toDate ? data.dateGiven.toDate().toLocaleDateString() : "";
    return `
      <tr>
        <td>${escapeHtml(data.clientName || "")}</td>
        <td>${escapeHtml(dateStr)}</td>
        <td>${escapeHtml(data.reason || "")}</td>
        <td>${escapeHtml(data.givenBy || "")}</td>
        <td><button data-id="${d.id}" class="resolve-btn">Mark resolved</button></td>
      </tr>
    `;
  }).join("");
}

reportBody.addEventListener("click", async (e) => {
  const btn = e.target.closest(".resolve-btn");
  if (!btn) return;
  btn.disabled = true;
  try {
    await updateDoc(doc(db, "selfEvaluations", btn.dataset.id), {
      dateResolved: serverTimestamp(),
      resolvedBy: auth.currentUser.email,
    });
    await logAccess(AUDIT_ACTIONS.UPDATE, "selfEvaluation", btn.dataset.id, { resolved: true });
  } catch (err) {
    btn.disabled = false;
    alert(`Could not resolve: ${err.message}`);
  }
});

seedBtn.addEventListener("click", async () => {
  if (!confirm("Insert 10 fake unresolved self-evals (prototype data)?")) return;
  seedBtn.disabled = true;
  try {
    const records = [
      { client: "Bob R.", reason: "Missed AM meeting", daysAgo: 1 },
      { client: "Bob R.", reason: "Late check-in past 8pm", daysAgo: 3 },
      { client: "Bob R.", reason: "Skipped chore rotation", daysAgo: 5 },
      { client: "Alice T.", reason: "Conflict with another resident", daysAgo: 2 },
      { client: "Alice T.", reason: "Unauthorized phone use during class", daysAgo: 4 },
      { client: "Alice T.", reason: "Missed AM meeting", daysAgo: 11 },
      { client: "Carl M.", reason: "Skipped chore rotation", daysAgo: 9 },
      { client: "Dana L.", reason: "Late check-in past 8pm", daysAgo: 6 },
      { client: "Evan P.", reason: "Conflict with another resident", daysAgo: 8 },
      { client: "Carl M.", reason: "Missed AM meeting", daysAgo: 12 },
    ];
    const today = new Date();
    const batch = writeBatch(db);
    for (const r of records) {
      const dt = new Date(today.getTime() - r.daysAgo * 86400000);
      const ref = doc(collection(db, "selfEvaluations"));
      batch.set(ref, {
        clientName: r.client,
        reason: r.reason,
        dateGiven: Timestamp.fromDate(dt),
        givenBy: "Daniel S.",
        dateResolved: null,
        createdAt: serverTimestamp(),
        createdBy: auth.currentUser.email,
      });
    }
    await batch.commit();
    await logAccess(AUDIT_ACTIONS.CREATE, "selfEvaluation", null, { kind: "seed", count: records.length });
  } catch (err) {
    alert(`Seed failed: ${err.message}`);
  } finally {
    seedBtn.disabled = false;
  }
});

// ----- Client master record -----
//
// clientId format is {PREFIX}-{N digits}, random not sequential. Decision
// recorded in the plan section 12.2: random reduces the risk of clients
// typing one digit off and landing on another client's account once
// self-service login ships. Format constants + generateClientId() live in
// config.js so they stay in sync across app, Functions, and rules.

// Saves the full intake bundle in a single Firestore transaction. Two
// modes, dispatched by `opts.existingClientId`:
//
//   New client (default): generates a random clientId, retries on
//   collision, sets clients/{cid}, sensitive/identity, sensitive/medical,
//   then the per-intake event docs.
//
//   Re-entry (opts.existingClientId set): reads the existing master to
//   bump intakeCount and lastIntakeDate, preserves createdAt / createdBy
//   / firstIntakeDate / photoPath (unless a new photo is uploaded after
//   the txn), overwrites sensitive/identity + sensitive/medical with the
//   submitted values, and creates new per-intake event docs.
//
// Bundle (per intake event):
//   master       → clients/{cid}                (set or merged on master)
//   identity     → clients/{cid}/sensitive/identity
//   medical      → clients/{cid}/sensitive/medical
//   intake       → intakes/{auto}               (new doc per intake event)
//   drugTest     → drugTests/{auto}             (new doc per intake event)
//   medications  → medications/{auto} × N       (new docs per intake event)
//   photoConsent → clients/{cid}/consents/{auto}
//   odh206       → clients/{cid}/odh206/{auto}
async function createClient(bundle = {}, opts = {}) {
  if (opts.existingClientId) {
    return await saveReentryIntake(opts.existingClientId, bundle);
  }
  return await createNewClient(bundle, opts.maxAttempts || 10);
}

// Pre-allocates refs and writes the per-intake event docs (intake,
// drugTest, medications, consent, odh206) inside the supplied
// transaction. Returns { intakeId } for callers that need it.
function writeIntakeEventDocs(txn, clientId, bundle) {
  const { intake, drugTest, medications = [], photoConsent, odh206 } = bundle;
  const intakeRef = intake ? doc(collection(db, "intakes")) : null;
  const drugTestRef = drugTest ? doc(collection(db, "drugTests")) : null;
  const medRefs = medications.map(() => doc(collection(db, "medications")));
  const photoConsentRef = photoConsent
    ? doc(collection(db, "clients", clientId, "consents"))
    : null;
  const odh206Ref = odh206
    ? doc(collection(db, "clients", clientId, "odh206"))
    : null;

  if (drugTestRef) {
    txn.set(drugTestRef, {
      ...drugTest,
      clientId,
      intakeId: intakeRef ? intakeRef.id : null,
    });
  }
  medRefs.forEach((ref, i) => {
    txn.set(ref, {
      ...medications[i],
      clientId,
      intakeId: intakeRef ? intakeRef.id : null,
    });
  });
  if (photoConsentRef) {
    txn.set(photoConsentRef, { ...photoConsent, consentType: "photoVideo", clientId });
  }
  if (odh206Ref) {
    txn.set(odh206Ref, { ...odh206, clientId });
  }
  if (intakeRef) {
    txn.set(intakeRef, {
      ...intake,
      clientId,
      drugTestId: drugTestRef ? drugTestRef.id : null,
      medicationIds: medRefs.map((r) => r.id),
      photoConsentId: photoConsentRef ? photoConsentRef.id : null,
      odh206AuthIds: odh206Ref ? [odh206Ref.id] : [],
    });
  }
  return { intakeId: intakeRef ? intakeRef.id : null };
}

async function createNewClient(bundle, maxAttempts) {
  const { master, identity, medical } = bundle;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const clientId = generateClientId();
    let collided = false;
    let intakeId = null;
    await runTransaction(db, async (txn) => {
      const masterRef = doc(db, "clients", clientId);
      const snap = await txn.get(masterRef);
      if (snap.exists()) { collided = true; return; }
      txn.set(masterRef, {
        ...master,
        clientId,
        createdAt: serverTimestamp(),
        createdBy: auth.currentUser.email,
      });
      if (identity) {
        txn.set(doc(db, "clients", clientId, "sensitive", "identity"), identity);
      }
      if (medical) {
        txn.set(doc(db, "clients", clientId, "sensitive", "medical"), medical);
      }
      ({ intakeId } = writeIntakeEventDocs(txn, clientId, bundle));
    });
    if (!collided) return { clientId, intakeId };
  }
  throw new Error(`Could not generate a unique clientId after ${maxAttempts} attempts`);
}

async function saveReentryIntake(clientId, bundle) {
  const { master, identity, medical } = bundle;
  let intakeId = null;
  await runTransaction(db, async (txn) => {
    const masterRef = doc(db, "clients", clientId);
    const masterSnap = await txn.get(masterRef);
    if (!masterSnap.exists()) {
      throw new Error(`Client ${clientId} no longer exists.`);
    }
    const prior = masterSnap.data();
    const existingIntakeCount = typeof prior.intakeCount === "number" ? prior.intakeCount : 0;

    // Overwrite master with submitted values, but preserve provenance and
    // append-only fields. photoPath stays as-is unless uploadIntakeMedia
    // patches it after the txn (only when a new photo blob is captured).
    //
    // documents / benefits / milestones are MERGED — the intake form covers
    // most documents and all benefits, but milestones and a few documents
    // (voterRegistration, healthcare connections, housing/job/etc.) only
    // come from the status-update form. Naive overwrite would wipe those.
    // Intake-mentioned keys override prior values; unmentioned keys survive.
    const mergedDocuments = { ...(prior.documents || {}), ...(master.documents || {}) };
    const mergedBenefits = { ...(prior.benefits || {}), ...(master.benefits || {}) };
    const mergedMilestones = prior.milestones || {};
    txn.set(masterRef, {
      ...master,
      clientId,
      createdAt: prior.createdAt,
      createdBy: prior.createdBy,
      // master.firstIntakeDate / .lastIntakeDate come from the submitted
      // master payload (intake form's intakeDate field). saveReentryIntake
      // preserves prior.firstIntakeDate if it already exists; otherwise
      // the submitted value lands as the first-intake date.
      firstIntakeDate: prior.firstIntakeDate || master.firstIntakeDate,
      lastIntakeDate: master.lastIntakeDate,
      intakeCount: existingIntakeCount + 1,
      photoPath: prior.photoPath || null,
      documents: mergedDocuments,
      benefits: mergedBenefits,
      milestones: mergedMilestones,
    });

    if (identity) {
      txn.set(doc(db, "clients", clientId, "sensitive", "identity"), identity);
    }
    if (medical) {
      txn.set(doc(db, "clients", clientId, "sensitive", "medical"), medical);
    }

    ({ intakeId } = writeIntakeEventDocs(txn, clientId, bundle));
  });
  return { clientId, intakeId };
}

// ----- Clients list (live snapshot + client-side search filter) -----
//
// State + listener mechanics live in shared/clients-store.js. App.js still
// owns the Clients TAB rendering (renderClients) and the side-effect hooks
// into Client Detail / Roster / Schedule / Reports — both wired below as
// store subscribers. Each side-effect hook retires as its owning feature
// moves to its own module.

function startClientsListener() {
  if (!clientsBody) return;
  storeStartClientsListener();
}

// Top-level store subscribers — registered once at module load. The store
// only fires them when its listener is active, so the lifetime matches the
// snapshot stream automatically.
subscribeClientsStore((clients) => {
  renderClients();
  // Refresh the open client-detail panel's bed + program sections so changes
  // made elsewhere (by another staff or by the program-save handler itself)
  // show without closing/reopening. typeof guards retire as Beds + Client
  // Detail move in Phases 2.5 / 2.7+.
  if (currentDetailClientId) {
    const c = clients.find((c) => c.id === currentDetailClientId);
    if (c) {
      if (typeof renderClientBedAssignment === "function") {
        renderClientBedAssignment(currentDetailClientId, c.data);
      }
      if (typeof renderClientProgram === "function") {
        renderClientProgram(currentDetailClientId, c.data);
      }
    }
  }
  // First snapshot fire after sign-in bootstraps the lazy-init features.
  // These typeof guards retire in Phase 2.6 (Roster + Schedule + Reports).
  if (typeof tryInitRoster === "function") tryInitRoster();
  if (typeof tryInitSchedules === "function") tryInitSchedules();
  if (typeof tryInitReports === "function") tryInitReports();
});

subscribeClientsStoreError((err) => {
  if (clientsBody) {
    clientsBody.innerHTML = `<tr class="empty"><td colspan="8">Could not load: ${escapeHtml(err.message)}</td></tr>`;
  }
});

function renderClients() {
  const needle = clientsSearchText.trim().toLowerCase();
  const filtered = cachedClients.filter((c) => clientMatchesSearch(c, needle));
  if (clientsCountEl) {
    clientsCountEl.textContent = needle
      ? `${filtered.length} of ${cachedClients.length}`
      : `${cachedClients.length} total`;
  }
  if (cachedClients.length === 0) {
    clientsBody.innerHTML = `<tr class="empty"><td colspan="8">No clients yet — create one from the New Intake tab.</td></tr>`;
    return;
  }
  if (filtered.length === 0) {
    clientsBody.innerHTML = `<tr class="empty"><td colspan="8">No clients match that search.</td></tr>`;
    return;
  }
  // Group active clients above exited so staff can scan to the people they're
  // working with day-to-day. Within each group, preserve the createdAt-desc
  // order from the Firestore query (most recent intake first).
  const activeRows = [];
  const exitedRows = [];
  for (const c of filtered) {
    if (c.data.status === "active") activeRows.push(c);
    else exitedRows.push(c);
  }
  const renderClientRow = (c) => {
    const data = c.data;
    const fullName = [data.firstName, data.middleName, data.lastName].filter(Boolean).join(" ");
    const aliasSuffix = data.alias ? ` <span class="muted">(${escapeHtml(data.alias)})</span>` : "";
    const dob = fmtDate(data.dob) || "";
    const lastIntake = fmtDate(data.lastIntakeDate) || "";
    const bedId = data.bedAssignment?.bedId || "";
    const bedCell = bedId
      ? `<span class="bed-tag">${escapeHtml(bedId)}</span>`
      : `<span class="muted">—</span>`;
    const lvlKey = data.level || "alpha";
    const onProb = isOnProbation(data);
    const levelCell = `<span class="level-chip level-${lvlKey} ${onProb ? "on-probation" : ""}">${escapeHtml(levelDisplay(data))}</span>`;
    const leadershipCell = data.leadershipRole && LEADERSHIP_ROLES[data.leadershipRole]
      ? `<span class="leadership-chip">${escapeHtml(LEADERSHIP_ROLES[data.leadershipRole])}</span>`
      : `<span class="muted">—</span>`;
    return `
      <tr class="client-row" data-cid="${escapeHtml(c.id)}">
        <td><code>${escapeHtml(c.id)}</code></td>
        <td>${escapeHtml(fullName || "(no name)")}${aliasSuffix}</td>
        <td>${escapeHtml(dob)}</td>
        <td>${escapeHtml(data.status || "")}</td>
        <td>${levelCell}</td>
        <td>${leadershipCell}</td>
        <td>${bedCell}</td>
        <td>${escapeHtml(lastIntake)}</td>
      </tr>
    `;
  };
  const sectionHeader = (label, count) => `
    <tr class="client-section-divider"><td colspan="8">${escapeHtml(label)} <span class="muted">(${count})</span></td></tr>`;
  let html = "";
  if (activeRows.length) {
    html += sectionHeader("Active clients", activeRows.length);
    html += activeRows.map(renderClientRow).join("");
  }
  if (exitedRows.length) {
    html += sectionHeader("Exited clients", exitedRows.length);
    html += exitedRows.map(renderClientRow).join("");
  }
  clientsBody.innerHTML = html;
}

if (clientsSearchInput) {
  clientsSearchInput.addEventListener("input", () => {
    setSearchText(clientsSearchInput.value);
    renderClients();
  });
}

if (clientsBody) {
  clientsBody.addEventListener("click", (e) => {
    const row = e.target.closest(".client-row");
    if (!row) return;
    const cid = row.dataset.cid;
    if (cid) openClientDetail(cid);
  });
}

// ----- Tab navigation -----

document.querySelectorAll(".tab-btn").forEach((btn) => {
  btn.addEventListener("click", () => {
    const id = btn.dataset.tab;
    document.querySelectorAll(".tab-btn").forEach((b) => {
      b.classList.toggle("active", b === btn);
    });
    document.querySelectorAll(".tab-content").forEach((c) => {
      c.classList.toggle("active", c.id === `tab-${id}`);
    });
  });
});

// Audit log tab moved to features/audit-log.js. Importing it at top of file
// triggers its self-registration of event handlers.

// ----- Intake Section 1 (Identity) -----
//
// Saves the master clients/{id} doc (default-readable for staff) plus the
// sensitive/identity subdoc (full SSN, full DL/State ID, place of birth,
// on-file flags) — both in one Firestore transaction so they cannot drift.

function normalizeSsnDigits(input) {
  const digits = String(input || "").replace(/\D/g, "");
  if (digits.length !== 9) {
    throw new Error("SSN must be 9 digits");
  }
  return digits;
}

function formatSsn(digits) {
  return `${digits.slice(0, 3)}-${digits.slice(3, 5)}-${digits.slice(5, 9)}`;
}

function maskSsn(digits) {
  return `***-**-${digits.slice(5, 9)}`;
}

function trimOrNull(s) {
  const v = (s || "").toString().trim();
  return v || null;
}

function collectEmergencyContacts(fd) {
  const out = [];
  for (const i of [1, 2]) {
    const name = trimOrNull(fd.get(`ec${i}Name`));
    if (!name) continue;
    out.push({
      name,
      relationship: trimOrNull(fd.get(`ec${i}Relationship`)),
      phone: trimOrNull(fd.get(`ec${i}Phone`)),
    });
  }
  return out;
}

if (intakeForm) {
  intakeForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    intakeStatus.hidden = true;
    intakeStatus.classList.remove("error");

    const fd = new FormData(intakeForm);
    let ssnDigits;
    try {
      ssnDigits = normalizeSsnDigits(fd.get("ssn"));
    } catch (err) {
      showIntakeError(err.message);
      return;
    }
    const dobStr = fd.get("dob");
    const dob = dobStr ? new Date(dobStr + "T00:00:00") : null;
    if (!dob || isNaN(dob)) {
      showIntakeError("Invalid date of birth.");
      return;
    }
    // Intake date is set from the form (defaulted to today) so staff can
    // backfill historical/current clients with their actual intake date.
    // Same timestamp drives intakeDate, drugTest.testDate, and
    // master.firstIntakeDate / .lastIntakeDate.
    const intakeDateStr = fd.get("intakeDate");
    const intakeDateValue = intakeDateStr ? new Date(intakeDateStr + "T00:00:00") : null;
    if (!intakeDateValue || isNaN(intakeDateValue)) {
      showIntakeError("Invalid intake date.");
      return;
    }
    const intakeDateTs = Timestamp.fromDate(intakeDateValue);

    const fullName = [fd.get("firstName"), fd.get("middleName"), fd.get("lastName")]
      .map((s) => (s || "").toString().trim())
      .filter(Boolean)
      .join(" ");

    // Section 2 – demographics
    const raceEthnicity = [...intakeForm.querySelectorAll('input[name="raceEthnicity"]:checked')]
      .map((cb) => cb.value);
    const isAmIndian = raceEthnicity.includes("americanIndian");
    const isVeteran = fd.get("veteran") === "yes";

    // Section 4 – education
    const hsGradStatus = fd.get("hsGradStatus") || null;
    const collegeStatus = fd.get("collegeStatus") || null;
    const educationData = { hsGradStatus, collegeStatus };
    if (hsGradStatus === "yes") {
      const yearStr = fd.get("hsYear");
      educationData.hs = {
        yearCompleted: yearStr ? Number(yearStr) : null,
        graduationDate: trimOrNull(fd.get("hsGraduationDate")),
        location: trimOrNull(fd.get("hsLocation")),
        diplomaOnFile: !!fd.get("hsDiplomaOnFile"),
        transcriptOnFile: !!fd.get("hsTranscriptOnFile"),
      };
    }
    if (collegeStatus === "yes") {
      educationData.college = {
        school: trimOrNull(fd.get("collegeSchool")),
        yearsAttended: trimOrNull(fd.get("collegeYears")),
        diplomaOnFile: !!fd.get("collegeDiplomaOnFile"),
        transcriptOnFile: !!fd.get("collegeTranscriptOnFile"),
      };
    }

    const emergencyContacts = collectEmergencyContacts(fd);

    // Section 6 – history & employment
    const isPreviousGuest = fd.get("previousGuest") === "yes";
    const isPublicHousingApplied = fd.get("publicHousingApplied") === "yes";
    const isEmployed = fd.get("employed") === "yes";
    const employmentSnapshot = isEmployed ? {
      employer: trimOrNull(fd.get("employer")),
      wage: trimOrNull(fd.get("wage")),
      skills: trimOrNull(fd.get("skills")),
    } : null;

    // Section 6 — government benefits. Multi-select with optional monthly
    // amounts. Saved both into intake snapshot (history) and sensitive/medical
    // (current state). Mirrored to master.benefits.{type} for fast reporting.
    const receivesBenefits = fd.get("receivesGovernmentBenefits") || null;
    const governmentBenefitsItems = [];
    if (receivesBenefits === "yes") {
      for (const t of INTAKE_BENEFIT_TYPES) {
        if (fd.get(`benefit_${t}`)) {
          const amtRaw = (fd.get(`benefitAmount_${t}`) || "").toString().trim().replace(/[$,]/g, "");
          const amtNum = amtRaw === "" ? null : Number(amtRaw);
          governmentBenefitsItems.push({
            type: t,
            monthlyAmount: amtNum != null && !isNaN(amtNum) ? amtNum : null,
          });
        }
      }
    }
    const governmentBenefitsData = receivesBenefits ? {
      receiving: receivesBenefits, // "yes" | "no" | "unknown"
      items: governmentBenefitsItems,
      notes: trimOrNull(fd.get("benefitsNotes")),
    } : null;

    // Section 5 – health (sensitive/medical)
    const hasInsurance = fd.get("hasInsurance") || null;
    const medicalData = {
      specialNeeds: trimOrNull(fd.get("specialNeeds")),
      healthInsurance: {
        hasInsurance,
        medicaidNumber: hasInsurance === "yes" ? trimOrNull(fd.get("medicaidNumber")) : null,
        medicareNumber: hasInsurance === "yes" ? trimOrNull(fd.get("medicareNumber")) : null,
        privateNumber: hasInsurance === "yes" ? trimOrNull(fd.get("privateNumber")) : null,
      },
      healthcareHistory: {
        whereTreated: trimOrNull(fd.get("whereTreated")),
        yearOfDiagnosis: trimOrNull(fd.get("yearOfDiagnosis")),
        primaryPhysician: trimOrNull(fd.get("primaryPhysician")),
        counselor: trimOrNull(fd.get("counselor")),
        pharmacy: trimOrNull(fd.get("pharmacy")),
      },
      governmentBenefits: governmentBenefitsData,
      updatedAt: serverTimestamp(),
      updatedBy: auth.currentUser.email,
    };

    // Mirror current state to master.{documents,benefits} so the Clients tab
    // and Reports can read "do they have X / are they receiving Y" without
    // joining sensitive subdocs. Status updates write to the same maps. On
    // re-entry, saveReentryIntake() merges these with the prior client's
    // values so status-update-only entries (voterRegistration, milestones,
    // etc.) survive the intake save.
    const isReentryNow = !!reentryClientId;
    const benefitsMirror = {};
    for (const item of governmentBenefitsItems) {
      benefitsMirror[item.type] = {
        receiving: true,
        monthlyAmount: item.monthlyAmount,
        since: serverTimestamp(),
        source: isReentryNow ? "intake-reentry" : "intake",
      };
    }
    const documentsMirror = {};
    const recordDoc = (key, onFile) => {
      if (onFile) {
        documentsMirror[key] = {
          obtained: true,
          obtainedOn: serverTimestamp(),
          source: isReentryNow ? "intake-reentry" : "intake",
        };
      }
    };
    recordDoc("birthCertificate", !!fd.get("hasBirthCertOnFile"));
    recordDoc("socialSecurityCard", !!fd.get("hasSSCOnFile"));
    recordDoc("stateId", !!fd.get("hasDLOnFile"));
    if (isVeteran) {
      recordDoc("vaCard", !!fd.get("vaCardOnFile"));
      recordDoc("dd214", !!fd.get("dd214OnFile"));
    }
    if (hsGradStatus === "yes") {
      recordDoc("hsDiploma", !!fd.get("hsDiplomaOnFile"));
      recordDoc("hsTranscript", !!fd.get("hsTranscriptOnFile"));
    }
    if (collegeStatus === "yes") {
      recordDoc("collegeDiploma", !!fd.get("collegeDiplomaOnFile"));
      recordDoc("collegeTranscript", !!fd.get("collegeTranscriptOnFile"));
    }
    if (hasInsurance === "yes") recordDoc("medicalInsurance", true);

    // Every intake (new or re-entry) starts the client on Alpha with a fresh
    // 14-day probation clock. saveReentryIntake passes masterData straight
    // through, so re-entries also reset to Alpha-Probation — clients earn
    // their level by progressing in the program; coming back means starting
    // the clock over. Staff can override on the Program fieldset later.
    const probationUntilDate = new Date();
    probationUntilDate.setDate(probationUntilDate.getDate() + PROBATION_DEFAULT_DAYS);

    const masterData = {
      firstName: (fd.get("firstName") || "").toString().trim(),
      middleName: trimOrNull(fd.get("middleName")),
      lastName: (fd.get("lastName") || "").toString().trim(),
      alias: trimOrNull(fd.get("alias")),
      dob: Timestamp.fromDate(dob),
      maritalStatus: fd.get("maritalStatus"),
      raceEthnicity,
      hispanicLatino: fd.get("hispanicLatino") || null,
      tribe: isAmIndian ? trimOrNull(fd.get("tribe")) : null,
      cdibCard: isAmIndian ? !!fd.get("cdibCard") : false,
      veteran: isVeteran,
      contact: {
        phone: trimOrNull(fd.get("phone")),
        email: trimOrNull(fd.get("email")),
      },
      emergencyContacts,
      currentEmployment: employmentSnapshot,
      ssnLast4: ssnDigits.slice(5, 9),
      status: "active",
      intakeCount: 1,
      firstIntakeDate: intakeDateTs,
      lastIntakeDate: intakeDateTs,
      documents: documentsMirror,
      benefits: benefitsMirror,
      level: "alpha",
      probationUntil: Timestamp.fromDate(probationUntilDate),
      probationReason: "initial intake",
      leadershipRole: null,
    };

    const identityData = {
      ssnFull: ssnDigits,
      ssnFormatted: formatSsn(ssnDigits),
      placeOfBirth: trimOrNull(fd.get("placeOfBirth")),
      driversLicense: {
        state: (fd.get("dlState") || "").toString().trim().toUpperCase() || null,
        number: trimOrNull(fd.get("dlNumber")),
      },
      stateID: {
        state: (fd.get("stateIdState") || "").toString().trim().toUpperCase() || null,
        number: trimOrNull(fd.get("stateIdNumber")),
      },
      hasBirthCertOnFile: !!fd.get("hasBirthCertOnFile"),
      hasSSCOnFile: !!fd.get("hasSSCOnFile"),
      hasDLOnFile: !!fd.get("hasDLOnFile"),
      veteranInfo: isVeteran ? {
        militaryBranch: trimOrNull(fd.get("militaryBranch")),
        yearsServed: trimOrNull(fd.get("yearsServed")),
        vaCardOnFile: !!fd.get("vaCardOnFile"),
        dd214OnFile: !!fd.get("dd214OnFile"),
      } : null,
      updatedAt: serverTimestamp(),
      updatedBy: auth.currentUser.email,
    };

    const intakeData = {
      staffEmail: auth.currentUser.email,
      intakeDate: intakeDateTs,
      reentry: !!reentryClientId,
      demographics: {
        raceEthnicity,
        hispanicLatino: fd.get("hispanicLatino") || null,
        tribe: isAmIndian ? trimOrNull(fd.get("tribe")) : null,
        cdibCard: isAmIndian ? !!fd.get("cdibCard") : false,
        veteran: isVeteran,
      },
      contact: {
        phone: trimOrNull(fd.get("phone")),
        email: trimOrNull(fd.get("email")),
        emergencyContacts,
      },
      education: educationData,
      health: {
        hasInsurance,
      },
      history: {
        previousGuest: isPreviousGuest,
        previousIntakeDate: isPreviousGuest ? trimOrNull(fd.get("previousIntakeDate")) : null,
        homelessDuration: fd.get("homelessDuration") || null,
        publicHousingApplied: isPublicHousingApplied,
        publicHousingWhen: isPublicHousingApplied ? trimOrNull(fd.get("publicHousingWhen")) : null,
        publicHousingWhere: isPublicHousingApplied ? trimOrNull(fd.get("publicHousingWhere")) : null,
      },
      employment: {
        employed: isEmployed,
        ...(employmentSnapshot || {}),
      },
      governmentBenefits: governmentBenefitsData,
      substanceUse: {
        firstUsedDate: trimOrNull(fd.get("firstUsedDate")),
        lastUsedDate: trimOrNull(fd.get("lastUsedDate")),
        lastDrug: trimOrNull(fd.get("lastDrug")),
      },
      legalIssues: trimOrNull(fd.get("legalIssues")),
      acknowledgesExitInterview: !!fd.get("acknowledgesExitInterview"),
    };

    // Section 8 — drug test. testDate matches the intake date so a
    // backfilled client carries the right historical date on this record too.
    const drugTestData = {
      panelResults: collectDrugPanelResults(),
      admittedToOtherDrugs: fd.get("admittedToOtherDrugs") || null,
      guestAgreesWithResults: fd.get("guestAgreesWithResults") || null,
      observerName: trimOrNull(fd.get("observerName")),
      testDate: intakeDateTs,
      enteredBy: auth.currentUser.email,
    };

    // Section 8 — medications (denormalized name/reasons/sideEffects from
    // catalog so reports don't have to join; staff can override customReason)
    const medicationsData = selectedMedications.map((m) => ({
      medicationName: m.name,
      catalogId: m.catalogId,
      reasonForMedication: m.reasonsForMedication,
      sideEffects: m.sideEffects,
      customReason: trimOrNull(m.customReason),
      dosage: trimOrNull(m.dosage),
      frequency: trimOrNull(m.frequency),
      startDate: serverTimestamp(),
      endDate: null,
    }));

    // Section 8 — photo/video consent
    const photoVideoStatus = fd.get("photoVideoConsent");
    const photoConsentData = photoVideoStatus ? {
      status: photoVideoStatus,
      effectiveDate: serverTimestamp(),
      enteredBy: auth.currentUser.email,
    } : null;

    // Section 8 — ODH 206
    const odh206Signed = fd.get("odh206Signed");
    const odh206Info = [...intakeForm.querySelectorAll('input[name="odh206Info"]:checked')]
      .map((cb) => cb.value);
    if (odh206Signed === "yes"
        && odh206Info.includes("psychotherapyNotes")
        && odh206Info.length > 1) {
      showIntakeError("ODH 206: psychotherapy notes must be on a separate authorization. Uncheck the other categories or uncheck psychotherapy notes.");
      return;
    }
    let odh206Data = null;
    if (odh206Signed === "yes") {
      const expDateStr = fd.get("odh206ExpirationDate");
      odh206Data = {
        disclosingParty: trimOrNull(fd.get("odh206DisclosingParty")),
        receivingParty: trimOrNull(fd.get("odh206ReceivingParty")) || TENANT.orgName,
        purpose: trimOrNull(fd.get("odh206Purpose")),
        expirationDate: expDateStr ? Timestamp.fromDate(new Date(expDateStr + "T00:00:00")) : null,
        expirationEvent: trimOrNull(fd.get("odh206ExpirationEvent")),
        infoShared: {
          general: odh206Info.includes("general"),
          mentalHealth: odh206Info.includes("mentalHealth"),
          substanceAbuse: odh206Info.includes("substanceAbuse"),
          psychotherapyNotes: odh206Info.includes("psychotherapyNotes"),
        },
        textReviewedByClient: fd.get("odh206TextReviewed") === "yes",
        signedAt: serverTimestamp(),
        enteredBy: auth.currentUser.email,
      };
    } else if (odh206Signed === "declined") {
      odh206Data = {
        status: "declined",
        signedAt: serverTimestamp(),
        enteredBy: auth.currentUser.email,
      };
    }

    const submitBtn = document.getElementById("intake-submit");
    submitBtn.disabled = true;
    const isReentry = !!reentryClientId;
    try {
      const { clientId, intakeId } = await createClient({
        master: masterData,
        identity: identityData,
        medical: medicalData,
        intake: intakeData,
        drugTest: drugTestData,
        medications: medicationsData,
        photoConsent: photoConsentData,
        odh206: odh206Data,
      }, { existingClientId: reentryClientId });
      const clientAction = isReentry ? AUDIT_ACTIONS.UPDATE : AUDIT_ACTIONS.CREATE;
      await logAccess(clientAction, "client", clientId, { source: "intake-sections-1-8", reentry: isReentry });
      await logAccess(clientAction, "identity", clientId, { reentry: isReentry });
      await logAccess(clientAction, "medical", clientId, { reentry: isReentry });
      await logAccess(AUDIT_ACTIONS.CREATE, "intake", intakeId, { clientId, reentry: isReentry });
      await logAccess(AUDIT_ACTIONS.CREATE, "drugTest", null, { clientId, intakeId });
      if (medicationsData.length) {
        await logAccess(AUDIT_ACTIONS.CREATE, "medications", null, {
          clientId, intakeId, count: medicationsData.length,
        });
      }
      if (photoConsentData) {
        await logAccess(AUDIT_ACTIONS.CREATE, "consent", clientId, {
          consentType: "photoVideo", status: photoVideoStatus,
        });
      }
      if (odh206Data) {
        await logAccess(AUDIT_ACTIONS.CREATE, "odh206", clientId, {
          status: odh206Signed,
        });
      }

      // Upload media (photo + signatures) after Firestore commits.
      const uploadResults = await uploadIntakeMedia({ clientId, intakeId });
      if (uploadResults.photoPath) {
        await logAccess(AUDIT_ACTIONS.CREATE, "photo", clientId, { path: uploadResults.photoPath });
      }
      if (uploadResults.guestSigPath) {
        await logAccess(AUDIT_ACTIONS.CREATE, "signature", intakeId, {
          clientId, role: "guest", path: uploadResults.guestSigPath,
        });
      }
      if (uploadResults.staffSigPath) {
        await logAccess(AUDIT_ACTIONS.CREATE, "signature", intakeId, {
          clientId, role: "staff", path: uploadResults.staffSigPath,
        });
      }

      const successHeading = document.querySelector("#intake-success h3");
      if (successHeading) successHeading.textContent = isReentry ? "Re-entry intake saved" : "Client created";
      showIntakeSuccess(clientId, intakeId, fullName, ssnDigits, uploadResults);
      // Generate the client login PIN (plan §14.1). Re-entry mints a fresh
      // PIN, invalidating the prior one. Failure is non-fatal — intake is
      // committed; staff can use Reset PIN on the client detail page.
      const pinEl = document.getElementById("success-pin");
      if (pinEl) {
        pinEl.textContent = "Generating…";
        pinEl.classList.remove("error");
        pinEl.classList.add("loading");
      }
      const pin = await provisionClientPin(clientId, fullName);
      if (pinEl) {
        pinEl.classList.remove("loading", "error");
        if (pin) {
          pinEl.textContent = pin;
        } else {
          pinEl.textContent = "Generation failed — use Reset PIN on the client detail page.";
          pinEl.classList.add("error");
        }
      }
      resetIntakeForm();
      // Clearing the picker fires onChange(null) → endReentry, which
      // resets the banner and submit-button label. Order matters: clear
      // the picker AFTER resetIntakeForm so endReentry's safety reset
      // doesn't overwrite the success card display.
      intakeReentryPicker?.clear();
    } catch (err) {
      showIntakeError(err.message || "Save failed.");
    } finally {
      submitBtn.disabled = false;
    }
  });
}

function showIntakeError(msg) {
  intakeStatus.textContent = msg;
  intakeStatus.classList.remove("status");
  intakeStatus.classList.add("error");
  intakeStatus.hidden = false;
}

function showIntakeSuccess(clientId, intakeId, fullName, ssnDigits, uploads = null) {
  lastCreatedClientId = clientId;
  successCid.textContent = clientId;
  const successIid = document.getElementById("success-iid");
  if (successIid) successIid.textContent = intakeId || "(none)";
  successName.textContent = fullName;
  successSsn.textContent = maskSsn(ssnDigits);
  successSsnReveal.disabled = false;
  successSsnReveal.textContent = "Show full SSN";
  successSsnNote.hidden = true;

  // Uploads summary + photo thumbnail
  const uploadsEl = document.getElementById("success-uploads");
  const photoEl = document.getElementById("success-photo");
  if (uploadsEl) {
    if (uploads) {
      const parts = [];
      if (uploads.photoPath) parts.push("photo");
      if (uploads.guestSigPath) parts.push("guest signature");
      if (uploads.staffSigPath) parts.push("staff signature");
      uploadsEl.textContent = parts.length ? `Uploaded: ${parts.join(", ")}` : "No media captured";
      if (uploads.errors?.length) {
        uploadsEl.textContent += ` — errors: ${uploads.errors.join("; ")}`;
      }
    } else {
      uploadsEl.textContent = "";
    }
  }
  if (photoEl) {
    if (uploads?.photoPath) {
      // Display the in-memory blob immediately rather than waiting for a
      // signed Storage URL — the blob is what we just uploaded.
      photoEl.src = photoBlob ? URL.createObjectURL(photoBlob) : "";
      photoEl.hidden = !photoEl.src;
    } else {
      photoEl.hidden = true;
      photoEl.src = "";
    }
  }

  intakeSuccess.hidden = false;
  intakeSuccess.scrollIntoView({ behavior: "smooth", block: "nearest" });
}

// ----- Conditional sub-sections -----

function bindConditional(triggerSelector, conditionalId, predicate) {
  const trigger = document.querySelector(triggerSelector);
  const panel = document.getElementById(conditionalId);
  if (!trigger || !panel) return;
  const recompute = () => { panel.hidden = !predicate(); };
  if (trigger.tagName === "SELECT" || trigger.type === "checkbox" || trigger.type === "radio") {
    trigger.addEventListener("change", recompute);
  }
  recompute();
}

// American Indian → tribe + CDIB
const amIndianCheckbox = document.querySelector('input[name="raceEthnicity"][value="americanIndian"]');
const amIndianPanel = document.getElementById("conditional-amindian");
if (amIndianCheckbox && amIndianPanel) {
  const sync = () => { amIndianPanel.hidden = !amIndianCheckbox.checked; };
  amIndianCheckbox.addEventListener("change", sync);
  sync();
}

// Veteran → military branch + VA card + DD214
bindConditional(
  'select[name="veteran"]',
  "conditional-veteran",
  () => document.querySelector('select[name="veteran"]').value === "yes"
);

// HS / GED grad → details
bindConditional(
  'select[name="hsGradStatus"]',
  "conditional-hs-grad",
  () => document.querySelector('select[name="hsGradStatus"]').value === "yes"
);

// College / trade → details
bindConditional(
  'select[name="collegeStatus"]',
  "conditional-college",
  () => document.querySelector('select[name="collegeStatus"]').value === "yes"
);

// Section 5 — has insurance → Medicaid/Medicare/Private numbers
bindConditional(
  'select[name="hasInsurance"]',
  "conditional-insurance",
  () => document.querySelector('select[name="hasInsurance"]').value === "yes"
);

// Section 6 — previous guest → date of prior intake
bindConditional(
  'select[name="previousGuest"]',
  "conditional-previous-guest",
  () => document.querySelector('select[name="previousGuest"]').value === "yes"
);

// Section 6 — applied for public housing → when/where
bindConditional(
  'select[name="publicHousingApplied"]',
  "conditional-public-housing",
  () => document.querySelector('select[name="publicHousingApplied"]').value === "yes"
);

// Section 6 — receives government benefits → benefits checklist
bindConditional(
  'select[name="receivesGovernmentBenefits"]',
  "conditional-government-benefits",
  () => document.querySelector('select[name="receivesGovernmentBenefits"]').value === "yes"
);

// Section 6 — currently employed → employer/wage/skills
bindConditional(
  'select[name="employed"]',
  "conditional-employed",
  () => document.querySelector('select[name="employed"]').value === "yes"
);

// Section 8 — ODH 206 signed=yes → details panel
bindConditional(
  'select[name="odh206Signed"]',
  "conditional-odh206",
  () => document.querySelector('select[name="odh206Signed"]').value === "yes"
);

// ----- Section 8: Drug screen 15-panel -----
//
// Source: admin_automation/intake_forms/Drug Screen.csv
// 14-panel by GSO's labeling, but ETG (alcohol) makes it 15 substances.

const DRUG_PANEL = [
  ["AMP", "Amphetamine"],
  ["BAR", "Barbiturates"],
  ["BUP", "Buprenorphine"],
  ["BZO", "Benzodiazepines"],
  ["COC", "Cocaine"],
  ["MET", "Methamphetamine"],
  ["MDMA", "Methylene-dioxymethamphetamine"],
  ["MTD", "Methadone"],
  ["OPI", "Opiates"],
  ["OXY", "Oxycodone"],
  ["PCP", "Phencyclidine"],
  ["PPX", "Propoxyphene"],
  ["TCA", "Tricyclic Antidepressant"],
  ["THC", "Tetrahydrocannabinol"],
  ["ETG", "Alcohol (Ethylglucuronide)"],
];

(function renderDrugPanel() {
  const tbody = document.getElementById("drug-panel-body");
  if (!tbody) return;
  tbody.innerHTML = DRUG_PANEL.map(([code, label]) => `
    <tr>
      <td>${code} <span class="muted">(${escapeHtml(label)})</span></td>
      <td><input type="radio" name="drug-${code}" value="negative" /></td>
      <td><input type="radio" name="drug-${code}" value="positive" /></td>
      <td><input type="radio" name="drug-${code}" value="faint" /></td>
    </tr>
  `).join("");
})();

// Default the intake-date input to today on first page load. Staff can
// override before saving when backfilling a current or past client.
(function initIntakeDateDefault() {
  if (!intakeForm) return;
  const el = intakeForm.elements.intakeDate;
  if (el && !el.value) el.value = todayLocalDate();
})();

function collectDrugPanelResults() {
  const out = {};
  for (const [code] of DRUG_PANEL) {
    const checked = intakeForm.querySelector(`input[name="drug-${code}"]:checked`);
    out[code] = checked ? checked.value : null;
  }
  return out;
}

// ----- Section 8: Medication picker against the seeded catalog -----

let medicationCatalog = null;
const selectedMedications = []; // { catalogId, name, reasonsForMedication, sideEffects, dosage, frequency, customReason }

async function loadMedicationCatalog() {
  if (medicationCatalog) return medicationCatalog;
  const snap = await getDocs(collection(db, "medicationCatalog"));
  medicationCatalog = snap.docs.map((d) => ({
    id: d.id,
    name: d.data().name || d.id,
    reasonsForMedication: d.data().reasonsForMedication || "",
    sideEffects: d.data().sideEffects || "",
  }));
  medicationCatalog.sort((a, b) => a.name.localeCompare(b.name));
  return medicationCatalog;
}

function filterMedications(q) {
  if (!medicationCatalog) return [];
  const needle = q.toLowerCase().trim();
  if (!needle) return [];
  return medicationCatalog
    .filter((m) => m.name.toLowerCase().includes(needle))
    .slice(0, 10);
}

const medSearch = document.getElementById("med-search");
const medDropdown = document.getElementById("med-search-dropdown");
const medList = document.getElementById("med-list");

function renderMedDropdown(matches) {
  if (matches.length === 0) {
    medDropdown.hidden = true;
    medDropdown.innerHTML = "";
    return;
  }
  medDropdown.innerHTML = matches.map((m) => `
    <div class="picker-item" data-id="${escapeHtml(m.id)}">
      <strong>${escapeHtml(m.name)}</strong>
      <div class="muted">${escapeHtml(m.reasonsForMedication)}</div>
    </div>
  `).join("");
  medDropdown.hidden = false;
}

function renderMedList() {
  if (!medList) return;
  if (selectedMedications.length === 0) {
    medList.innerHTML = "";
    return;
  }
  medList.innerHTML = selectedMedications.map((m, i) => `
    <div class="med-row" data-idx="${i}">
      <div class="med-row-header">
        <strong>${escapeHtml(m.name)}</strong>
        <button type="button" class="ghost ssn-reveal-btn med-remove" data-idx="${i}">Remove</button>
      </div>
      <div class="muted" style="font-size: 0.85rem; margin-bottom: 0.4rem;">
        ${escapeHtml(m.reasonsForMedication)}
      </div>
      <div class="row">
        <label>Dosage <input type="text" data-idx="${i}" data-field="dosage" value="${escapeHtml(m.dosage || "")}" placeholder="e.g. 10 mg" /></label>
        <label>Frequency <input type="text" data-idx="${i}" data-field="frequency" value="${escapeHtml(m.frequency || "")}" placeholder="e.g. once daily, every 6h" /></label>
        <label>Custom reason (overrides catalog)
          <input type="text" data-idx="${i}" data-field="customReason" value="${escapeHtml(m.customReason || "")}" />
        </label>
      </div>
    </div>
  `).join("");
}

if (medSearch) {
  medSearch.addEventListener("focus", async () => {
    await loadMedicationCatalog().catch(() => {});
    if (medSearch.value) renderMedDropdown(filterMedications(medSearch.value));
  });
  medSearch.addEventListener("input", async () => {
    if (!medicationCatalog) {
      await loadMedicationCatalog().catch(() => {});
    }
    renderMedDropdown(filterMedications(medSearch.value));
  });
  medSearch.addEventListener("blur", () => {
    setTimeout(() => { medDropdown.hidden = true; }, 150);
  });
}

if (medDropdown) {
  medDropdown.addEventListener("mousedown", (e) => {
    const item = e.target.closest(".picker-item");
    if (!item) return;
    const id = item.dataset.id;
    const med = medicationCatalog?.find((m) => m.id === id);
    if (!med) return;
    if (selectedMedications.some((s) => s.catalogId === med.id)) {
      medSearch.value = "";
      medDropdown.hidden = true;
      return;
    }
    selectedMedications.push({
      catalogId: med.id,
      name: med.name,
      reasonsForMedication: med.reasonsForMedication,
      sideEffects: med.sideEffects,
      dosage: "",
      frequency: "",
      customReason: "",
    });
    renderMedList();
    medSearch.value = "";
    medDropdown.hidden = true;
  });
}

if (medList) {
  medList.addEventListener("input", (e) => {
    const idx = Number(e.target.dataset.idx);
    const field = e.target.dataset.field;
    if (Number.isInteger(idx) && field && selectedMedications[idx]) {
      selectedMedications[idx][field] = e.target.value;
    }
  });
  medList.addEventListener("click", (e) => {
    const btn = e.target.closest(".med-remove");
    if (!btn) return;
    const idx = Number(btn.dataset.idx);
    if (Number.isInteger(idx)) {
      selectedMedications.splice(idx, 1);
      renderMedList();
    }
  });
}

// ----- "+ Add new medication to catalog" modal -----
// Mirrors the docId sanitization in admin/seed-medication-catalog.mjs so a med
// added here lands at the same path the bulk seed would have used (which keeps
// CSV re-seeds merge-compatible if the same name shows up later in the CSV).

function medCatalogDocId(name) {
  return name.replace(/\//g, "-").replace(/[\x00-\x1f]/g, "").slice(0, 1000);
}

const medAddBtn = document.getElementById("med-add-new-btn");
const medAddModal = document.getElementById("med-add-modal");
const medAddBackdrop = document.getElementById("med-add-modal-backdrop");
const medAddName = document.getElementById("med-add-name");
const medAddReasons = document.getElementById("med-add-reasons");
const medAddSideEffects = document.getElementById("med-add-side-effects");
const medAddError = document.getElementById("med-add-error");
const medAddProgress = document.getElementById("med-add-progress");
const medAddCancel = document.getElementById("med-add-cancel");
const medAddConfirm = document.getElementById("med-add-confirm");

function openMedAddModal() {
  if (!medAddModal) return;
  // Prefill name with whatever the staff member typed in the search box,
  // so "amoxicillin" → not found → click "+ Add new" lands them already
  // halfway through the form.
  medAddName.value = (medSearch?.value || "").trim();
  medAddReasons.value = "";
  medAddSideEffects.value = "";
  medAddError.hidden = true;
  medAddError.textContent = "";
  medAddProgress.hidden = true;
  medAddConfirm.disabled = false;
  medAddModal.hidden = false;
  setTimeout(() => medAddName.focus(), 0);
}

function closeMedAddModal() {
  if (!medAddModal) return;
  medAddModal.hidden = true;
}

if (medAddBtn) medAddBtn.addEventListener("click", openMedAddModal);
if (medAddCancel) medAddCancel.addEventListener("click", closeMedAddModal);
if (medAddBackdrop) medAddBackdrop.addEventListener("click", closeMedAddModal);

if (medAddConfirm) {
  medAddConfirm.addEventListener("click", async () => {
    medAddError.hidden = true;
    medAddError.textContent = "";

    const name = (medAddName.value || "").trim();
    const reasonsForMedication = (medAddReasons.value || "").trim();
    const sideEffects = (medAddSideEffects.value || "").trim();

    if (!name) {
      medAddError.textContent = "Medication name is required.";
      medAddError.hidden = false;
      return;
    }

    await loadMedicationCatalog().catch(() => {});
    const existing = (medicationCatalog || []).find(
      (m) => m.name.toLowerCase() === name.toLowerCase()
    );
    if (existing) {
      medAddError.textContent =
        `"${existing.name}" is already in the catalog. Search for it in the picker above.`;
      medAddError.hidden = false;
      return;
    }

    medAddConfirm.disabled = true;
    medAddProgress.textContent = "Saving…";
    medAddProgress.hidden = false;

    try {
      const docId = medCatalogDocId(name);
      const ref = doc(db, "medicationCatalog", docId);
      await setDoc(ref, {
        name,
        reasonsForMedication,
        sideEffects,
        createdAt: serverTimestamp(),
        createdBy: auth.currentUser?.email || "",
        updatedAt: serverTimestamp(),
      });

      const newEntry = { id: docId, name, reasonsForMedication, sideEffects };
      if (medicationCatalog) {
        medicationCatalog.push(newEntry);
        medicationCatalog.sort((a, b) => a.name.localeCompare(b.name));
      }

      // Auto-add to the current client's selected meds so the staff member
      // doesn't have to re-search for what they just typed.
      selectedMedications.push({
        catalogId: newEntry.id,
        name: newEntry.name,
        reasonsForMedication: newEntry.reasonsForMedication,
        sideEffects: newEntry.sideEffects,
        dosage: "",
        frequency: "",
        customReason: "",
      });
      renderMedList();

      if (medSearch) medSearch.value = "";
      if (medDropdown) medDropdown.hidden = true;
      closeMedAddModal();
    } catch (err) {
      console.error("Add medication failed", err);
      medAddError.textContent = err?.message
        ? `Save failed: ${err.message}`
        : "Save failed.";
      medAddError.hidden = false;
      medAddConfirm.disabled = false;
      medAddProgress.hidden = true;
    }
  });
}

// ----- Section 1 photo capture (webcam + file fallback) -----
//
// Captures a JPEG blob in memory. Uploaded to Cloud Storage after the
// Firestore transaction commits, then master.photoPath is patched.

let photoBlob = null;
let photoStream = null;

const photoStartBtn = document.getElementById("photo-start-btn");
const photoCaptureBtn = document.getElementById("photo-capture-btn");
const photoCancelBtn = document.getElementById("photo-cancel-btn");
const photoRetakeBtn = document.getElementById("photo-retake-btn");
const photoFileInput = document.getElementById("photo-file");
const photoVideo = document.getElementById("photo-video");
const photoPreview = document.getElementById("photo-preview");
const photoVideoSection = document.getElementById("photo-video-section");
const photoPreviewSection = document.getElementById("photo-preview-section");
const photoControls = document.getElementById("photo-controls");
const photoStatus = document.getElementById("photo-status");

function setPhotoStatus(msg, isError = false) {
  if (!photoStatus) return;
  photoStatus.textContent = msg || "";
  photoStatus.classList.toggle("error", isError);
}

async function startCamera() {
  try {
    photoStream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: "user", width: { ideal: 640 }, height: { ideal: 480 } },
      audio: false,
    });
    photoVideo.srcObject = photoStream;
    await photoVideo.play();
    photoVideoSection.hidden = false;
    photoControls.hidden = true;
    photoPreviewSection.hidden = true;
    setPhotoStatus("");
  } catch (err) {
    setPhotoStatus(`Camera unavailable (${err.message}). Use "upload from device" instead.`, true);
  }
}

function stopCamera() {
  if (photoStream) {
    photoStream.getTracks().forEach((t) => t.stop());
    photoStream = null;
  }
  if (photoVideo) photoVideo.srcObject = null;
}

function capturePhoto() {
  if (!photoStream) return;
  const canvas = document.createElement("canvas");
  canvas.width = photoVideo.videoWidth || 640;
  canvas.height = photoVideo.videoHeight || 480;
  canvas.getContext("2d").drawImage(photoVideo, 0, 0, canvas.width, canvas.height);
  canvas.toBlob((blob) => {
    if (!blob) {
      setPhotoStatus("Capture failed. Try again or use file upload.", true);
      return;
    }
    photoBlob = blob;
    photoPreview.src = URL.createObjectURL(blob);
    photoPreviewSection.hidden = false;
    photoVideoSection.hidden = true;
    stopCamera();
    setPhotoStatus(`Photo captured (${Math.round(blob.size / 1024)} KB).`);
  }, "image/jpeg", 0.85);
}

function handlePhotoFile(file) {
  if (!file) return;
  if (!file.type.startsWith("image/")) {
    setPhotoStatus("Please choose an image file.", true);
    return;
  }
  if (file.size > 5 * 1024 * 1024) {
    setPhotoStatus("Image is over 5 MB. Please pick a smaller one or retake.", true);
    return;
  }
  photoBlob = file;
  photoPreview.src = URL.createObjectURL(file);
  photoPreviewSection.hidden = false;
  photoVideoSection.hidden = true;
  setPhotoStatus(`Photo loaded (${Math.round(file.size / 1024)} KB).`);
}

function resetPhotoUI() {
  stopCamera();
  photoBlob = null;
  photoControls.hidden = false;
  photoVideoSection.hidden = true;
  photoPreviewSection.hidden = true;
  if (photoFileInput) photoFileInput.value = "";
  setPhotoStatus("");
}

if (photoStartBtn) photoStartBtn.addEventListener("click", startCamera);
if (photoCaptureBtn) photoCaptureBtn.addEventListener("click", capturePhoto);
if (photoCancelBtn) {
  photoCancelBtn.addEventListener("click", () => {
    stopCamera();
    photoVideoSection.hidden = true;
    photoControls.hidden = false;
  });
}
if (photoRetakeBtn) {
  photoRetakeBtn.addEventListener("click", () => {
    photoBlob = null;
    photoPreviewSection.hidden = true;
    photoControls.hidden = false;
  });
}
if (photoFileInput) {
  photoFileInput.addEventListener("change", (e) => {
    handlePhotoFile(e.target.files?.[0]);
  });
}

// ----- Signature pad component (HTML5 canvas, mouse + touch) -----

class SignaturePad {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d");
    this.drawing = false;
    this.empty = true;
    this.setupSize();
    this.bindEvents();
  }

  setupSize() {
    const dpr = window.devicePixelRatio || 1;
    const rect = this.canvas.getBoundingClientRect();
    const cssWidth = rect.width || this.canvas.width;
    const cssHeight = rect.height || this.canvas.height;
    this.canvas.width = cssWidth * dpr;
    this.canvas.height = cssHeight * dpr;
    this.canvas.style.width = `${cssWidth}px`;
    this.canvas.style.height = `${cssHeight}px`;
    this.ctx.scale(dpr, dpr);
    this.ctx.lineWidth = 2;
    this.ctx.lineCap = "round";
    this.ctx.lineJoin = "round";
    this.ctx.strokeStyle = "#1c1f24";
  }

  bindEvents() {
    const start = (e) => {
      e.preventDefault();
      this.drawing = true;
      this.empty = false;
      const p = this.point(e);
      this.ctx.beginPath();
      this.ctx.moveTo(p.x, p.y);
    };
    const move = (e) => {
      if (!this.drawing) return;
      e.preventDefault();
      const p = this.point(e);
      this.ctx.lineTo(p.x, p.y);
      this.ctx.stroke();
    };
    const end = () => { this.drawing = false; };

    this.canvas.addEventListener("mousedown", start);
    this.canvas.addEventListener("mousemove", move);
    window.addEventListener("mouseup", end);

    this.canvas.addEventListener("touchstart", start, { passive: false });
    this.canvas.addEventListener("touchmove", move, { passive: false });
    this.canvas.addEventListener("touchend", end);
  }

  point(e) {
    const rect = this.canvas.getBoundingClientRect();
    if (e.touches?.[0]) {
      return { x: e.touches[0].clientX - rect.left, y: e.touches[0].clientY - rect.top };
    }
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  }

  clear() {
    this.ctx.save();
    this.ctx.setTransform(1, 0, 0, 1, 0, 0);
    this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    this.ctx.restore();
    this.empty = true;
  }

  isEmpty() { return this.empty; }

  toBlob() {
    if (this.empty) return Promise.resolve(null);
    return new Promise((resolve) => {
      this.canvas.toBlob((blob) => resolve(blob), "image/png");
    });
  }
}

const sigGuestCanvas = document.getElementById("sig-guest");
const sigStaffCanvas = document.getElementById("sig-staff");
const sigGuestPad = sigGuestCanvas ? new SignaturePad(sigGuestCanvas) : null;
const sigStaffPad = sigStaffCanvas ? new SignaturePad(sigStaffCanvas) : null;

const sigGuestClearBtn = document.getElementById("sig-guest-clear");
const sigStaffClearBtn = document.getElementById("sig-staff-clear");
if (sigGuestClearBtn) sigGuestClearBtn.addEventListener("click", () => sigGuestPad?.clear());
if (sigStaffClearBtn) sigStaffClearBtn.addEventListener("click", () => sigStaffPad?.clear());

// ----- Consent modal: reusable popup that displays the full text of a
// consent form and resolves with the client's accept/deny decision. -----

const PHOTO_VIDEO_CONSENT_TEXT = TENANT.photoVideoConsentText;

const ODH206_TEXT = TENANT.odh206FormText;

const consentModal = document.getElementById("consent-modal");
const consentModalTitle = document.getElementById("consent-modal-title");
const consentModalBody = document.getElementById("consent-modal-body");
const consentModalAccept = document.getElementById("consent-modal-accept");
const consentModalDeny = document.getElementById("consent-modal-deny");
const consentModalBackdrop = document.getElementById("consent-modal-backdrop");

function openConsentModal({ title, body, acceptLabel = "I accept", denyLabel = "Decline" }) {
  return new Promise((resolve) => {
    if (!consentModal) { resolve(null); return; }
    consentModalTitle.textContent = title;
    consentModalBody.textContent = body;
    consentModalAccept.textContent = acceptLabel;
    consentModalDeny.textContent = denyLabel;
    consentModalBody.scrollTop = 0;
    consentModal.hidden = false;

    const cleanup = (val) => {
      consentModal.hidden = true;
      consentModalAccept.removeEventListener("click", onAccept);
      consentModalDeny.removeEventListener("click", onDeny);
      consentModalBackdrop?.removeEventListener("click", onBackdrop);
      document.removeEventListener("keydown", onKey);
      resolve(val);
    };
    const onAccept = () => cleanup("accept");
    const onDeny = () => cleanup("deny");
    const onBackdrop = () => cleanup(null);
    const onKey = (e) => { if (e.key === "Escape") cleanup(null); };

    consentModalAccept.addEventListener("click", onAccept);
    consentModalDeny.addEventListener("click", onDeny);
    consentModalBackdrop?.addEventListener("click", onBackdrop);
    document.addEventListener("keydown", onKey);
  });
}

// ----- Photo / video consent: launch modal, store result -----

const photoVideoConsentBtn = document.getElementById("photo-video-consent-btn");
const photoVideoConsentStatus = document.getElementById("photo-video-consent-status");
const photoVideoConsentInput = document.querySelector('input[name="photoVideoConsent"]');

function setPhotoVideoConsentStatus(value) {
  if (!photoVideoConsentStatus || !photoVideoConsentInput) return;
  photoVideoConsentInput.value = value || "";
  photoVideoConsentStatus.classList.remove("muted", "accepted", "denied");
  if (value === "accept") {
    photoVideoConsentStatus.textContent = "Status: Accepted";
    photoVideoConsentStatus.classList.add("accepted");
  } else if (value === "deny") {
    photoVideoConsentStatus.textContent = "Status: Denied";
    photoVideoConsentStatus.classList.add("denied");
  } else {
    photoVideoConsentStatus.textContent = "Not yet reviewed";
    photoVideoConsentStatus.classList.add("muted");
  }
}

if (photoVideoConsentBtn) {
  photoVideoConsentBtn.addEventListener("click", async () => {
    const result = await openConsentModal({
      title: "Photo / Video Release Form",
      body: PHOTO_VIDEO_CONSENT_TEXT,
      acceptLabel: "Accept",
      denyLabel: "Deny",
    });
    if (result === "accept" || result === "deny") setPhotoVideoConsentStatus(result);
  });
}

// ----- ODH 206: read-only modal showing the official authorization text.
// The structured fields below the modal still drive what is actually
// authorized (info shared, purpose, expiration); the modal lets the
// client see the legal language before signing. -----

const odh206ReadBtn = document.getElementById("odh206-read-btn");
const odh206ReadStatus = document.getElementById("odh206-read-status");
const odh206ReviewedInput = document.querySelector('input[name="odh206TextReviewed"]');

if (odh206ReadBtn) {
  odh206ReadBtn.addEventListener("click", async () => {
    const result = await openConsentModal({
      title: TENANT.releaseFormTitle,
      body: ODH206_TEXT,
      acceptLabel: "I have read this",
      denyLabel: "Cancel",
    });
    if (result === "accept") {
      odh206ReviewedInput.value = "yes";
      odh206ReadStatus.textContent = "Reviewed by client";
      odh206ReadStatus.classList.remove("muted");
      odh206ReadStatus.classList.add("reviewed");
    }
  });
}

// ----- Cloud Storage upload helper -----

async function uploadBlobToStorage(path, blob, contentType) {
  const ref = storageRef(storage, path);
  const metadata = contentType ? { contentType } : undefined;
  await uploadBytes(ref, blob, metadata);
  return getDownloadURL(ref);
}

// ----- Post-save uploads (called after createClient transaction commits) -----
//
// We deliberately upload *after* Firestore commits because the storage
// path needs the real clientId and intakeId. Uploads run in parallel but
// failure is non-fatal — the client record is already saved. We patch the
// docs with paths after each upload succeeds.

async function uploadIntakeMedia({ clientId, intakeId }) {
  const results = { photoPath: null, guestSigPath: null, staffSigPath: null, errors: [] };

  const tasks = [];
  if (photoBlob) {
    tasks.push((async () => {
      try {
        const path = `clients/${clientId}/photos/intake-${intakeId}.jpg`;
        await uploadBlobToStorage(path, photoBlob, "image/jpeg");
        await updateDoc(doc(db, "clients", clientId), { photoPath: path });
        results.photoPath = path;
      } catch (err) {
        results.errors.push(`photo: ${err.message}`);
      }
    })());
  }
  if (sigGuestPad && !sigGuestPad.isEmpty()) {
    tasks.push((async () => {
      try {
        const blob = await sigGuestPad.toBlob();
        const path = `clients/${clientId}/signatures/intake-${intakeId}-guest.png`;
        await uploadBlobToStorage(path, blob, "image/png");
        await updateDoc(doc(db, "intakes", intakeId), { guestSignaturePath: path });
        results.guestSigPath = path;
      } catch (err) {
        results.errors.push(`guest signature: ${err.message}`);
      }
    })());
  }
  if (sigStaffPad && !sigStaffPad.isEmpty()) {
    tasks.push((async () => {
      try {
        const blob = await sigStaffPad.toBlob();
        const path = `clients/${clientId}/signatures/intake-${intakeId}-staff.png`;
        await uploadBlobToStorage(path, blob, "image/png");
        await updateDoc(doc(db, "intakes", intakeId), { staffSignaturePath: path });
        results.staffSigPath = path;
      } catch (err) {
        results.errors.push(`staff signature: ${err.message}`);
      }
    })());
  }
  await Promise.all(tasks);
  return results;
}

// Emergency contact 2 — add / remove
const addEmergencyContactBtn = document.getElementById("add-emergency-contact-btn");
const removeEmergencyContactBtn = document.getElementById("remove-emergency-contact-btn");
const ec2Panel = document.getElementById("conditional-ec2");
if (addEmergencyContactBtn && ec2Panel) {
  addEmergencyContactBtn.addEventListener("click", () => {
    ec2Panel.hidden = false;
    addEmergencyContactBtn.hidden = true;
  });
}
if (removeEmergencyContactBtn && ec2Panel && addEmergencyContactBtn) {
  removeEmergencyContactBtn.addEventListener("click", () => {
    ["ec2Name", "ec2Relationship", "ec2Phone"].forEach((name) => {
      const el = document.querySelector(`input[name="${name}"]`);
      if (el) el.value = "";
    });
    ec2Panel.hidden = true;
    addEmergencyContactBtn.hidden = false;
  });
}

if (successSsnReveal) {
  successSsnReveal.addEventListener("click", async () => {
    if (!lastCreatedClientId) return;
    successSsnReveal.disabled = true;
    try {
      const idSnap = await getDoc(
        doc(db, "clients", lastCreatedClientId, "sensitive", "identity")
      );
      if (!idSnap.exists()) throw new Error("identity subdoc missing");
      const formatted = idSnap.data().ssnFormatted || formatSsn(idSnap.data().ssnFull || "");
      successSsn.textContent = formatted;
      await logAccess(AUDIT_ACTIONS.VIEW, "ssn", lastCreatedClientId, { surface: "intake-success-card" });
      successSsnNote.hidden = false;
      if (revealTimer) clearTimeout(revealTimer);
      revealTimer = setTimeout(() => {
        const digits = (formatted || "").replace(/\D/g, "");
        if (digits.length === 9) successSsn.textContent = maskSsn(digits);
        successSsnNote.hidden = true;
        successSsnReveal.disabled = false;
        successSsnReveal.textContent = "Show full SSN";
      }, 8000);
    } catch (err) {
      alert(`Reveal failed: ${err.message}`);
      successSsnReveal.disabled = false;
    }
  });
}

// ============================================================
// Clients tab — detail view
// ============================================================
//
// List rows are rendered by renderClients() (client-side filtering on the
// snapshot listener). Clicking a row opens this detail view: master fields
// always visible, sensitive subdocs (identity + medical) gated behind
// click-to-reveal buttons that each write an `accessLog` view entry. Photo
// loaded via getDownloadURL. Intakes, ODH 206 authorizations, and consents
// are rendered as compact lists for at-a-glance review.

let currentDetailClientId = null;

const RACE_LABELS = {
  americanIndian: "American Indian / Alaska Native",
  asian: "Asian",
  black: "Black or African American",
  pacificIslander: "Native Hawaiian / Pacific Islander",
  white: "White",
  other: "Other",
};
const HISPANIC_LABELS = { yes: "Yes", no: "No", na: "N/A" };
const MARITAL_LABELS = {
  single: "Single", married: "Married", divorced: "Divorced",
  separated: "Separated", widowed: "Widowed",
};
const HOMELESS_LABELS = {
  lt1month: "Less than 1 month",
  "1to6months": "1–6 months",
  "6to12months": "6–12 months",
  "1to2years": "1–2 years",
  "2to5years": "2–5 years",
  gt5years: "More than 5 years",
};
const HSGRAD_LABELS = { yes: "Yes", no: "No", na: "N/A" };
const INSURANCE_LABELS = { yes: "Yes", no: "No", unknown: "Unknown" };
const ODH_INFO_LABELS = {
  general: "General medical records",
  mentalHealth: "Mental-health records",
  substanceAbuse: "Substance-abuse records",
  psychotherapyNotes: "Psychotherapy notes (exclusive)",
};

// fmtDate + fmtTimestamp now live in shared/helpers.js (imported at top).

function isBlank(v) {
  return v === null || v === undefined || v === "" || (Array.isArray(v) && v.length === 0);
}

function kv(label, value, opts = {}) {
  const blank = isBlank(value);
  const display = blank ? (opts.placeholder || "—") : value;
  const cls = blank ? ' class="placeholder"' : "";
  const raw = opts.raw === true;
  const html = raw && !blank ? display : escapeHtml(String(display));
  return `<dt>${escapeHtml(label)}</dt><dd${cls}>${html}</dd>`;
}

function kvBool(label, value) {
  if (value === true) return kv(label, "Yes");
  if (value === false) return kv(label, "No");
  return kv(label, null);
}

function kvLookup(label, value, table) {
  if (isBlank(value)) return kv(label, null);
  return kv(label, table[value] || value);
}

function kvList(label, values, table = null) {
  if (isBlank(values)) return kv(label, null);
  const labels = values.map((v) => (table && table[v]) || v);
  return kv(label, labels.join(", "));
}

// ---------- Client detail: open / close / reset ----------

function resetClientDetailUI() {
  document.getElementById("client-detail-loading").hidden = false;
  document.getElementById("client-detail-error").hidden = true;
  document.getElementById("client-detail-body").hidden = true;
  const photoEl = document.getElementById("client-detail-photo");
  photoEl.hidden = true;
  photoEl.src = "";
  const editBtn = document.getElementById("client-detail-photo-edit");
  if (editBtn) editBtn.hidden = true;
  document.getElementById("client-detail-name").textContent = " ";
  document.getElementById("client-detail-id").textContent = "";
  document.getElementById("client-detail-status-wrap").hidden = true;
  document.getElementById("client-detail-created-wrap").hidden = true;
  document.getElementById("client-detail-intake-count-wrap").hidden = true;
  // Collapse the sensitive reveals back to hidden state
  hideRevealedIdentity();
  hideRevealedMedical();
  // Clear async sections
  document.getElementById("client-intakes").innerHTML = `<p class="note">Loading…</p>`;
  document.getElementById("client-exits").innerHTML = `<p class="note">Loading…</p>`;
  document.getElementById("client-odh206").innerHTML = `<p class="note">Loading…</p>`;
  { const e = document.getElementById("client-phi-records"); if (e) e.innerHTML = `<p class="note">Loading…</p>`; }
  document.getElementById("client-consents").innerHTML = `<p class="note">Loading…</p>`;
  const cioSummary = document.getElementById("client-checkinout-summary");
  if (cioSummary) cioSummary.innerHTML = `<p class="note">Loading…</p>`;
  const cioHistory = document.getElementById("client-checkinout-history");
  if (cioHistory) cioHistory.innerHTML = `<p class="note">Loading history…</p>`;
  const cioStatus = document.getElementById("client-checkinout-status");
  if (cioStatus) { cioStatus.textContent = ""; cioStatus.classList.remove("ok", "error"); }
  const cioOut = document.getElementById("client-checkinout-out");
  const cioIn = document.getElementById("client-checkinout-in");
  if (cioOut) cioOut.disabled = true;
  if (cioIn) cioIn.disabled = true;
  // Hide any reset-PIN displayed for the previous client; never leak a PIN
  // across detail-panel navigations.
  const pinWrap = document.getElementById("client-reset-pin-display");
  if (pinWrap) pinWrap.hidden = true;
  const pinValueEl = document.getElementById("client-reset-pin-value");
  if (pinValueEl) pinValueEl.textContent = "";
  const pinStatusEl = document.getElementById("client-reset-pin-status");
  if (pinStatusEl) { pinStatusEl.textContent = ""; pinStatusEl.classList.remove("ok", "error"); }
}

function showDetailError(msg) {
  const errEl = document.getElementById("client-detail-error");
  errEl.textContent = msg;
  errEl.hidden = false;
  document.getElementById("client-detail-loading").hidden = true;
  document.getElementById("client-detail-body").hidden = true;
}

async function openClientDetail(cid) {
  currentDetailClientId = cid;
  document.getElementById("clients-list-view").hidden = true;
  document.getElementById("client-detail-view").hidden = false;
  resetClientDetailUI();

  await logAccess(AUDIT_ACTIONS.VIEW, "client", cid, { surface: "clients-detail" });

  try {
    const masterSnap = await getDoc(doc(db, "clients", cid));
    if (!masterSnap.exists()) {
      showDetailError(`Client ${cid} not found.`);
      return;
    }
    const master = masterSnap.data();
    renderClientHeader(cid, master);
    renderIdentityMaster(master);
    renderDemographics(master);
    renderClientBedAssignment(cid, master);
    renderClientProgram(cid, master);
    renderContactSection(master);
    document.getElementById("client-detail-loading").hidden = true;
    document.getElementById("client-detail-body").hidden = false;

    if (master.photoPath) loadClientPhoto(master.photoPath);
    loadClientIntakes(cid);
    loadClientExits(cid);
    loadClientDrugTests(cid);
    loadClientStatusUpdates(cid);
    loadClientOdh206(cid);
    loadClientConsents(cid);
    loadClientScannedDocs(cid);
    if (typeof loadClientPhiRecords === "function") loadClientPhiRecords(cid);
    if (typeof loadClientCheckInOut === "function") loadClientCheckInOut(cid);
    if (typeof resetStatusUpdateForm === "function") resetStatusUpdateForm();
  } catch (err) {
    showDetailError(err.message || "Could not load client record.");
  }
}

function closeClientDetail() {
  currentDetailClientId = null;
  document.getElementById("client-detail-view").hidden = true;
  document.getElementById("clients-list-view").hidden = false;
}

const clientDetailBackBtn = document.getElementById("client-detail-back");
if (clientDetailBackBtn) {
  clientDetailBackBtn.addEventListener("click", closeClientDetail);
}

// ---------- Header + master sections ----------

function renderClientHeader(cid, master) {
  const fullName = [master.firstName, master.middleName, master.lastName]
    .filter(Boolean).join(" ") || "(no name)";
  document.getElementById("client-detail-name").textContent = fullName;
  document.getElementById("client-detail-id").textContent = cid;
  if (master.status) {
    document.getElementById("client-detail-status").textContent = master.status;
    document.getElementById("client-detail-status-wrap").hidden = false;
  }
  const created = fmtTimestamp(master.createdAt);
  if (created) {
    document.getElementById("client-detail-created").textContent = created;
    document.getElementById("client-detail-created-wrap").hidden = false;
  }
  if (typeof master.intakeCount === "number") {
    document.getElementById("client-detail-intake-count").textContent = String(master.intakeCount);
    document.getElementById("client-detail-intake-count-wrap").hidden = false;
  }
  const editBtn = document.getElementById("client-detail-photo-edit");
  if (editBtn) {
    editBtn.textContent = master.photoPath ? "Update photo" : "Take photo";
    editBtn.hidden = false;
  }
}

async function loadClientPhoto(photoPath) {
  const photoEl = document.getElementById("client-detail-photo");
  try {
    const url = await getDownloadURL(storageRef(storage, photoPath));
    photoEl.src = url;
    photoEl.hidden = false;
  } catch (err) {
    console.warn("photo load failed:", err);
    photoEl.hidden = true;
  }
}

function renderIdentityMaster(master) {
  const ssnLast4 = master.ssnLast4
    ? `<span class="ssn-display">***-**-${escapeHtml(master.ssnLast4)}</span>`
    : null;
  const html = [
    kv("Full name", [master.firstName, master.middleName, master.lastName].filter(Boolean).join(" ")),
    kv("Alias", master.alias),
    kv("Date of birth", fmtDate(master.dob)),
    kvLookup("Marital status", master.maritalStatus, MARITAL_LABELS),
    kv("SSN (last 4)", ssnLast4, { raw: true, placeholder: "Not on file" }),
  ].join("");
  document.getElementById("client-identity-master").innerHTML = html;
}

function renderDemographics(master) {
  const veteranBool = master.veteran === true ? true : master.veteran === false ? false : null;
  const html = [
    kvList("Race / ethnicity", master.raceEthnicity, RACE_LABELS),
    kvLookup("Hispanic / Latino", master.hispanicLatino, HISPANIC_LABELS),
    kv("Tribe", master.tribe),
    kvBool("CDIB card on file", master.cdibCard),
    kvBool("Veteran", veteranBool),
  ].join("");
  document.getElementById("client-demographics").innerHTML = html;
}

function renderContactSection(master) {
  const contactHtml = [
    kv("Phone", master.contact?.phone),
    kv("Email", master.contact?.email),
  ].join("");
  document.getElementById("client-contact").innerHTML = contactHtml;

  const ecEl = document.getElementById("client-emergency-contacts");
  const contacts = Array.isArray(master.emergencyContacts) ? master.emergencyContacts : [];
  if (contacts.length === 0) {
    ecEl.innerHTML = `<p class="note">None on file.</p>`;
    return;
  }
  ecEl.innerHTML = contacts.map((c) => `
    <div class="ec-row">
      <dl class="kv-grid">
        ${kv("Name", c.name)}
        ${kv("Relationship", c.relationship)}
        ${kv("Phone", c.phone)}
      </dl>
    </div>
  `).join("");
}

// ---------- Sensitive identity reveal ----------

function hideRevealedIdentity() {
  const dl = document.getElementById("client-identity-sensitive");
  if (dl) {
    dl.hidden = true;
    dl.innerHTML = "";
  }
  const btn = document.getElementById("client-reveal-identity");
  const status = document.getElementById("client-reveal-identity-status");
  if (btn) {
    btn.textContent = "Reveal sensitive identity (SSN, IDs, place of birth)";
    btn.disabled = false;
  }
  if (status) {
    status.textContent = "Hidden by default. Each reveal is logged.";
    status.classList.remove("accepted");
    status.classList.add("muted");
  }
}

function renderIdentitySensitive(identity) {
  const ssn = identity.ssnFormatted
    || (identity.ssnFull ? formatSsn(identity.ssnFull) : null);
  const ssnHtml = ssn ? `<span class="ssn-display">${escapeHtml(ssn)}</span>` : null;
  const dl = identity.driversLicense || {};
  const sid = identity.stateID || {};
  const vet = identity.veteranInfo || null;

  const parts = [
    kv("SSN (full)", ssnHtml, { raw: true }),
    kv("Place of birth", identity.placeOfBirth),
    kv("Driver's license", [dl.state, dl.number].filter(Boolean).join(" #")),
    kv("State ID", [sid.state, sid.number].filter(Boolean).join(" #")),
    kvBool("Birth certificate on file", identity.hasBirthCertOnFile),
    kvBool("Social Security card on file", identity.hasSSCOnFile),
    kvBool("DL / State ID on file", identity.hasDLOnFile),
  ];
  if (vet) {
    parts.push(
      kv("Military branch", vet.militaryBranch),
      kv("Years served", vet.yearsServed),
      kvBool("VA card on file", vet.vaCardOnFile),
      kvBool("DD214 on file", vet.dd214OnFile),
    );
  }
  document.getElementById("client-identity-sensitive").innerHTML = parts.join("");
}

const revealIdentityBtn = document.getElementById("client-reveal-identity");
if (revealIdentityBtn) {
  revealIdentityBtn.addEventListener("click", async () => {
    if (!currentDetailClientId) return;
    const dl = document.getElementById("client-identity-sensitive");
    const status = document.getElementById("client-reveal-identity-status");
    if (!dl.hidden) {
      // Currently revealed — clicking again hides (no log; hide is free).
      hideRevealedIdentity();
      return;
    }
    revealIdentityBtn.disabled = true;
    try {
      const snap = await getDoc(
        doc(db, "clients", currentDetailClientId, "sensitive", "identity")
      );
      if (!snap.exists()) {
        alert("No sensitive identity record on file for this client.");
        revealIdentityBtn.disabled = false;
        return;
      }
      renderIdentitySensitive(snap.data());
      dl.hidden = false;
      revealIdentityBtn.disabled = false;
      revealIdentityBtn.textContent = "Hide sensitive identity";
      status.textContent = "Revealed — click button to hide.";
      status.classList.remove("muted");
      status.classList.add("accepted");
      await logAccess(AUDIT_ACTIONS.VIEW, "identity", currentDetailClientId, {
        surface: "clients-detail",
      });
    } catch (err) {
      alert(`Reveal failed: ${err.message}`);
      revealIdentityBtn.disabled = false;
    }
  });
}

// ---------- Sensitive medical reveal ----------

function hideRevealedMedical() {
  const dl = document.getElementById("client-medical");
  if (dl) {
    dl.hidden = true;
    dl.innerHTML = "";
  }
  const medsPanel = document.getElementById("client-medications-panel");
  if (medsPanel) {
    medsPanel.hidden = true;
    const list = document.getElementById("client-medications-list");
    if (list) list.innerHTML = "";
  }
  const btn = document.getElementById("client-reveal-medical");
  const status = document.getElementById("client-reveal-medical-status");
  if (btn) {
    btn.textContent = "Reveal medical record";
    btn.disabled = false;
  }
  if (status) {
    status.textContent = "Hidden by default. Each reveal is logged.";
    status.classList.remove("accepted");
    status.classList.add("muted");
  }
}

function renderMedicalSensitive(medical) {
  const ins = medical.healthInsurance || {};
  const hist = medical.healthcareHistory || {};
  const benefits = medical.governmentBenefits || null;
  let benefitsLine = null;
  if (benefits) {
    if (benefits.receiving === "yes" && Array.isArray(benefits.items) && benefits.items.length) {
      const total = benefits.items.reduce(
        (sum, it) => sum + (typeof it.monthlyAmount === "number" ? it.monthlyAmount : 0), 0);
      const lines = benefits.items.map((it) => {
        const lbl = INTAKE_BENEFIT_LABELS[it.type] || it.type;
        const amt = typeof it.monthlyAmount === "number" ? `$${it.monthlyAmount.toLocaleString()}/mo` : "(amount not entered)";
        return `${escapeHtml(lbl)} — ${escapeHtml(amt)}`;
      }).join("<br>");
      const totalLine = total > 0
        ? `<br><strong>Total monthly:</strong> $${total.toLocaleString()}`
        : "";
      benefitsLine = kv("Government benefits", `${lines}${totalLine}`, { raw: true });
    } else if (benefits.receiving === "no") {
      benefitsLine = kv("Government benefits", "Not receiving");
    } else if (benefits.receiving === "unknown") {
      benefitsLine = kv("Government benefits", "Unknown");
    }
    if (benefits.notes) {
      benefitsLine += kv("Benefits notes", benefits.notes);
    }
  }
  const html = [
    kv("Special needs / accommodations", medical.specialNeeds),
    kvLookup("Has health insurance", ins.hasInsurance, INSURANCE_LABELS),
    kv("Medicaid number", ins.medicaidNumber),
    kv("Medicare number", ins.medicareNumber),
    kv("Private insurance", ins.privateNumber),
    benefitsLine,
    kv("Where previously treated", hist.whereTreated),
    kv("Year of diagnosis", hist.yearOfDiagnosis),
    kv("Primary physician", hist.primaryPhysician),
    kv("Counselor / therapist", hist.counselor),
    kv("Pharmacy", hist.pharmacy),
    kv("Last updated", fmtTimestamp(medical.updatedAt)),
    kv("Updated by", medical.updatedBy),
  ].filter(Boolean).join("");
  document.getElementById("client-medical").innerHTML = html;
}

const revealMedicalBtn = document.getElementById("client-reveal-medical");
if (revealMedicalBtn) {
  revealMedicalBtn.addEventListener("click", async () => {
    if (!currentDetailClientId) return;
    const dl = document.getElementById("client-medical");
    const status = document.getElementById("client-reveal-medical-status");
    if (!dl.hidden) {
      hideRevealedMedical();
      return;
    }
    revealMedicalBtn.disabled = true;
    try {
      const snap = await getDoc(
        doc(db, "clients", currentDetailClientId, "sensitive", "medical")
      );
      if (!snap.exists()) {
        alert("No medical record on file for this client.");
        revealMedicalBtn.disabled = false;
        return;
      }
      renderMedicalSensitive(snap.data());
      dl.hidden = false;
      const medsPanel = document.getElementById("client-medications-panel");
      if (medsPanel) {
        medsPanel.hidden = false;
        // Fire and forget — list renders its own loading/error state.
        loadClientMedications(currentDetailClientId);
      }
      revealMedicalBtn.disabled = false;
      revealMedicalBtn.textContent = "Hide medical record";
      status.textContent = "Revealed — click button to hide.";
      status.classList.remove("muted");
      status.classList.add("accepted");
      await logAccess(AUDIT_ACTIONS.VIEW, "medical", currentDetailClientId, {
        surface: "clients-detail",
      });
    } catch (err) {
      alert(`Reveal failed: ${err.message}`);
      revealMedicalBtn.disabled = false;
    }
  });
}

// ---------- Client medications (post-intake add / discontinue) ----------
//
// The /medications collection is written per-medication. Intake-time meds carry
// intakeId; post-intake adds carry intakeId=null. "Active" = no endDate set.
// Discontinuing sets endDate (+ endedBy/endReason) rather than deleting, so the
// medication still appears in the printed Client History Report's "Discontinued"
// section (app.js ~8097-8107). Display is gated behind the medical-reveal flow
// because medications are PHI even though the docs themselves live outside
// /sensitive (rules only require staff-role to read).

async function loadClientMedications(cid) {
  const listEl = document.getElementById("client-medications-list");
  if (!listEl) return;
  listEl.innerHTML = `<p class="note">Loading…</p>`;
  try {
    const snap = await getDocs(query(
      collection(db, "medications"),
      where("clientId", "==", cid),
    ));
    const rows = snap.docs.map((d) => ({ id: d.id, data: d.data() }));
    const active = rows.filter((m) => !m.data.endDate);
    const past = rows.filter((m) => m.data.endDate);
    // Sort newest first by startDate (fall back to docId if startDate missing).
    active.sort((a, b) => tsMs(b.data.startDate) - tsMs(a.data.startDate));
    past.sort((a, b) => tsMs(b.data.endDate) - tsMs(a.data.endDate));
    listEl.innerHTML = renderClientMedicationsHtml(active, past);
  } catch (err) {
    listEl.innerHTML = `<p class="error">Could not load medications: ${escapeHtml(err.message)}</p>`;
  }
}

function renderClientMedicationsHtml(active, past) {
  const activeHtml = active.length
    ? active.map(({ id, data }) => {
        const reason = data.customReason || data.reasonForMedication || "";
        const dose = [data.dosage, data.frequency].filter(Boolean).join(" · ");
        const meta = [];
        if (dose) meta.push(escapeHtml(dose));
        if (reason) meta.push(`for ${escapeHtml(reason)}`);
        if (data.startDate) meta.push(`started ${escapeHtml(fmtDate(data.startDate) || "")}`);
        const side = data.sideEffects
          ? `<div class="muted" style="font-size: 0.85rem;">Side effects: ${escapeHtml(data.sideEffects)}</div>`
          : "";
        return `
          <div class="status-update-row" data-med-id="${escapeHtml(id)}">
            <div class="status-update-row-header">
              <strong>${escapeHtml(data.medicationName || "(medication)")}</strong>
              <button type="button" class="ghost ssn-reveal-btn client-med-discontinue"
                data-med-id="${escapeHtml(id)}"
                data-med-name="${escapeHtml(data.medicationName || "")}">Discontinue</button>
            </div>
            ${meta.length ? `<div class="meta">${meta.join(" · ")}</div>` : ""}
            ${side}
          </div>
        `;
      }).join("")
    : `<p class="note">No active medications.</p>`;
  const pastHtml = past.length
    ? `<details style="margin-top: 0.6rem;"><summary>Discontinued (${past.length})</summary>${
        past.map(({ data }) => {
          const dose = [data.dosage, data.frequency].filter(Boolean).join(" · ");
          const range = `${escapeHtml(fmtDate(data.startDate) || "?")} → ${escapeHtml(fmtDate(data.endDate) || "?")}`;
          const reason = data.endReason ? ` — ${escapeHtml(data.endReason)}` : "";
          return `<div class="meta">${escapeHtml(data.medicationName || "(med)")} · ${range}${dose ? ` · ${escapeHtml(dose)}` : ""}${reason}</div>`;
        }).join("")
      }</details>`
    : "";
  return activeHtml + pastHtml;
}

// ----- Add-medication modal (post-intake) -----
(function bindClientMedAddModal() {
  const openBtn = document.getElementById("client-med-add-btn");
  const modal = document.getElementById("client-med-add-modal");
  if (!openBtn || !modal) return;
  const backdrop = document.getElementById("client-med-add-modal-backdrop");
  const cancelBtn = document.getElementById("client-med-add-cancel");
  const confirmBtn = document.getElementById("client-med-add-confirm");
  const searchInput = document.getElementById("client-med-search");
  const dropdown = document.getElementById("client-med-search-dropdown");
  const selectedWrap = document.getElementById("client-med-selected");
  const selectedName = document.getElementById("client-med-selected-name");
  const selectedReasons = document.getElementById("client-med-selected-reasons");
  const dosageInput = document.getElementById("client-med-dosage");
  const frequencyInput = document.getElementById("client-med-frequency");
  const customReasonInput = document.getElementById("client-med-custom-reason");
  const startDateInput = document.getElementById("client-med-start-date");
  const clearBtn = document.getElementById("client-med-clear");
  const errEl = document.getElementById("client-med-add-error");
  const progressEl = document.getElementById("client-med-add-progress");

  // Local selection state — independent of the intake form's selectedMedications array.
  let picked = null; // { catalogId, name, reasonsForMedication, sideEffects }

  function showError(msg) {
    if (!errEl) return;
    errEl.textContent = msg;
    errEl.hidden = false;
  }
  function clearStatus() {
    if (errEl) errEl.hidden = true;
    if (progressEl) progressEl.hidden = true;
  }
  function resetSelection() {
    picked = null;
    if (selectedWrap) selectedWrap.hidden = true;
    if (selectedName) selectedName.textContent = "";
    if (selectedReasons) selectedReasons.textContent = "";
    if (dosageInput) dosageInput.value = "";
    if (frequencyInput) frequencyInput.value = "";
    if (customReasonInput) customReasonInput.value = "";
    if (startDateInput) startDateInput.value = todayLocalDate();
    if (confirmBtn) confirmBtn.disabled = true;
    if (searchInput) {
      searchInput.value = "";
      searchInput.disabled = false;
    }
    if (dropdown) {
      dropdown.hidden = true;
      dropdown.innerHTML = "";
    }
  }
  function open() {
    resetSelection();
    clearStatus();
    modal.hidden = false;
    setTimeout(() => searchInput?.focus(), 0);
    loadMedicationCatalog().catch(() => {});
  }
  function close() {
    modal.hidden = true;
  }

  openBtn.addEventListener("click", open);
  cancelBtn?.addEventListener("click", close);
  backdrop?.addEventListener("click", close);
  clearBtn?.addEventListener("click", () => {
    resetSelection();
    setTimeout(() => searchInput?.focus(), 0);
  });

  if (searchInput) {
    searchInput.addEventListener("focus", async () => {
      await loadMedicationCatalog().catch(() => {});
      if (searchInput.value && !picked) {
        renderDropdown(filterMedications(searchInput.value));
      }
    });
    searchInput.addEventListener("input", async () => {
      if (!medicationCatalog) await loadMedicationCatalog().catch(() => {});
      renderDropdown(filterMedications(searchInput.value));
    });
    searchInput.addEventListener("blur", () => {
      setTimeout(() => { if (dropdown) dropdown.hidden = true; }, 150);
    });
  }

  function renderDropdown(matches) {
    if (!dropdown) return;
    if (!matches || matches.length === 0) {
      dropdown.hidden = true;
      dropdown.innerHTML = "";
      return;
    }
    dropdown.innerHTML = matches.map((m) => `
      <div class="picker-item" data-id="${escapeHtml(m.id)}">
        <strong>${escapeHtml(m.name)}</strong>
        <div class="muted">${escapeHtml(m.reasonsForMedication)}</div>
      </div>
    `).join("");
    dropdown.hidden = false;
  }

  dropdown?.addEventListener("mousedown", (e) => {
    const item = e.target.closest(".picker-item");
    if (!item) return;
    const id = item.dataset.id;
    const med = medicationCatalog?.find((m) => m.id === id);
    if (!med) return;
    picked = {
      catalogId: med.id,
      name: med.name,
      reasonsForMedication: med.reasonsForMedication,
      sideEffects: med.sideEffects,
    };
    if (searchInput) {
      searchInput.value = med.name;
      searchInput.disabled = true;
    }
    if (selectedName) selectedName.textContent = med.name;
    if (selectedReasons) selectedReasons.textContent = med.reasonsForMedication || "";
    if (selectedWrap) selectedWrap.hidden = false;
    if (confirmBtn) confirmBtn.disabled = false;
    dropdown.hidden = true;
  });

  confirmBtn?.addEventListener("click", async () => {
    const cid = currentDetailClientId;
    if (!cid) { close(); return; }
    if (!picked) {
      showError("Pick a medication from the catalog first.");
      return;
    }
    clearStatus();
    confirmBtn.disabled = true;
    if (progressEl) {
      progressEl.textContent = "Saving…";
      progressEl.hidden = false;
    }
    try {
      const startStr = startDateInput?.value || "";
      const startTs = startStr
        ? Timestamp.fromDate(new Date(startStr + "T00:00:00"))
        : serverTimestamp();
      const data = {
        clientId: cid,
        intakeId: null,
        catalogId: picked.catalogId,
        medicationName: picked.name,
        reasonForMedication: picked.reasonsForMedication || "",
        sideEffects: picked.sideEffects || "",
        customReason: (customReasonInput?.value || "").trim() || null,
        dosage: (dosageInput?.value || "").trim() || null,
        frequency: (frequencyInput?.value || "").trim() || null,
        startDate: startTs,
        endDate: null,
        enteredBy: auth.currentUser?.email || "",
        enteredAt: serverTimestamp(),
      };
      const ref = await addDoc(collection(db, "medications"), data);
      await logAccess(AUDIT_ACTIONS.CREATE, "medications", ref.id, {
        clientId: cid, surface: "clients-detail", postIntake: true,
      });
      close();
      await loadClientMedications(cid);
    } catch (err) {
      if (progressEl) progressEl.hidden = true;
      showError(err.message || "Save failed.");
      confirmBtn.disabled = false;
    }
  });
})();

// ----- Discontinue-medication modal -----
(function bindClientMedStopModal() {
  const modal = document.getElementById("client-med-stop-modal");
  if (!modal) return;
  const backdrop = document.getElementById("client-med-stop-modal-backdrop");
  const cancelBtn = document.getElementById("client-med-stop-cancel");
  const confirmBtn = document.getElementById("client-med-stop-confirm");
  const nameEl = document.getElementById("client-med-stop-name");
  const dateInput = document.getElementById("client-med-stop-date");
  const reasonInput = document.getElementById("client-med-stop-reason");
  const errEl = document.getElementById("client-med-stop-error");
  const progressEl = document.getElementById("client-med-stop-progress");

  let targetMedId = null;

  function showError(msg) {
    if (!errEl) return;
    errEl.textContent = msg;
    errEl.hidden = false;
  }
  function open(medId, medName) {
    targetMedId = medId;
    if (nameEl) nameEl.textContent = medName || "(medication)";
    if (dateInput) dateInput.value = todayLocalDate();
    if (reasonInput) reasonInput.value = "";
    if (errEl) errEl.hidden = true;
    if (progressEl) progressEl.hidden = true;
    if (confirmBtn) confirmBtn.disabled = false;
    modal.hidden = false;
  }
  function close() { modal.hidden = true; targetMedId = null; }

  cancelBtn?.addEventListener("click", close);
  backdrop?.addEventListener("click", close);

  // Delegate clicks on the active-medications list to the discontinue modal.
  const listEl = document.getElementById("client-medications-list");
  if (listEl) {
    listEl.addEventListener("click", (e) => {
      const btn = e.target.closest(".client-med-discontinue");
      if (!btn) return;
      open(btn.dataset.medId, btn.dataset.medName);
    });
  }

  confirmBtn?.addEventListener("click", async () => {
    if (!targetMedId) { close(); return; }
    const cid = currentDetailClientId;
    if (!cid) { close(); return; }
    const dateStr = dateInput?.value || "";
    const dateValue = dateStr ? new Date(dateStr + "T00:00:00") : null;
    if (!dateValue || isNaN(dateValue)) {
      showError("Pick a valid end date.");
      return;
    }
    confirmBtn.disabled = true;
    if (errEl) errEl.hidden = true;
    if (progressEl) {
      progressEl.textContent = "Saving…";
      progressEl.hidden = false;
    }
    try {
      await updateDoc(doc(db, "medications", targetMedId), {
        endDate: Timestamp.fromDate(dateValue),
        endReason: (reasonInput?.value || "").trim() || null,
        endedBy: auth.currentUser?.email || "",
        endedAt: serverTimestamp(),
      });
      await logAccess(AUDIT_ACTIONS.UPDATE, "medications", targetMedId, {
        clientId: cid, surface: "clients-detail", discontinued: true,
      });
      close();
      await loadClientMedications(cid);
    } catch (err) {
      if (progressEl) progressEl.hidden = true;
      showError(err.message || "Save failed.");
      confirmBtn.disabled = false;
    }
  });
})();

// ---------- Intake history ----------

async function loadClientIntakes(cid) {
  const el = document.getElementById("client-intakes");
  try {
    const snap = await getDocs(query(
      collection(db, "intakes"),
      where("clientId", "==", cid),
      orderBy("intakeDate", "desc"),
    ));
    if (snap.empty) {
      el.innerHTML = `<p class="note">No intake events recorded.</p>`;
      return;
    }
    el.innerHTML = snap.docs.map((d) => {
      const data = d.data();
      const date = fmtTimestamp(data.intakeDate) || "(no date)";
      const meds = Array.isArray(data.medicationIds) ? data.medicationIds.length : 0;
      const odhCount = Array.isArray(data.odh206AuthIds) ? data.odh206AuthIds.length : 0;
      const flags = [];
      if (data.drugTestId) flags.push("drug screen");
      if (meds > 0) flags.push(`${meds} medication${meds === 1 ? "" : "s"}`);
      if (data.photoConsentId) flags.push("photo/video consent");
      if (odhCount > 0) flags.push(`${odhCount} ODH 206 auth${odhCount === 1 ? "" : "s"}`);
      if (data.guestSignaturePath) flags.push("guest signature");
      if (data.staffSignaturePath) flags.push("staff signature");
      if (data.acknowledgesExitInterview) flags.push("exit-interview ack");
      return `
        <div class="intake-row">
          <div class="intake-row-header">
            <strong>${escapeHtml(date)}</strong>
            <span class="meta">Entered by ${escapeHtml(data.staffEmail || "(unknown)")}</span>
          </div>
          <div class="meta">Intake ID: <code>${escapeHtml(d.id)}</code></div>
          ${flags.length ? `<div style="margin-top: 0.4rem;">${flags.map((f) => escapeHtml(f)).join(" &middot; ")}</div>` : ""}
        </div>
      `;
    }).join("");
  } catch (err) {
    el.innerHTML = `<p class="error">Could not load intakes: ${escapeHtml(err.message)}</p>`;
  }
}

// ---------- ODH 206 authorizations ----------

async function loadClientOdh206(cid) {
  const el = document.getElementById("client-odh206");
  try {
    const snap = await getDocs(collection(db, "clients", cid, "odh206"));
    if (snap.empty) {
      el.innerHTML = `<p class="note">No ODH 206 authorizations on file.</p>`;
      return;
    }
    // Sort signedAt desc client-side (small N)
    const rows = snap.docs.map((d) => ({ id: d.id, data: d.data() }));
    rows.sort((a, b) => {
      const sa = a.data.signedAt?.toMillis ? a.data.signedAt.toMillis() : 0;
      const sb = b.data.signedAt?.toMillis ? b.data.signedAt.toMillis() : 0;
      return sb - sa;
    });
    el.innerHTML = rows.map(({ id, data }) => {
      if (data.status === "declined") {
        return `
          <div class="odh206-row">
            <div class="odh206-row-header">
              <strong>Declined</strong>
              <span class="meta">${escapeHtml(fmtTimestamp(data.signedAt) || "")}</span>
            </div>
            <div class="meta">Auth ID: <code>${escapeHtml(id)}</code></div>
            <div class="meta">Recorded by ${escapeHtml(data.enteredBy || "(unknown)")}</div>
          </div>
        `;
      }
      const info = data.infoShared || {};
      const infoLabels = Object.keys(info).filter((k) => info[k]).map((k) => ODH_INFO_LABELS[k] || k);
      const expiry = fmtDate(data.expirationDate)
        || data.expirationEvent
        || "Unspecified";
      return `
        <div class="odh206-row">
          <div class="odh206-row-header">
            <strong>${escapeHtml(data.disclosingParty || "(disclosing party not recorded)")} &rarr; ${escapeHtml(data.receivingParty || TENANT.orgName)}</strong>
            <span class="meta">${escapeHtml(fmtTimestamp(data.signedAt) || "")}</span>
          </div>
          <dl class="kv-grid">
            ${kv("Purpose", data.purpose)}
            ${kv("Information shared", infoLabels.join(", "))}
            ${kv("Expiration", expiry)}
            ${kvBool("Text reviewed by client", data.textReviewedByClient)}
            ${kv("Auth ID", `<code>${escapeHtml(id)}</code>`, { raw: true })}
            ${kv("Recorded by", data.enteredBy)}
          </dl>
        </div>
      `;
    }).join("");
  } catch (err) {
    el.innerHTML = `<p class="error">Could not load ODH 206 authorizations: ${escapeHtml(err.message)}</p>`;
  }
}

// ============================================================
// ODH 206 PDF generator (§11 "Auto-fill PDF generator" slice)
// ============================================================
//
// Staff clicks "Generate ODH 206 PDF" on a client's detail page; modal
// collects disclosing party, info-shared checkboxes, purpose, expiration.
// The source PDF (public/forms/odh206.pdf) is the official Oklahoma
// fillable AcroForm; we set its named fields via pdf-lib's form API and
// flatten so the result prints reliably and can't be re-edited. A new
// clients/{cid}/odh206/{auto} record is also written so the authorization
// shows up in the existing history list. SSN is read from
// sensitive/identity and embedded on the PDF — that read writes a 'view'
// audit entry, and generation itself writes a 'print' entry.
//
// Field-name map: derived from inspecting the template's AcroForm widget
// rects. The original PDF designer reused stale labels as field IDs (e.g.
// the SSN field is named "Medical Record"), so the names look wrong but
// the positions are correct. Don't rename without re-inspecting the
// template.

const GSO_RECEIVING_PARTY = TENANT.orgNameWithAddress;

const ODH206_FIELDS = {
  patientName:        "OKLAHOMA STANDARD AUTHORIZATION TO USE OR SHARE PROTECTED HEALTH INFORMATION PHI",
  medicalRecord:      "undefined",
  dob:                "Patient Name",
  ssn:                "Medical Record",
  disclosingParty:    "Social Security",
  receivingParty:     "Name of PersonOrganization Disclosing PHI",
  receivingAddress2:  "Name and Address of PersonOrganization Receiving PHI",
  cb_psychotherapy:   "Psychotherapy Notes if checking this box no other boxes may be checked",
  cb_entireMedical:   "Entire Medical Record",
  cb_billing:         "Billing Information for",
  billingFor:         "undefined_2",
  cb_mentalHealth:    "Mental Health Records",
  cb_substanceAbuse:  "Substance Abuse Records",
  cb_medicalBetween:  "Medical information compiled between",
  medicalBetweenStart: "undefined_3",
  medicalBetweenEnd:  "undefined_4",
  cb_otherInfo:       "Other",
  otherInfoText:      "and",
  cb_purpInsurance:   "Insurance",
  cb_purpContinued:   "Continued Treatment",
  cb_purpLegal:       "Legal",
  cb_purpAtRequest:   "At my or my representatives request",
  cb_purpOther:       "Other_2",
  purpOtherText:      "undefined_5",
  expirationEvent:    "Text1",
  expirationEvent2:   "Text2",
  date:               "Date",
  legalRepAuthority:  "Description of Legal Representatives Authority",
  expirationDate:     "Expiration date if longer than one year from date of",
};

let pdfLibPromise = null;
function loadPdfLib() {
  if (!pdfLibPromise) {
    pdfLibPromise = import("https://cdn.jsdelivr.net/npm/pdf-lib@1.17.1/+esm");
  }
  return pdfLibPromise;
}

let odh206GenWired = false;
let odh206GenContext = null;

function wireOdh206Generator() {
  if (odh206GenWired) return;
  odh206GenWired = true;
  const modal = document.getElementById("odh206-gen-modal");
  if (!modal) return;
  const cancelBtn = document.getElementById("odh206-gen-cancel");
  const confirmBtn = document.getElementById("odh206-gen-confirm");
  const backdrop = document.getElementById("odh206-gen-modal-backdrop");
  const purpOtherWrap = document.getElementById("odh206-gen-purpose-other-wrap");
  const expiryDateInput = document.getElementById("odh206-gen-expiry-date");
  const psychoCb = document.getElementById("odh206-gen-info-psycho");
  const otherInfoCbs = [
    document.getElementById("odh206-gen-info-general"),
    document.getElementById("odh206-gen-info-mental"),
    document.getElementById("odh206-gen-info-substance"),
  ];

  cancelBtn?.addEventListener("click", () => closeOdh206GenModal());
  backdrop?.addEventListener("click", () => closeOdh206GenModal());

  modal.addEventListener("change", (e) => {
    if (e.target?.name === "odh206-gen-purpose") {
      purpOtherWrap.hidden = e.target.value !== "other";
    }
    if (e.target?.name === "odh206-gen-expiry") {
      expiryDateInput.disabled = e.target.value !== "date";
    }
    // Psychotherapy-notes exclusivity matches the intake form's rule:
    // checking psychotherapy clears the others; checking any other clears it.
    if (e.target === psychoCb && psychoCb.checked) {
      otherInfoCbs.forEach((cb) => { cb.checked = false; });
    } else if (otherInfoCbs.includes(e.target) && e.target.checked) {
      psychoCb.checked = false;
    }
  });

  confirmBtn?.addEventListener("click", () => {
    handleOdh206Generate().catch((err) => {
      console.error("[odh206-gen] generate failed", err);
      const errEl = document.getElementById("odh206-gen-error");
      if (errEl) {
        errEl.textContent = `Generation failed: ${err.message || err}`;
        errEl.hidden = false;
      }
    });
  });
}

function openOdh206GenModal(clientId, master) {
  wireOdh206Generator();
  odh206GenContext = { clientId, master };
  const modal = document.getElementById("odh206-gen-modal");
  if (!modal) return;
  document.getElementById("odh206-gen-disclosing").value = "";
  document.getElementById("odh206-gen-info-general").checked = false;
  document.getElementById("odh206-gen-info-mental").checked = false;
  document.getElementById("odh206-gen-info-substance").checked = false;
  document.getElementById("odh206-gen-info-psycho").checked = false;
  modal.querySelectorAll('input[name="odh206-gen-purpose"]').forEach((r) => {
    r.checked = r.value === "atMyRequest";
  });
  document.getElementById("odh206-gen-purpose-other-wrap").hidden = true;
  document.getElementById("odh206-gen-purpose-other").value = "";
  modal.querySelectorAll('input[name="odh206-gen-expiry"]').forEach((r) => {
    r.checked = r.value === "event";
  });
  const expiryDateInput = document.getElementById("odh206-gen-expiry-date");
  expiryDateInput.value = "";
  expiryDateInput.disabled = true;
  const errEl = document.getElementById("odh206-gen-error");
  errEl.hidden = true;
  errEl.textContent = "";

  const summary = document.getElementById("odh206-gen-summary");
  const fullName = [master.firstName, master.middleName, master.lastName]
    .filter(Boolean).join(" ");
  const dob = fmtDate(master.dob) || "(no DOB on file)";
  summary.innerHTML = `Patient: <strong>${escapeHtml(fullName || clientId)}</strong> · DOB ${escapeHtml(dob)} · ${escapeHtml(clientId)}<br>Receiving party (constant): ${escapeHtml(GSO_RECEIVING_PARTY)}`;

  modal.hidden = false;
}

function closeOdh206GenModal() {
  const modal = document.getElementById("odh206-gen-modal");
  if (modal) modal.hidden = true;
  odh206GenContext = null;
}

async function handleOdh206Generate() {
  const errEl = document.getElementById("odh206-gen-error");
  errEl.hidden = true;
  if (!odh206GenContext) throw new Error("No client selected");
  const { clientId, master } = odh206GenContext;
  const confirmBtn = document.getElementById("odh206-gen-confirm");

  const disclosingParty = document.getElementById("odh206-gen-disclosing").value.trim();
  if (!disclosingParty) {
    errEl.textContent = "Disclosing party is required.";
    errEl.hidden = false;
    return;
  }
  const info = {
    general:            document.getElementById("odh206-gen-info-general").checked,
    mentalHealth:       document.getElementById("odh206-gen-info-mental").checked,
    substanceAbuse:     document.getElementById("odh206-gen-info-substance").checked,
    psychotherapyNotes: document.getElementById("odh206-gen-info-psycho").checked,
  };
  if (!info.general && !info.mentalHealth && !info.substanceAbuse && !info.psychotherapyNotes) {
    errEl.textContent = "Pick at least one type of information to be shared.";
    errEl.hidden = false;
    return;
  }
  if (info.psychotherapyNotes && (info.general || info.mentalHealth || info.substanceAbuse)) {
    errEl.textContent = "Psychotherapy notes is exclusive — it cannot be combined with other categories on the same authorization.";
    errEl.hidden = false;
    return;
  }
  const purposeChoice = document.querySelector('input[name="odh206-gen-purpose"]:checked')?.value || "atMyRequest";
  const purposeOther = document.getElementById("odh206-gen-purpose-other").value.trim();
  if (purposeChoice === "other" && !purposeOther) {
    errEl.textContent = "Describe the 'Other' purpose.";
    errEl.hidden = false;
    return;
  }
  const expiryChoice = document.querySelector('input[name="odh206-gen-expiry"]:checked')?.value || "event";
  const expiryDateStr = document.getElementById("odh206-gen-expiry-date").value;
  let expirationEvent = null;
  let expirationDate = null;
  if (expiryChoice === "date") {
    if (!expiryDateStr) {
      errEl.textContent = "Pick an expiration date.";
      errEl.hidden = false;
      return;
    }
    expirationDate = expiryDateStr;
  } else {
    expirationEvent = TENANT.expirationOnExitEvent;
  }

  confirmBtn.disabled = true;
  confirmBtn.textContent = "Generating…";
  try {
    const idSnap = await getDoc(doc(db, "clients", clientId, "sensitive", "identity"));
    const idData = idSnap.exists() ? idSnap.data() : {};
    await logAccess(AUDIT_ACTIONS.VIEW, "identity", clientId, {
      surface: "odh206-pdf-generator",
      reason: "ssn embedded in generated authorization",
    });
    const ssnFormatted = idData.ssnFormatted
      || idData.ssnFull
      || (master.ssnLast4 ? `xxx-xx-${master.ssnLast4}` : "");

    const purposeLabels = {
      insurance:          "Insurance",
      continuedTreatment: "Continued treatment",
      legal:              "Legal",
      atMyRequest:        "At my or my representative's request",
    };
    const purposeText = purposeChoice === "other"
      ? `Other: ${purposeOther}`
      : purposeLabels[purposeChoice];

    const pdfBytes = await buildOdh206Pdf({
      master, ssnFormatted, disclosingParty, info,
      purposeChoice, purposeOther, expirationEvent, expirationDate,
    });

    const newAuthRef = await addDoc(collection(db, "clients", clientId, "odh206"), {
      clientId,
      disclosingParty,
      receivingParty: GSO_RECEIVING_PARTY,
      purpose: purposeText,
      infoShared: info,
      expirationDate: expirationDate ? Timestamp.fromDate(new Date(expirationDate)) : null,
      expirationEvent,
      textReviewedByClient: false,
      signedAt: serverTimestamp(),
      enteredBy: auth.currentUser?.email || null,
      source: "pdf-generator",
    });

    await logAccess(AUDIT_ACTIONS.PRINT, "odh206", newAuthRef.id, {
      clientId,
      surface: "odh206-pdf-generator",
      disclosingParty,
      info,
      purpose: purposeText,
    });

    const dateStamp = new Date().toISOString().slice(0, 10);
    const safeName = [master.lastName, master.firstName].filter(Boolean).join("-").replace(/[^A-Za-z0-9-]/g, "") || clientId;
    openPdfInNewTab(pdfBytes, `ODH206-${safeName}-${dateStamp}.pdf`);

    closeOdh206GenModal();
    await loadClientOdh206(clientId);
  } finally {
    confirmBtn.disabled = false;
    confirmBtn.textContent = "Generate PDF";
  }
}

async function buildOdh206Pdf({ master, ssnFormatted, disclosingParty, info, purposeChoice, purposeOther, expirationEvent, expirationDate }) {
  const { PDFDocument } = await loadPdfLib();
  const tmplBytes = await fetch("/forms/odh206.pdf").then((r) => {
    if (!r.ok) throw new Error(`Could not load odh206.pdf template (${r.status})`);
    return r.arrayBuffer();
  });
  const pdf = await PDFDocument.load(tmplBytes);
  while (pdf.getPageCount() > 1) pdf.removePage(1);
  const form = pdf.getForm();

  const setText = (key, val) => {
    try { form.getTextField(ODH206_FIELDS[key]).setText(val || ""); }
    catch (e) { console.warn(`[odh206] setText "${key}" failed: ${e.message}`); }
  };
  const setCheck = (key, on) => {
    try {
      const cb = form.getCheckBox(ODH206_FIELDS[key]);
      if (on) cb.check(); else cb.uncheck();
    } catch (e) { console.warn(`[odh206] setCheck "${key}" failed: ${e.message}`); }
  };

  const fullName = [master.firstName, master.middleName, master.lastName]
    .filter(Boolean).join(" ");

  // Identifiers (top of form). Some leftover values from the template are
  // explicitly cleared so they don't survive into the generated copy.
  setText("patientName", fullName);
  setText("medicalRecord", "");
  setText("dob", fmtDate(master.dob) || "");
  setText("ssn", ssnFormatted);
  setText("disclosingParty", disclosingParty);
  setText("receivingParty", GSO_RECEIVING_PARTY);
  setText("receivingAddress2", "");

  // Information-shared checkboxes. Best-effort mapping per the §14 design
  // decision: our existing schema's `general` flag fills the "Entire Medical
  // Record" box; `psychotherapyNotes` (mutually exclusive) fills the
  // psychotherapy box.
  setCheck("cb_psychotherapy", info.psychotherapyNotes);
  setCheck("cb_entireMedical", info.general);
  setCheck("cb_billing", false);
  setCheck("cb_mentalHealth", info.mentalHealth);
  setCheck("cb_substanceAbuse", info.substanceAbuse);
  setCheck("cb_medicalBetween", false);
  setCheck("cb_otherInfo", false);
  setText("billingFor", "");
  setText("medicalBetweenStart", "");
  setText("medicalBetweenEnd", "");
  setText("otherInfoText", "");

  // Purpose checkboxes — exactly one will be checked.
  setCheck("cb_purpInsurance", purposeChoice === "insurance");
  setCheck("cb_purpContinued", purposeChoice === "continuedTreatment");
  setCheck("cb_purpLegal", purposeChoice === "legal");
  setCheck("cb_purpAtRequest", purposeChoice === "atMyRequest");
  setCheck("cb_purpOther", purposeChoice === "other");
  setText("purpOtherText", purposeChoice === "other" ? purposeOther : "");

  // Expiration + signing-date fields. Signature line stays blank for
  // handwritten signing per the §11 slice design.
  setText("expirationEvent", expirationEvent || "");
  setText("expirationEvent2", "");
  setText("date", new Date().toLocaleDateString("en-US"));
  setText("legalRepAuthority", "");
  setText("expirationDate",
    expirationDate ? new Date(expirationDate).toLocaleDateString("en-US") : "");

  // Flatten so AcroForm fields render as plain content — prints reliably
  // on every viewer and can't be re-edited after generation.
  form.flatten();
  return pdf.save();
}

// Open the generated PDF inline in a new browser tab. Chrome / Edge / Firefox
// all render PDFs natively and show a toolbar with Print + Save buttons —
// staff prints from there. Falls back to a download if the popup is blocked.
// `filename` is set as the tab title via the blob URL fragment so the browser's
// Save dialog defaults to a sensible name.
function openPdfInNewTab(bytes, filename) {
  const blob = new Blob([bytes], { type: "application/pdf" });
  const url = URL.createObjectURL(blob);
  const win = window.open(url, "_blank");
  if (!win) {
    // Popup blocked — fall back to a regular download so staff can still
    // open it manually from the downloads folder.
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
  }
  // Revoke the blob URL after the browser has had time to load it. Chrome
  // releases the URL on tab close, so 60s is a safe upper bound.
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

// Static "Generate ODH 206 PDF" button in the client detail panel — wired
// once on load, picks up the currently-displayed client at click time.
const odh206GenBtn = document.getElementById("odh206-gen-btn");
if (odh206GenBtn) {
  odh206GenBtn.addEventListener("click", async () => {
    if (!currentDetailClientId) return;
    try {
      const masterSnap = await getDoc(doc(db, "clients", currentDetailClientId));
      if (!masterSnap.exists()) {
        alert("Client record not found.");
        return;
      }
      openOdh206GenModal(currentDetailClientId, { ...masterSnap.data(), clientId: currentDetailClientId });
    } catch (err) {
      console.error("[odh206-gen] failed to open", err);
      alert(`Could not open generator: ${err.message || err}`);
    }
  });
}

// ============================================================
// Photo / Video release PDF generator
// ============================================================
//
// Same flow as ODH 206: open template (public/forms/Photo Consent Form3.pdf),
// fill identifier fields + checkboxes via pdf-lib, flatten, open in new tab.
// Field-name map is from inspecting the AcroForm widgets — the designer named
// the checkboxes "Check Box3/5/6/7/8" with no semantics; mapping was derived
// from widget rects (see admin/inspect-pdf-fields.mjs).

const PHOTO_CONSENT_FIELDS = {
  participantName: "Name of Participant please print",
  date:            "Date",
  phone:           "Phone Number",
  email:           "Text9",
  staffName:       "Staff Name please print",
  staffDate:       "Date_2",
  cb_roleStaff:    "Check Box7",
  cb_roleClient:   "Check Box3",
  cb_roleOther:    "Check Box8",
  cb_accept:       "Check Box5",
  cb_deny:         "Check Box6",
};

let photoConsentGenWired = false;
let photoConsentGenContext = null;

function wirePhotoConsentGenerator() {
  if (photoConsentGenWired) return;
  photoConsentGenWired = true;
  const modal = document.getElementById("photo-consent-gen-modal");
  if (!modal) return;
  document.getElementById("photo-consent-gen-cancel")?.addEventListener("click", () => closePhotoConsentGenModal());
  document.getElementById("photo-consent-gen-modal-backdrop")?.addEventListener("click", () => closePhotoConsentGenModal());
  document.getElementById("photo-consent-gen-confirm")?.addEventListener("click", () => {
    handlePhotoConsentGenerate().catch((err) => {
      console.error("[photo-consent-gen] generate failed", err);
      const errEl = document.getElementById("photo-consent-gen-error");
      if (errEl) {
        errEl.textContent = `Generation failed: ${err.message || err}`;
        errEl.hidden = false;
      }
    });
  });
}

function openPhotoConsentGenModal(clientId, master) {
  wirePhotoConsentGenerator();
  photoConsentGenContext = { clientId, master };
  const modal = document.getElementById("photo-consent-gen-modal");
  if (!modal) return;
  modal.querySelectorAll('input[name="photo-consent-role"]').forEach((r) => {
    r.checked = r.value === "client";
  });
  modal.querySelectorAll('input[name="photo-consent-response"]').forEach((r) => {
    r.checked = r.value === "accept";
  });
  const errEl = document.getElementById("photo-consent-gen-error");
  errEl.hidden = true;
  errEl.textContent = "";

  const fullName = [master.firstName, master.middleName, master.lastName].filter(Boolean).join(" ");
  const phone = master.contact?.phone || "";
  const email = master.contact?.email || "";
  const summary = document.getElementById("photo-consent-gen-summary");
  summary.innerHTML =
    `Participant: <strong>${escapeHtml(fullName || clientId)}</strong><br>`
    + `Phone: ${escapeHtml(phone || "(none on file)")} · Email: ${escapeHtml(email || "(none on file)")}`;
  modal.hidden = false;
}

function closePhotoConsentGenModal() {
  const modal = document.getElementById("photo-consent-gen-modal");
  if (modal) modal.hidden = true;
  photoConsentGenContext = null;
}

async function handlePhotoConsentGenerate() {
  const errEl = document.getElementById("photo-consent-gen-error");
  errEl.hidden = true;
  if (!photoConsentGenContext) throw new Error("No client selected");
  const { clientId, master } = photoConsentGenContext;
  const confirmBtn = document.getElementById("photo-consent-gen-confirm");

  const role = document.querySelector('input[name="photo-consent-role"]:checked')?.value || "client";
  const response = document.querySelector('input[name="photo-consent-response"]:checked')?.value || "accept";

  confirmBtn.disabled = true;
  confirmBtn.textContent = "Generating…";
  try {
    const pdfBytes = await buildPhotoConsentPdf({ master, role, response });

    // Append-only record in the existing consents subcollection. Status uses
    // the same `accept`/`deny` vocabulary as the intake form; `blank` means
    // staff generated a form for the participant to mark in person, so we
    // record it as `pending` rather than asserting a response.
    const consentStatus = response === "accept" ? "accept"
      : response === "deny" ? "deny"
      : "pending";
    const newRef = await addDoc(collection(db, "clients", clientId, "consents"), {
      clientId,
      consentType: "photoVideo",
      status: consentStatus,
      role,
      effectiveDate: serverTimestamp(),
      enteredBy: auth.currentUser?.email || null,
      source: "pdf-generator",
    });

    await logAccess(AUDIT_ACTIONS.PRINT, "consent", newRef.id, {
      clientId,
      surface: "photo-consent-pdf-generator",
      consentType: "photoVideo",
      role,
      response,
    });

    const dateStamp = new Date().toISOString().slice(0, 10);
    const safeName = [master.lastName, master.firstName].filter(Boolean).join("-").replace(/[^A-Za-z0-9-]/g, "") || clientId;
    openPdfInNewTab(pdfBytes, `PhotoConsent-${safeName}-${dateStamp}.pdf`);

    closePhotoConsentGenModal();
    if (typeof loadClientConsents === "function") await loadClientConsents(clientId);
  } finally {
    confirmBtn.disabled = false;
    confirmBtn.textContent = "Generate PDF";
  }
}

async function buildPhotoConsentPdf({ master, role, response }) {
  const { PDFDocument } = await loadPdfLib();
  const tmplBytes = await fetch("/forms/Photo%20Consent%20Form3.pdf").then((r) => {
    if (!r.ok) throw new Error(`Could not load Photo Consent template (${r.status})`);
    return r.arrayBuffer();
  });
  const pdf = await PDFDocument.load(tmplBytes);
  const form = pdf.getForm();

  const setText = (key, val) => {
    try { form.getTextField(PHOTO_CONSENT_FIELDS[key]).setText(val || ""); }
    catch (e) { console.warn(`[photo-consent] setText "${key}" failed: ${e.message}`); }
  };
  const setCheck = (key, on) => {
    try {
      const cb = form.getCheckBox(PHOTO_CONSENT_FIELDS[key]);
      if (on) cb.check(); else cb.uncheck();
    } catch (e) { console.warn(`[photo-consent] setCheck "${key}" failed: ${e.message}`); }
  };

  const fullName = [master.firstName, master.middleName, master.lastName].filter(Boolean).join(" ");
  const today = new Date().toLocaleDateString("en-US");
  const staffName = (auth.currentUser?.displayName || auth.currentUser?.email || "").trim();

  setText("participantName", fullName);
  setText("date", today);
  setText("phone", master.contact?.phone || "");
  setText("email", master.contact?.email || "");
  setText("staffName", staffName);
  setText("staffDate", today);

  setCheck("cb_roleStaff", role === "staff");
  setCheck("cb_roleClient", role === "client");
  setCheck("cb_roleOther", role === "other");
  setCheck("cb_accept", response === "accept");
  setCheck("cb_deny", response === "deny");

  form.flatten();
  return pdf.save();
}

const photoConsentGenBtn = document.getElementById("photo-consent-gen-btn");
if (photoConsentGenBtn) {
  photoConsentGenBtn.addEventListener("click", async () => {
    if (!currentDetailClientId) return;
    try {
      const masterSnap = await getDoc(doc(db, "clients", currentDetailClientId));
      if (!masterSnap.exists()) {
        alert("Client record not found.");
        return;
      }
      openPhotoConsentGenModal(currentDetailClientId, { ...masterSnap.data(), clientId: currentDetailClientId });
    } catch (err) {
      console.error("[photo-consent-gen] failed to open", err);
      alert(`Could not open generator: ${err.message || err}`);
    }
  });
}

// ============================================================
// Significant Events tracker generator
// ============================================================
//
// The source is a docx (no AcroForm), so we build the page from scratch in
// pdf-lib instead of filling a template: GSO logo at top, "Significant
// Events" heading, instruction line, pre-filled "Client's Name" and "Date",
// then 18 blank ruled lines for handwritten event entries. Same audit-log
// pattern as the other generators.

let sigEventsGenWired = false;
let sigEventsGenContext = null;
let gsoLogoBytesPromise = null;

function loadGsoLogoBytes() {
  if (!gsoLogoBytesPromise) {
    gsoLogoBytesPromise = fetch("/forms/gso-logo.png").then((r) => {
      if (!r.ok) throw new Error(`Could not load GSO logo (${r.status})`);
      return r.arrayBuffer();
    });
  }
  return gsoLogoBytesPromise;
}

function wireSignificantEventsGenerator() {
  if (sigEventsGenWired) return;
  sigEventsGenWired = true;
  const modal = document.getElementById("sigevents-gen-modal");
  if (!modal) return;
  document.getElementById("sigevents-gen-cancel")?.addEventListener("click", () => closeSignificantEventsGenModal());
  document.getElementById("sigevents-gen-modal-backdrop")?.addEventListener("click", () => closeSignificantEventsGenModal());
  document.getElementById("sigevents-gen-confirm")?.addEventListener("click", () => {
    handleSignificantEventsGenerate().catch((err) => {
      console.error("[sigevents-gen] generate failed", err);
      const errEl = document.getElementById("sigevents-gen-error");
      if (errEl) {
        errEl.textContent = `Generation failed: ${err.message || err}`;
        errEl.hidden = false;
      }
    });
  });
}

function openSignificantEventsGenModal(clientId, master) {
  wireSignificantEventsGenerator();
  sigEventsGenContext = { clientId, master };
  const modal = document.getElementById("sigevents-gen-modal");
  if (!modal) return;
  const errEl = document.getElementById("sigevents-gen-error");
  errEl.hidden = true;
  errEl.textContent = "";
  const fullName = [master.firstName, master.middleName, master.lastName].filter(Boolean).join(" ");
  const today = new Date().toLocaleDateString("en-US");
  const summary = document.getElementById("sigevents-gen-summary");
  summary.innerHTML = `Client: <strong>${escapeHtml(fullName || clientId)}</strong> · Date: ${escapeHtml(today)}`;
  modal.hidden = false;
}

function closeSignificantEventsGenModal() {
  const modal = document.getElementById("sigevents-gen-modal");
  if (modal) modal.hidden = true;
  sigEventsGenContext = null;
}

async function handleSignificantEventsGenerate() {
  const errEl = document.getElementById("sigevents-gen-error");
  errEl.hidden = true;
  if (!sigEventsGenContext) throw new Error("No client selected");
  const { clientId, master } = sigEventsGenContext;
  const confirmBtn = document.getElementById("sigevents-gen-confirm");

  confirmBtn.disabled = true;
  confirmBtn.textContent = "Generating…";
  try {
    const pdfBytes = await buildSignificantEventsPdf({ master });

    await logAccess(AUDIT_ACTIONS.PRINT, "significantEventsForm", null, {
      clientId,
      surface: "sigevents-pdf-generator",
    });

    const dateStamp = new Date().toISOString().slice(0, 10);
    const safeName = [master.lastName, master.firstName].filter(Boolean).join("-").replace(/[^A-Za-z0-9-]/g, "") || clientId;
    openPdfInNewTab(pdfBytes, `SignificantEvents-${safeName}-${dateStamp}.pdf`);

    closeSignificantEventsGenModal();
  } finally {
    confirmBtn.disabled = false;
    confirmBtn.textContent = "Generate PDF";
  }
}

async function buildSignificantEventsPdf({ master }) {
  const { PDFDocument, StandardFonts, rgb } = await loadPdfLib();
  const pdf = await PDFDocument.create();
  // US Letter
  const page = pdf.addPage([612, 792]);
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const fontBold = await pdf.embedFont(StandardFonts.HelveticaBold);

  // Logo at top-center.
  try {
    const logoBytes = await loadGsoLogoBytes();
    const logo = await pdf.embedPng(logoBytes);
    const logoWidth = 130;
    const logoHeight = logo.height * (logoWidth / logo.width);
    page.drawImage(logo, {
      x: (612 - logoWidth) / 2,
      y: 792 - 50 - logoHeight,
      width: logoWidth,
      height: logoHeight,
    });
  } catch (e) {
    console.warn("[sigevents] logo embed failed", e.message);
  }

  // Title.
  const titleText = "Significant Events";
  const titleSize = 24;
  const titleWidth = fontBold.widthOfTextAtSize(titleText, titleSize);
  page.drawText(titleText, {
    x: (612 - titleWidth) / 2,
    y: 640,
    size: titleSize,
    font: fontBold,
    color: rgb(0, 0, 0),
  });
  // Underline matches the docx "Significant Events" underline.
  page.drawLine({
    start: { x: (612 - titleWidth) / 2, y: 637 },
    end:   { x: (612 - titleWidth) / 2 + titleWidth, y: 637 },
    thickness: 1,
    color: rgb(0, 0, 0),
  });

  // Instruction line — wraps to two short lines for readability.
  const instructions = "Events such as failed drug tests, no show for bed check or other";
  const instructions2 = "major events. Date each entry.";
  page.drawText(instructions,  { x: 72, y: 600, size: 13, font, color: rgb(0, 0, 0) });
  page.drawText(instructions2, { x: 72, y: 582, size: 13, font, color: rgb(0, 0, 0) });

  // Pre-filled name + date row.
  const fullName = [master.firstName, master.middleName, master.lastName].filter(Boolean).join(" ");
  const today = new Date().toLocaleDateString("en-US");
  page.drawText("Client's Name:", { x: 72, y: 545, size: 13, font, color: rgb(0, 0, 0) });
  page.drawText(fullName || "", { x: 165, y: 545, size: 13, font, color: rgb(0, 0, 0) });
  page.drawLine({ start: { x: 162, y: 542 }, end: { x: 360, y: 542 }, thickness: 0.5, color: rgb(0, 0, 0) });

  page.drawText("Date:", { x: 400, y: 545, size: 13, font, color: rgb(0, 0, 0) });
  page.drawText(today, { x: 435, y: 545, size: 13, font, color: rgb(0, 0, 0) });
  page.drawLine({ start: { x: 432, y: 542 }, end: { x: 540, y: 542 }, thickness: 0.5, color: rgb(0, 0, 0) });

  // Blank ruled lines for handwritten events. 18 lines × 26pt spacing fits
  // comfortably between y=510 and the bottom margin.
  let y = 510;
  for (let i = 0; i < 18; i += 1) {
    page.drawLine({
      start: { x: 72, y },
      end:   { x: 540, y },
      thickness: 0.5,
      color: rgb(0, 0, 0),
    });
    y -= 26;
  }

  return pdf.save();
}

const sigEventsGenBtn = document.getElementById("sigevents-gen-btn");
if (sigEventsGenBtn) {
  sigEventsGenBtn.addEventListener("click", async () => {
    if (!currentDetailClientId) return;
    try {
      const masterSnap = await getDoc(doc(db, "clients", currentDetailClientId));
      if (!masterSnap.exists()) {
        alert("Client record not found.");
        return;
      }
      openSignificantEventsGenModal(currentDetailClientId, { ...masterSnap.data(), clientId: currentDetailClientId });
    } catch (err) {
      console.error("[sigevents-gen] failed to open", err);
      alert(`Could not open generator: ${err.message || err}`);
    }
  });
}

// ============================================================
// Printable client intake report
// ============================================================
//
// One-page printable summary per client. Title block (name + DOB), veteran
// flag, contact yes/no, two-column "Documents Needed" / "Documents on File"
// split, then provider/counselor/HS-grad yes/no rows. The documents map on
// master is the source of truth (intake writes it; status updates keep it
// current), so the report reflects the client's CURRENT state — useful both
// at intake time and for long-tenured clients.
//
// CDIB row only appears for American-Indian clients; DD-214 + VA Card rows
// only appear for veterans. Diploma row reads the HS/GED diploma slot
// (intake captures HS and college separately; HS is the canonical "Diploma"
// per Daniel 2026-05-09).

function renderIntakeReportHtml({ cid, master, identity, medical, latestIntake }) {
  const fullName = [master.firstName, master.middleName, master.lastName]
    .map((s) => (s || "").toString().trim())
    .filter(Boolean)
    .join(" ") || "(no name)";
  const dob = fmtDate(master.dob) || "(unknown)";
  const isVeteran = master.veteran === true;
  const isAmIndian = Array.isArray(master.raceEthnicity)
    && master.raceEthnicity.includes("americanIndian");

  const docs = master.documents || {};
  // Prefer master.documents (kept current by status updates); fall back to
  // the identity-subdoc on-file booleans so legacy intake records still read
  // correctly if they ever skipped the mirror write.
  const has = (key, fallback) => !!(docs[key] && docs[key].obtained) || !!fallback;

  const phone = !!(master.contact && master.contact.phone);
  const email = !!(master.contact && master.contact.email);
  const hist = (medical && medical.healthcareHistory) || {};
  const primaryProvider = !!hist.primaryPhysician;
  const counselor = !!hist.counselor;
  const hsGradStatus = latestIntake?.education?.hsGradStatus === "yes";

  const checks = [
    { label: "State ID",               on: has("stateId",            identity.hasDLOnFile) },
    { label: "Social Security Card",   on: has("socialSecurityCard", identity.hasSSCOnFile) },
    { label: "Birth Certificate",      on: has("birthCertificate",   identity.hasBirthCertOnFile) },
    { label: "Medical Insurance",      on: has("medicalInsurance",   false) },
    { label: "Diploma (HS / GED)",     on: has("hsDiploma",          latestIntake?.education?.hs?.diplomaOnFile) },
  ];
  if (isAmIndian) {
    checks.push({ label: "CDIB Card", on: !!master.cdibCard });
  }
  if (isVeteran) {
    const vet = identity.veteranInfo || {};
    checks.push({ label: "DD-214",  on: has("dd214",  vet.dd214OnFile) });
    checks.push({ label: "VA Card", on: has("vaCard", vet.vaCardOnFile) });
  }

  const needed = checks.filter((c) => !c.on);
  const onFile = checks.filter((c) =>  c.on);
  const yn = (b) => b ? "Yes" : "No";
  const renderList = (items, emptyMsg) => items.length
    ? items.map((c) => `<li>${escapeHtml(c.label)}</li>`).join("")
    : `<li class="ir-empty">${escapeHtml(emptyMsg)}</li>`;

  return `
    <div class="intake-report">
      <div class="ir-header">
        <h1 class="ir-name">${escapeHtml(fullName)}</h1>
        <div class="ir-dob">Date of Birth: ${escapeHtml(dob)}</div>
      </div>
      ${isVeteran ? `<p class="ir-veteran">Veteran</p>` : ""}
      <div class="ir-contact">
        <div class="ir-row"><span>Client Has Phone</span><span>${yn(phone)}</span></div>
        <div class="ir-row"><span>Client Has Email</span><span>${yn(email)}</span></div>
      </div>
      <div class="ir-doc-block">
        <div class="ir-doc-col">
          <h3>Documents Needed</h3>
          <ul>${renderList(needed, "All documents on file")}</ul>
        </div>
        <div class="ir-doc-col">
          <h3>Documents on File</h3>
          <ul>${renderList(onFile, "None on file")}</ul>
        </div>
      </div>
      <div class="ir-status">
        <div class="ir-row"><span>Has Primary Medical Provider</span><span>${yn(primaryProvider)}</span></div>
        <div class="ir-row"><span>Has Counselor</span><span>${yn(counselor)}</span></div>
        <div class="ir-row"><span>HS / GED Graduate</span><span>${yn(hsGradStatus)}</span></div>
      </div>
      <p class="ir-foot">${escapeHtml(cid)} &middot; printed ${escapeHtml(new Date().toLocaleString())}</p>
    </div>
  `;
}

async function handleIntakeReportPrint() {
  const cid = currentDetailClientId;
  if (!cid) return;
  const btn = document.getElementById("client-intake-report-print");
  const origLabel = btn ? btn.textContent : null;
  if (btn) { btn.disabled = true; btn.textContent = "Preparing…"; }
  try {
    const [masterSnap, identitySnap, medicalSnap, intakesSnap] = await Promise.all([
      getDoc(doc(db, "clients", cid)),
      getDoc(doc(db, "clients", cid, "sensitive", "identity")),
      getDoc(doc(db, "clients", cid, "sensitive", "medical")),
      getDocs(query(
        collection(db, "intakes"),
        where("clientId", "==", cid),
        orderBy("intakeDate", "desc"),
        limit(1),
      )),
    ]);
    if (!masterSnap.exists()) {
      alert("Client record not found.");
      return;
    }
    const master = masterSnap.data();
    const identity = identitySnap.exists() ? identitySnap.data() : {};
    const medical = medicalSnap.exists() ? medicalSnap.data() : {};
    const latestIntake = intakesSnap.docs[0] ? intakesSnap.docs[0].data() : {};

    const content = document.getElementById("intake-report-print-content");
    if (!content) return;
    content.innerHTML = renderIntakeReportHtml({ cid, master, identity, medical, latestIntake });
    document.body.classList.add("printing-intake-report");

    const cleanup = () => {
      document.body.classList.remove("printing-intake-report");
      window.removeEventListener("afterprint", cleanup);
    };
    window.addEventListener("afterprint", cleanup);
    setTimeout(() => window.print(), 50);

    // Reads sensitive subdocs (identity + medical) — log the view so the
    // access trail stays consistent with click-to-reveal on the detail page.
    await logAccess(AUDIT_ACTIONS.PRINT, "client", cid, {
      surface: "intake-report-print",
      readIdentity: identitySnap.exists(),
      readMedical: medicalSnap.exists(),
    });
  } catch (err) {
    console.error("[intake-report] print failed", err);
    alert(`Could not print intake report: ${err.message || err}`);
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = origLabel || "Print intake report"; }
  }
}

document.getElementById("client-intake-report-print")?.addEventListener("click", handleIntakeReportPrint);

// ============================================================
// Printable Client History Report
// ============================================================
//
// Superset of the intake report. Reuses the same Documents Needed / On File
// + provider/counselor/HS-grad summary, then adds: program state (level,
// leadership, current employer), every intake date, every exit date with
// reason + housing assessment + return policy, every drug test with full
// panel results, and every panel-review status update with its paragraph
// notes printed in full.

function renderHistoryReportHtml({
  cid, master, identity, medical, latestIntake,
  intakes, exits, drugTests, panelReviews,
}) {
  const intakeCore = renderIntakeReportHtml({ cid, master, identity, medical, latestIntake });

  const lvl = master.level ? String(master.level) : "(none)";
  const leadership = master.leadershipRole ? String(master.leadershipRole) : "(none)";
  const emp = master.currentEmployment || latestIntake?.employment || {};
  const employerLine = emp && (emp.employer || emp.wage || emp.skills)
    ? [emp.employer && `Employer: ${emp.employer}`,
       emp.wage && `Wage: ${emp.wage}`,
       emp.skills && `Skills: ${emp.skills}`].filter(Boolean).join(" &middot; ")
    : "(not employed / no data)";
  const status = master.status || "(unknown)";
  const intakeCount = typeof master.intakeCount === "number" ? master.intakeCount : null;
  const firstIntake = fmtDate(master.firstIntakeDate);
  const lastIntake = fmtDate(master.lastIntakeDate);
  const exitDate = fmtDate(master.exitDate);

  const intakesHtml = intakes.length
    ? `<ul>${intakes.map((it) => {
        const d = it.data;
        const date = fmtDate(d.intakeDate) || "(no date)";
        const flag = d.reentry ? " (re-entry)" : " (new)";
        const staff = d.staffEmail ? ` &mdash; staff ${escapeHtml(d.staffEmail)}` : "";
        return `<li>${escapeHtml(date)}${flag}${staff}</li>`;
      }).join("")}</ul>`
    : `<p>No intake records.</p>`;

  const exitsHtml = exits.length
    ? `<ul>${exits.map((ex) => {
        const d = ex.data;
        const date = fmtDate(d.exitDate) || "(no date)";
        const housing = HOUSING_LABELS[d.housingAssessment] || d.housingAssessment || "(no assessment)";
        const reason = d.reason ? ` &mdash; ${escapeHtml(d.reason)}` : "";
        const rpBits = [];
        if (d.noReturn) rpBits.push("NOT allowed to return");
        if (d.warnAtReturn) rpBits.push("warn at re-intake");
        if (d.eligibleToReturnDate) rpBits.push(`eligible ${fmtDate(d.eligibleToReturnDate) || ""}`);
        const rp = rpBits.length ? ` <span class="hr-positive">[${escapeHtml(rpBits.join("; "))}]</span>` : "";
        return `<li>${escapeHtml(date)} &rarr; ${escapeHtml(housing)}${reason}${rp}</li>`;
      }).join("")}</ul>`
    : `<p>No exit records.</p>`;

  const drugTestsHtml = drugTests.length
    ? drugTests.map((t) => {
        const d = t.data;
        const date = fmtDate(d.testDate) || fmtTimestamp(d.testDate) || "(no date)";
        const origin = d.intakeId ? "intake-time" : "random";
        const panel = d.panelResults || {};
        const allCodes = DRUG_PANEL.map(([code]) => code);
        const rows = allCodes.map((code) => {
          const v = panel[code];
          const cls = (v === "positive" || v === "faint") ? "hr-positive" : "";
          return `<li class="${cls}">${escapeHtml(code)}: ${escapeHtml(v || "—")}</li>`;
        }).join("");
        const obs = d.observerName ? `Observer: ${escapeHtml(d.observerName)}` : "";
        const adm = d.admittedToOtherDrugs ? `Admitted other: ${escapeHtml(d.admittedToOtherDrugs)}` : "";
        const agr = d.guestAgreesWithResults ? `Guest agrees: ${escapeHtml(d.guestAgreesWithResults)}` : "";
        const metaLine = [obs, adm, agr].filter(Boolean).join(" &middot; ");
        const notes = d.notes ? `<div class="hr-notes">${escapeHtml(d.notes)}</div>` : "";
        return `
          <div style="margin-bottom: 0.75rem;">
            <strong>${escapeHtml(date)}</strong> <span class="muted">(${escapeHtml(origin)})</span>
            ${metaLine ? `<div>${metaLine}</div>` : ""}
            <ul style="columns: 3; -webkit-columns: 3; margin-top: 0.2rem;">${rows}</ul>
            ${notes}
          </div>
        `;
      }).join("")
    : `<p>No drug tests on file.</p>`;

  const panelHtml = panelReviews.length
    ? panelReviews.map((p) => {
        const d = p.data;
        const date = fmtDate(d.occurredOn) || "(no date)";
        const by = d.recordedBy ? ` &mdash; ${escapeHtml(d.recordedBy)}` : "";
        return `
          <div style="margin-bottom: 0.6rem;">
            <strong>${escapeHtml(date)}</strong>${by}
            ${d.notes ? `<div class="hr-notes">${escapeHtml(d.notes)}</div>` : `<div class="muted">(no notes)</div>`}
          </div>
        `;
      }).join("")
    : `<p>No panel reviews recorded.</p>`;

  return `
    <div class="intake-report history-report">
      ${intakeCore}
      <h2>Program status</h2>
      <div class="hr-row"><span>Status</span><span>${escapeHtml(status)}</span></div>
      <div class="hr-row"><span>Level</span><span>${escapeHtml(lvl)}</span></div>
      <div class="hr-row"><span>Leadership role</span><span>${escapeHtml(leadership)}</span></div>
      ${intakeCount != null ? `<div class="hr-row"><span>Intake count</span><span>${intakeCount}</span></div>` : ""}
      ${firstIntake ? `<div class="hr-row"><span>First intake</span><span>${escapeHtml(firstIntake)}</span></div>` : ""}
      ${lastIntake ? `<div class="hr-row"><span>Last intake</span><span>${escapeHtml(lastIntake)}</span></div>` : ""}
      ${exitDate ? `<div class="hr-row"><span>Latest exit</span><span>${escapeHtml(exitDate)}</span></div>` : ""}

      <h2>Job / employer</h2>
      <p>${employerLine}</p>

      <h2>Intake history (${intakes.length})</h2>
      ${intakesHtml}

      <h2>Exit history (${exits.length})</h2>
      ${exitsHtml}

      <h2>Drug test history (${drugTests.length})</h2>
      ${drugTestsHtml}

      <h2>Panel Results (${panelReviews.length})</h2>
      ${panelHtml}

      <p class="ir-foot">${escapeHtml(cid)} &middot; history report printed ${escapeHtml(new Date().toLocaleString())}</p>
    </div>
  `;
}

async function handleHistoryReportPrint() {
  const cid = currentDetailClientId;
  if (!cid) return;
  const btn = document.getElementById("client-history-report-print");
  const origLabel = btn ? btn.textContent : null;
  if (btn) { btn.disabled = true; btn.textContent = "Preparing…"; }
  try {
    const [
      masterSnap, identitySnap, medicalSnap,
      intakesSnap, exitsSnap, drugTestsSnap, statusSnap,
    ] = await Promise.all([
      getDoc(doc(db, "clients", cid)),
      getDoc(doc(db, "clients", cid, "sensitive", "identity")),
      getDoc(doc(db, "clients", cid, "sensitive", "medical")),
      getDocs(query(collection(db, "intakes"), where("clientId", "==", cid), orderBy("intakeDate", "desc"))),
      getDocs(query(collection(db, "exits"), where("clientId", "==", cid), orderBy("exitDate", "desc"))),
      getDocs(query(collection(db, "drugTests"), where("clientId", "==", cid))),
      // Pulls every status update for this client; we filter to panelResults
      // client-side so the existing (clientId asc, occurredOn desc) index
      // is sufficient — no extra composite index needed.
      getDocs(query(
        collection(db, "clientStatusUpdates"),
        where("clientId", "==", cid),
        orderBy("occurredOn", "desc"),
      )),
    ]);
    if (!masterSnap.exists()) {
      alert("Client record not found.");
      return;
    }
    const master = masterSnap.data();
    const identity = identitySnap.exists() ? identitySnap.data() : {};
    const medical = medicalSnap.exists() ? medicalSnap.data() : {};
    const intakes = intakesSnap.docs.map((d) => ({ id: d.id, data: d.data() }));
    const latestIntake = intakes[0]?.data || {};
    const exits = exitsSnap.docs.map((d) => ({ id: d.id, data: d.data() }));
    const drugTests = drugTestsSnap.docs
      .map((d) => ({ id: d.id, data: d.data() }))
      .sort((a, b) => tsMs(b.data.testDate) - tsMs(a.data.testDate));
    const panelReviews = statusSnap.docs
      .map((d) => ({ id: d.id, data: d.data() }))
      .filter((r) => r.data.updateType === "panelResults");

    const content = document.getElementById("history-report-print-content");
    if (!content) return;
    content.innerHTML = renderHistoryReportHtml({
      cid, master, identity, medical, latestIntake,
      intakes, exits, drugTests, panelReviews,
    });
    document.body.classList.add("printing-history-report");

    const cleanup = () => {
      document.body.classList.remove("printing-history-report");
      window.removeEventListener("afterprint", cleanup);
    };
    window.addEventListener("afterprint", cleanup);
    setTimeout(() => window.print(), 50);

    await logAccess(AUDIT_ACTIONS.PRINT, "client", cid, {
      surface: "history-report-print",
      readIdentity: identitySnap.exists(),
      readMedical: medicalSnap.exists(),
      intakeCount: intakes.length,
      exitCount: exits.length,
      drugTestCount: drugTests.length,
      panelResultCount: panelReviews.length,
    });
  } catch (err) {
    console.error("[history-report] print failed", err);
    alert(`Could not print history report: ${err.message || err}`);
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = origLabel || "Print history report"; }
  }
}

document.getElementById("client-history-report-print")?.addEventListener("click", handleHistoryReportPrint);

// ============================================================
// Reusable client picker
// ============================================================
//
// createClientPicker moved to shared/client-picker.js (imported at top).
// The self-eval picker init below stays here until features/self-eval.js
// is extracted (Phase 2.2).

const selfEvalPickerRoot = document.getElementById("self-eval-client-picker");
if (selfEvalPickerRoot) {
  selfEvalClientPicker = createClientPicker({ root: selfEvalPickerRoot });
}

// ============================================================

// ---------- Consents ----------

async function loadClientConsents(cid) {
  const el = document.getElementById("client-consents");
  try {
    const snap = await getDocs(collection(db, "clients", cid, "consents"));
    if (snap.empty) {
      el.innerHTML = `<p class="note">No consents on file.</p>`;
      return;
    }
    const rows = snap.docs.map((d) => ({ id: d.id, data: d.data() }));
    rows.sort((a, b) => {
      const ea = a.data.effectiveDate?.toMillis ? a.data.effectiveDate.toMillis() : 0;
      const eb = b.data.effectiveDate?.toMillis ? b.data.effectiveDate.toMillis() : 0;
      return eb - ea;
    });
    el.innerHTML = rows.map(({ id, data }) => {
      const typeLabel = data.consentType === "photoVideo"
        ? "Photo / video release"
        : (data.consentType || "(consent)");
      const statusText = data.status === "accept" ? "Accepted"
        : data.status === "deny" ? "Denied"
        : (data.status || "(no status)");
      const statusClass = data.status === "accept" ? "accepted"
        : data.status === "deny" ? "denied"
        : "muted";
      return `
        <div class="consent-row">
          <div class="consent-row-header">
            <strong>${escapeHtml(typeLabel)}</strong>
            <span class="${statusClass}">${escapeHtml(statusText)}</span>
          </div>
          <div class="meta">Effective ${escapeHtml(fmtTimestamp(data.effectiveDate) || "(no date)")}</div>
          <div class="meta">Recorded by ${escapeHtml(data.enteredBy || "(unknown)")}</div>
          <div class="meta">Consent ID: <code>${escapeHtml(id)}</code></div>
        </div>
      `;
    }).join("");
  } catch (err) {
    el.innerHTML = `<p class="error">Could not load consents: ${escapeHtml(err.message)}</p>`;
  }
}

// ============================================================
// Scanned documents (state ID, SSC, birth cert, transcripts, etc.)
// ============================================================
//
// Replaces the paper-folder workflow of photocopied identity / education /
// insurance / library cards. Each scanned doc is one Firestore record at
// clients/{cid}/scannedDocs/{auto} with file paths into Cloud Storage at
// clients/{cid}/documents/{type}/{auto}-front.{ext} and -back.{ext}.
// Staff upload from the client detail page; clients view their own from
// the client app. Each open writes an accessLog 'view' entry tagged with
// the doc type.

const SCANNED_DOC_TYPES = [
  "stateID", "ssc", "birthCert", "transcript", "diploma", "insurance", "library",
  "cdib", "vaCard", "dd214", "programCert", "panelResults", "significantEvents",
];
const SCANNED_DOC_LABELS = {
  stateID:           "State ID / Driver's License",
  ssc:               "Social Security Card",
  birthCert:         "Birth Certificate",
  transcript:        "School Transcript",
  diploma:           "Diploma / GED",
  insurance:         "Medical Insurance Card",
  library:           "Library Card",
  cdib:              "CDIB",
  vaCard:            "VA Card",
  dd214:             "DD-214",
  programCert:       "Program Certifications",
  panelResults:      "Panel Results",
  significantEvents: "Significant Events",
};
const SCANNED_DOC_MAX_BYTES = 10 * 1024 * 1024;

function scannedDocExtFromFile(file) {
  if (file.type === "application/pdf") return "pdf";
  // For images, prefer the file's extension when present; otherwise fall
  // back to "jpg" since most phone captures land as JPEG anyway.
  const m = (file.name || "").match(/\.([a-z0-9]{2,4})$/i);
  if (m) return m[1].toLowerCase();
  return "jpg";
}

async function loadClientScannedDocs(cid) {
  const el = document.getElementById("client-scanned-docs");
  if (!el) return;
  try {
    const snap = await getDocs(collection(db, "clients", cid, "scannedDocs"));
    const rows = snap.docs
      .map((d) => ({ id: d.id, data: d.data() }))
      .sort((a, b) => {
        const ua = a.data.uploadedAt?.toMillis ? a.data.uploadedAt.toMillis() : 0;
        const ub = b.data.uploadedAt?.toMillis ? b.data.uploadedAt.toMillis() : 0;
        return ub - ua;
      });
    renderScannedDocsList(el, cid, rows, /* staffMode */ true);
  } catch (err) {
    el.innerHTML = `<p class="error">Could not load documents: ${escapeHtml(err.message)}</p>`;
  }
}

function renderScannedDocsList(el, cid, rows, staffMode) {
  const isAdminUser = staffMode && (currentUserRole === "admin"
    || isAdminEmail(auth.currentUser?.email));
  if (!rows.length) {
    el.innerHTML = `<p class="note">No scanned documents on file yet.</p>`;
    return;
  }
  // Group by type so the most relevant docs land near each other.
  const byType = {};
  for (const r of rows) {
    const t = r.data.type || "other";
    if (!byType[t]) byType[t] = [];
    byType[t].push(r);
  }
  const sections = [];
  for (const t of SCANNED_DOC_TYPES) {
    const list = byType[t];
    if (!list?.length) continue;
    sections.push(`
      <div class="scanned-doc-group">
        <h4>${escapeHtml(SCANNED_DOC_LABELS[t] || t)}</h4>
        ${list.map((r) => renderScannedDocRow(cid, r, staffMode, isAdminUser)).join("")}
      </div>
    `);
  }
  el.innerHTML = sections.join("");
}

function renderScannedDocRow(cid, { id, data }, staffMode, isAdminUser) {
  const label = data.label ? `<strong>${escapeHtml(data.label)}</strong>` : "";
  const meta = [];
  if (data.uploadedAt) meta.push(`Uploaded ${escapeHtml(fmtTimestamp(data.uploadedAt) || "")}`);
  if (staffMode && data.uploadedBy) meta.push(`by ${escapeHtml(data.uploadedBy)}`);
  if (data.notes) meta.push(escapeHtml(data.notes));
  const buttons = [];
  if (data.frontPath) {
    buttons.push(`<button type="button" class="ghost" data-action="view-doc" data-cid="${escapeHtml(cid)}" data-doc-id="${escapeHtml(id)}" data-side="front" data-doc-type="${escapeHtml(data.type || "")}">View front</button>`);
  }
  if (data.backPath) {
    buttons.push(`<button type="button" class="ghost" data-action="view-doc" data-cid="${escapeHtml(cid)}" data-doc-id="${escapeHtml(id)}" data-side="back" data-doc-type="${escapeHtml(data.type || "")}">View back</button>`);
  }
  if (staffMode && isAdminUser) {
    buttons.push(`<button type="button" class="ghost danger" data-action="delete-doc" data-cid="${escapeHtml(cid)}" data-doc-id="${escapeHtml(id)}">Delete</button>`);
  }
  return `
    <div class="scanned-doc-row">
      <div class="scanned-doc-row-info">
        ${label}
        ${meta.length ? `<div class="meta">${meta.join(" · ")}</div>` : ""}
      </div>
      <div class="scanned-doc-row-actions">${buttons.join("")}</div>
    </div>
  `;
}

async function viewScannedDocFile(cid, docId, side, docType) {
  // Load the storage path lazily so a stale render with a deleted doc
  // doesn't break — single read per click is cheap.
  try {
    const dref = doc(db, "clients", cid, "scannedDocs", docId);
    const dsnap = await getDoc(dref);
    if (!dsnap.exists()) {
      alert("Document was removed.");
      return;
    }
    const data = dsnap.data();
    const path = side === "back" ? data.backPath : data.frontPath;
    if (!path) {
      alert("That side hasn't been uploaded.");
      return;
    }
    const url = await getDownloadURL(storageRef(storage, path));
    // Open in a new tab — same UX as the ODH 206 PDF generator. The
    // browser's PDF viewer handles PDFs; image content opens inline.
    const w = window.open(url, "_blank", "noopener");
    if (!w) {
      // Pop-up blocked → fall back to direct navigation in current tab.
      location.href = url;
    }
    await logAccess(AUDIT_ACTIONS.VIEW, "scannedDoc", docId, {
      clientId: cid, docType, side,
      surface: currentUserRole === "client" ? "client-app" : "clients-detail",
    });
  } catch (err) {
    alert(`Could not open document: ${err.message}`);
  }
}

// ----- Upload modal -----

(function bindScannedDocUpload() {
  const openBtn = document.getElementById("scanned-doc-upload-btn");
  const modal = document.getElementById("scanned-doc-modal");
  const cancelBtn = document.getElementById("scanned-doc-cancel");
  const confirmBtn = document.getElementById("scanned-doc-confirm");
  const backdrop = document.getElementById("scanned-doc-modal-backdrop");
  if (!openBtn || !modal) return;
  const typeSel = document.getElementById("scanned-doc-type");
  const labelInput = document.getElementById("scanned-doc-label");
  const frontInput = document.getElementById("scanned-doc-front");
  const backInput = document.getElementById("scanned-doc-back");
  const notesInput = document.getElementById("scanned-doc-notes");
  const errEl = document.getElementById("scanned-doc-error");
  const progressEl = document.getElementById("scanned-doc-progress");

  function open() {
    typeSel.value = "";
    labelInput.value = "";
    frontInput.value = "";
    backInput.value = "";
    notesInput.value = "";
    errEl.hidden = true;
    progressEl.hidden = true;
    confirmBtn.disabled = false;
    modal.hidden = false;
  }
  function close() { modal.hidden = true; }
  function showError(msg) { errEl.textContent = msg; errEl.hidden = false; }
  function showProgress(msg) { progressEl.textContent = msg; progressEl.hidden = false; }

  openBtn.addEventListener("click", open);
  cancelBtn.addEventListener("click", close);
  backdrop.addEventListener("click", close);

  confirmBtn.addEventListener("click", async () => {
    const cid = currentDetailClientId;
    if (!cid) { close(); return; }
    const type = typeSel.value;
    if (!SCANNED_DOC_TYPES.includes(type)) { showError("Pick a document type."); return; }
    const front = frontInput.files?.[0];
    if (!front) { showError("Choose a front image or PDF."); return; }
    if (front.size > SCANNED_DOC_MAX_BYTES) {
      showError("Front file is over 10 MB. Try a smaller scan or split into pages.");
      return;
    }
    const back = backInput.files?.[0] || null;
    if (back && back.size > SCANNED_DOC_MAX_BYTES) {
      showError("Back file is over 10 MB.");
      return;
    }

    confirmBtn.disabled = true;
    errEl.hidden = true;
    showProgress("Uploading…");
    try {
      // Reserve a Firestore doc ID first so the storage filenames embed it.
      // Letting Firestore mint the ID + writing afterwards keeps everything
      // tied to the same identifier (front path / back path / doc id).
      const collRef = collection(db, "clients", cid, "scannedDocs");
      const newRef = doc(collRef);
      const docId = newRef.id;

      const frontExt = scannedDocExtFromFile(front);
      const frontPath = `clients/${cid}/documents/${type}/${docId}-front.${frontExt}`;
      await uploadBytes(storageRef(storage, frontPath), front, { contentType: front.type });

      let backPath = null;
      if (back) {
        const backExt = scannedDocExtFromFile(back);
        backPath = `clients/${cid}/documents/${type}/${docId}-back.${backExt}`;
        await uploadBytes(storageRef(storage, backPath), back, { contentType: back.type });
      }

      await setDoc(newRef, {
        type,
        label: (labelInput.value || "").trim(),
        notes: (notesInput.value || "").trim(),
        frontPath,
        backPath,
        frontContentType: front.type,
        backContentType: back?.type || null,
        uploadedAt: serverTimestamp(),
        uploadedBy: auth.currentUser.email,
      });

      await logAccess(AUDIT_ACTIONS.CREATE, "scannedDoc", docId, {
        clientId: cid, docType: type, hasBack: !!back,
        surface: "clients-detail",
      });

      close();
      await loadClientScannedDocs(cid);
    } catch (err) {
      showError(`Upload failed: ${err.message}`);
      confirmBtn.disabled = false;
    } finally {
      progressEl.hidden = true;
    }
  });
})();

// ============================================================
// PHI records — scans of medical records received under ODH 206
// ============================================================
//
// GSO receives full medical / mental-health / substance-abuse records ON
// PAPER from healthcare providers under a signed ODH 206 authorization
// (Daniel confirmed 2026-05-12 there's no fax/email path). The paper original
// goes in the locked cabinet; the scan goes here so it lives in the
// access-controlled system. Each record references the authId it was received
// under; the file lives in Cloud Storage at
// clients/{cid}/odh206/{authId}/{recId}.{ext} (≤50 MB, staff-only — storage
// rules already in place). Metadata at clients/{cid}/phiRecords/{recId}.
// Staff-only — NOT surfaced in the client app (unlike scannedDocs/photos,
// which are a client's own personal IDs). Every open writes an accessLog
// 'view' entry; admin-only delete.

const PHI_RECORD_MAX_BYTES = 50 * 1024 * 1024;

function phiRecordExtFromFile(file) {
  if (file.type === "application/pdf") return "pdf";
  const m = (file.name || "").match(/\.([a-z0-9]{2,5})$/i);
  if (m) return m[1].toLowerCase();
  if ((file.type || "").startsWith("image/")) return "jpg";
  return "bin";
}

// Short human label for an ODH 206 auth doc — used in the picker and stored
// (denormalized) on each phiRecord so the list renders without re-reading.
function odh206AuthLabel(id, data) {
  if (!data) return id;
  if (data.status === "declined") return `Declined (${fmtTimestamp(data.signedAt) || "?"})`;
  const who = data.disclosingParty || "(disclosing party not recorded)";
  const when = fmtDate(data.signedAt) || fmtTimestamp(data.signedAt) || "?";
  return `${who} — signed ${when}`;
}

async function loadClientPhiRecords(cid) {
  const el = document.getElementById("client-phi-records");
  if (!el) return;
  try {
    const snap = await getDocs(collection(db, "clients", cid, "phiRecords"));
    const rows = snap.docs.map((d) => ({ id: d.id, data: d.data() }))
      .sort((a, b) => {
        const ua = a.data.uploadedAt?.toMillis ? a.data.uploadedAt.toMillis() : 0;
        const ub = b.data.uploadedAt?.toMillis ? b.data.uploadedAt.toMillis() : 0;
        return ub - ua;
      });
    renderClientPhiRecords(el, cid, rows);
  } catch (err) {
    el.innerHTML = `<p class="error">Could not load PHI records: ${escapeHtml(err.message)}</p>`;
  }
}

function renderClientPhiRecords(el, cid, rows) {
  const isAdminUser = isCurrentUserAdmin();
  if (!rows.length) {
    el.innerHTML = `<p class="note">No PHI records uploaded yet.</p>`;
    return;
  }
  const byAuth = {};
  for (const r of rows) {
    const a = r.data.authId || "(no authorization)";
    (byAuth[a] = byAuth[a] || []).push(r);
  }
  el.innerHTML = Object.entries(byAuth).map(([authId, list]) => `
    <div class="scanned-doc-group">
      <h4>${escapeHtml(list[0]?.data.authLabel || authId)}</h4>
      ${list.map((r) => renderPhiRecordRow(cid, r, isAdminUser)).join("")}
    </div>`).join("");
}

function renderPhiRecordRow(cid, { id, data }, isAdminUser) {
  const title = `<strong>${escapeHtml(data.label || "(untitled)")}</strong>`;
  const meta = [];
  if (data.receivedOn) meta.push(`Received ${escapeHtml(data.receivedOn)}`);
  if (data.uploadedAt) meta.push(`Uploaded ${escapeHtml(fmtTimestamp(data.uploadedAt) || "")}`);
  if (data.uploadedBy) meta.push(`by ${escapeHtml(data.uploadedBy)}`);
  if (data.notes) meta.push(escapeHtml(data.notes));
  const buttons = [];
  if (data.path) {
    buttons.push(`<button type="button" class="ghost" data-action="view-phi" data-cid="${escapeHtml(cid)}" data-rec-id="${escapeHtml(id)}">View record</button>`);
  }
  if (isAdminUser) {
    buttons.push(`<button type="button" class="ghost danger" data-action="delete-phi" data-cid="${escapeHtml(cid)}" data-rec-id="${escapeHtml(id)}">Delete</button>`);
  }
  return `
    <div class="scanned-doc-row">
      <div class="scanned-doc-row-info">
        ${title}
        ${meta.length ? `<div class="meta">${meta.join(" · ")}</div>` : ""}
      </div>
      <div class="scanned-doc-row-actions">${buttons.join("")}</div>
    </div>`;
}

async function viewPhiRecordFile(cid, recId) {
  try {
    const dref = doc(db, "clients", cid, "phiRecords", recId);
    const dsnap = await getDoc(dref);
    if (!dsnap.exists()) { alert("Record was removed."); return; }
    const data = dsnap.data();
    if (!data.path) { alert("No file on this record."); return; }
    // Audit FIRST — opening a full medical record is the sensitive event, so
    // log it before handing back the URL (even if window.open is then blocked).
    await logAccess(AUDIT_ACTIONS.VIEW, "phiRecord", recId, {
      clientId: cid, authId: data.authId || null, surface: "clients-detail",
    });
    const url = await getDownloadURL(storageRef(storage, data.path));
    const w = window.open(url, "_blank", "noopener");
    if (!w) location.href = url;
  } catch (err) {
    alert(`Could not open record: ${err.message}`);
  }
}

async function deletePhiRecord(cid, recId, btn) {
  if (!isCurrentUserAdmin()) return;
  if (!confirm("Delete this PHI record? The scanned file is removed from storage too. (The paper original and the ODH 206 authorization record are not affected.)")) return;
  if (btn) btn.disabled = true;
  try {
    const dref = doc(db, "clients", cid, "phiRecords", recId);
    const dsnap = await getDoc(dref);
    const data = dsnap.exists() ? dsnap.data() : {};
    if (data.path) {
      try { await deleteObject(storageRef(storage, data.path)); } catch (e) { console.warn("storage delete:", e); }
    }
    await deleteDoc(dref);
    await logAccess(AUDIT_ACTIONS.DELETE, "phiRecord", recId, { clientId: cid, authId: data.authId || null, surface: "clients-detail" });
    await loadClientPhiRecords(cid);
  } catch (err) {
    alert("Delete failed: " + err.message);
    if (btn) btn.disabled = false;
  }
}

// ----- Upload modal -----
(function bindPhiRecordUpload() {
  const openBtn = document.getElementById("phi-record-upload-btn");
  const modal = document.getElementById("phi-record-modal");
  if (!openBtn || !modal) return;
  const cancelBtn = document.getElementById("phi-record-cancel");
  const confirmBtn = document.getElementById("phi-record-confirm");
  const backdrop = document.getElementById("phi-record-modal-backdrop");
  const authSel = document.getElementById("phi-record-auth");
  const labelInput = document.getElementById("phi-record-label");
  const receivedInput = document.getElementById("phi-record-received");
  const fileInput = document.getElementById("phi-record-file");
  const notesInput = document.getElementById("phi-record-notes");
  const errEl = document.getElementById("phi-record-error");
  const progressEl = document.getElementById("phi-record-progress");

  function showError(m) { errEl.textContent = m; errEl.hidden = false; }
  function showProgress(m) { progressEl.textContent = m; progressEl.hidden = false; }
  function close() { modal.hidden = true; }

  async function open() {
    const cid = currentDetailClientId;
    if (!cid) return;
    labelInput.value = ""; receivedInput.value = ""; fileInput.value = ""; notesInput.value = "";
    errEl.hidden = true; progressEl.hidden = true;
    authSel.innerHTML = `<option value="">Loading authorizations…</option>`;
    confirmBtn.disabled = true;
    modal.hidden = false;
    try {
      const snap = await getDocs(collection(db, "clients", cid, "odh206"));
      const rows = snap.docs.map((d) => ({ id: d.id, data: d.data() }))
        .filter((r) => r.data.status !== "declined")
        .sort((a, b) => {
          const sa = a.data.signedAt?.toMillis ? a.data.signedAt.toMillis() : 0;
          const sb = b.data.signedAt?.toMillis ? b.data.signedAt.toMillis() : 0;
          return sb - sa;
        });
      if (!rows.length) {
        authSel.innerHTML = `<option value="">— no ODH 206 authorizations on file —</option>`;
        showError("This client has no ODH 206 authorization on file. Record one in the ODH 206 authorizations section first.");
        confirmBtn.disabled = true;
        return;
      }
      authSel.innerHTML = `<option value="">— pick an authorization —</option>`
        + rows.map((r) => `<option value="${escapeHtml(r.id)}">${escapeHtml(odh206AuthLabel(r.id, r.data))}</option>`).join("");
      confirmBtn.disabled = false;
    } catch (err) {
      authSel.innerHTML = `<option value="">— could not load —</option>`;
      showError(`Could not load authorizations: ${err.message}`);
    }
  }

  openBtn.addEventListener("click", open);
  cancelBtn.addEventListener("click", close);
  backdrop.addEventListener("click", close);

  confirmBtn.addEventListener("click", async () => {
    const cid = currentDetailClientId;
    if (!cid) { close(); return; }
    const authId = authSel.value;
    if (!authId) { showError("Pick the ODH 206 authorization this record came in under."); return; }
    const file = fileInput.files?.[0];
    if (!file) { showError("Choose the scanned file (PDF or image)."); return; }
    if (file.size > PHI_RECORD_MAX_BYTES) { showError("File is over 50 MB. Compress it or split into parts."); return; }
    const authLabel = authSel.options[authSel.selectedIndex]?.text || authId;

    confirmBtn.disabled = true;
    errEl.hidden = true;
    showProgress("Uploading…");
    try {
      const newRef = doc(collection(db, "clients", cid, "phiRecords"));
      const recId = newRef.id;
      const ext = phiRecordExtFromFile(file);
      const path = `clients/${cid}/odh206/${authId}/${recId}.${ext}`;
      await uploadBytes(storageRef(storage, path), file, { contentType: file.type || "application/octet-stream" });
      await setDoc(newRef, {
        authId,
        authLabel,
        label: (labelInput.value || "").trim(),
        notes: (notesInput.value || "").trim(),
        receivedOn: receivedInput.value || null,
        path,
        contentType: file.type || null,
        uploadedAt: serverTimestamp(),
        uploadedBy: auth.currentUser.email,
      });
      await logAccess(AUDIT_ACTIONS.CREATE, "phiRecord", recId, { clientId: cid, authId, surface: "clients-detail" });
      close();
      await loadClientPhiRecords(cid);
    } catch (err) {
      showError(`Upload failed: ${err.message}`);
      confirmBtn.disabled = false;
    } finally {
      progressEl.hidden = true;
    }
  });
})();

// ============================================================
// Intake re-entry (existing client returning)
// ============================================================
//
// Mounting the client picker on the intake form turns the picker into a
// "this is a re-entry" toggle. Selecting a client:
//   1. fetches master + sensitive/identity + sensitive/medical + latest
//      intake snapshot
//   2. pre-fills every form field from those records
//   3. shows the existing photo (if on file) — staying as-is unless staff
//      retakes; uploadIntakeMedia preserves master.photoPath when no new
//      blob is captured
//   4. logs `view client/identity/medical` to accessLog (PHI access)
//   5. flips the submit handler to call createClient with
//      existingClientId, which routes the save through saveReentryIntake
//      (master is updated, intakeCount bumped, new event docs created).
// Clearing the picker — chip ×, or after a successful save — calls
// resetIntakeForm and endReentry to wipe stale prefill.

const reentryBannerEl = () => document.getElementById("reentry-banner");
const reentryPrefillStatusEl = () => document.getElementById("reentry-prefill-status");
const intakeSubmitBtnEl = () => document.getElementById("intake-submit");

function setReentryPrefillStatus(msg, kind = "note") {
  const el = reentryPrefillStatusEl();
  if (!el) return;
  if (!msg) {
    el.hidden = true;
    el.textContent = "";
    el.className = "note";
    return;
  }
  el.hidden = false;
  el.textContent = msg;
  el.className = kind === "error" ? "error" : "note";
}

function resetIntakeForm() {
  if (!intakeForm) return;
  intakeForm.reset();
  // Default the intake date to today after the form reset blanks it. Staff
  // override this when backfilling a current or past client.
  const dateInput = intakeForm.elements.intakeDate;
  if (dateInput) dateInput.value = todayLocalDate();
  selectedMedications.length = 0;
  renderMedList();
  resetPhotoUI();
  sigGuestPad?.clear();
  sigStaffPad?.clear();
  setPhotoVideoConsentStatus(null);
  if (odh206ReadStatus) {
    odh206ReadStatus.textContent = "Not yet reviewed by client";
    odh206ReadStatus.classList.remove("reviewed");
    odh206ReadStatus.classList.add("muted");
  }
  if (odh206ReviewedInput) odh206ReviewedInput.value = "";
  // Reset conditional sections to hidden after form reset
  [
    "conditional-amindian", "conditional-veteran", "conditional-ec2",
    "conditional-hs-grad", "conditional-college",
    "conditional-insurance", "conditional-previous-guest",
    "conditional-public-housing", "conditional-government-benefits",
    "conditional-employed", "conditional-odh206",
  ].forEach((id) => {
    const el = document.getElementById(id);
    if (el) el.hidden = true;
  });
  const addEcBtn = document.getElementById("add-emergency-contact-btn");
  if (addEcBtn) addEcBtn.hidden = false;
}

function endReentry() {
  reentryClientId = null;
  const banner = reentryBannerEl();
  if (banner) {
    banner.hidden = true;
    banner.innerHTML = "";
  }
  setReentryPrefillStatus(null);
  const btn = intakeSubmitBtnEl();
  if (btn) btn.textContent = "Save Intake";
}

async function prefillExistingPhoto(photoPath) {
  if (!photoPath) return;
  const photoPreview = document.getElementById("photo-preview");
  const photoPreviewSection = document.getElementById("photo-preview-section");
  const photoControls = document.getElementById("photo-controls");
  if (!photoPreview || !photoPreviewSection || !photoControls) return;
  try {
    const url = await getDownloadURL(storageRef(storage, photoPath));
    photoPreview.src = url;
    photoPreviewSection.hidden = false;
    photoControls.hidden = true;
    setPhotoStatus("Existing photo on file. Click 'Retake / replace' to take a new one; otherwise the existing photo stays.");
  } catch (err) {
    console.warn("photo prefill failed:", err);
  }
}

function setIntakeFieldValue(name, value) {
  if (value === null || value === undefined) return;
  const el = intakeForm.querySelector(`[name="${name}"]`);
  if (!el) return;
  if (el.type === "checkbox") el.checked = !!value;
  else el.value = value;
}

function dobToInputValue(dob) {
  if (!dob) return null;
  const d = typeof dob.toDate === "function" ? dob.toDate() : dob;
  if (!(d instanceof Date) || isNaN(d)) return null;
  // YYYY-MM-DD in local time
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function applyMasterPrefill(master) {
  setIntakeFieldValue("firstName", master.firstName);
  setIntakeFieldValue("middleName", master.middleName);
  setIntakeFieldValue("lastName", master.lastName);
  setIntakeFieldValue("alias", master.alias);
  setIntakeFieldValue("dob", dobToInputValue(master.dob));
  setIntakeFieldValue("maritalStatus", master.maritalStatus);

  // Demographics: race/ethnicity is multi-checkbox
  const races = Array.isArray(master.raceEthnicity) ? master.raceEthnicity : [];
  intakeForm.querySelectorAll('input[name="raceEthnicity"]').forEach((cb) => {
    cb.checked = races.includes(cb.value);
  });
  setIntakeFieldValue("hispanicLatino", master.hispanicLatino);
  setIntakeFieldValue("tribe", master.tribe);
  setIntakeFieldValue("cdibCard", master.cdibCard);
  setIntakeFieldValue("veteran",
    master.veteran === true ? "yes" : master.veteran === false ? "no" : "");

  // Contact + emergency contacts (master)
  setIntakeFieldValue("phone", master.contact?.phone);
  setIntakeFieldValue("email", master.contact?.email);
  const ec = Array.isArray(master.emergencyContacts) ? master.emergencyContacts : [];
  if (ec[0]) {
    setIntakeFieldValue("ec1Name", ec[0].name);
    setIntakeFieldValue("ec1Relationship", ec[0].relationship);
    setIntakeFieldValue("ec1Phone", ec[0].phone);
  }
  if (ec[1]) {
    setIntakeFieldValue("ec2Name", ec[1].name);
    setIntakeFieldValue("ec2Relationship", ec[1].relationship);
    setIntakeFieldValue("ec2Phone", ec[1].phone);
    const ec2Panel = document.getElementById("conditional-ec2");
    const addEcBtn = document.getElementById("add-emergency-contact-btn");
    if (ec2Panel) ec2Panel.hidden = false;
    if (addEcBtn) addEcBtn.hidden = true;
  }

  // Employment from master.currentEmployment (snapshot)
  if (master.currentEmployment) {
    setIntakeFieldValue("employer", master.currentEmployment.employer);
    setIntakeFieldValue("wage", master.currentEmployment.wage);
    setIntakeFieldValue("skills", master.currentEmployment.skills);
  }
}

function applyIdentityPrefill(identity) {
  if (!identity) return;
  const ssn = identity.ssnFormatted
    || (identity.ssnFull ? formatSsn(identity.ssnFull) : null);
  setIntakeFieldValue("ssn", ssn);
  setIntakeFieldValue("placeOfBirth", identity.placeOfBirth);
  setIntakeFieldValue("dlState", identity.driversLicense?.state);
  setIntakeFieldValue("dlNumber", identity.driversLicense?.number);
  setIntakeFieldValue("stateIdState", identity.stateID?.state);
  setIntakeFieldValue("stateIdNumber", identity.stateID?.number);
  setIntakeFieldValue("hasBirthCertOnFile", identity.hasBirthCertOnFile);
  setIntakeFieldValue("hasSSCOnFile", identity.hasSSCOnFile);
  setIntakeFieldValue("hasDLOnFile", identity.hasDLOnFile);
  if (identity.veteranInfo) {
    setIntakeFieldValue("militaryBranch", identity.veteranInfo.militaryBranch);
    setIntakeFieldValue("yearsServed", identity.veteranInfo.yearsServed);
    setIntakeFieldValue("vaCardOnFile", identity.veteranInfo.vaCardOnFile);
    setIntakeFieldValue("dd214OnFile", identity.veteranInfo.dd214OnFile);
  }
}

function applyMedicalPrefill(medical) {
  if (!medical) return;
  setIntakeFieldValue("specialNeeds", medical.specialNeeds);
  if (medical.healthInsurance) {
    setIntakeFieldValue("hasInsurance", medical.healthInsurance.hasInsurance);
    setIntakeFieldValue("medicaidNumber", medical.healthInsurance.medicaidNumber);
    setIntakeFieldValue("medicareNumber", medical.healthInsurance.medicareNumber);
    setIntakeFieldValue("privateNumber", medical.healthInsurance.privateNumber);
  }
  if (medical.healthcareHistory) {
    setIntakeFieldValue("whereTreated", medical.healthcareHistory.whereTreated);
    setIntakeFieldValue("yearOfDiagnosis", medical.healthcareHistory.yearOfDiagnosis);
    setIntakeFieldValue("primaryPhysician", medical.healthcareHistory.primaryPhysician);
    setIntakeFieldValue("counselor", medical.healthcareHistory.counselor);
    setIntakeFieldValue("pharmacy", medical.healthcareHistory.pharmacy);
  }
  if (medical.governmentBenefits) {
    setIntakeFieldValue("receivesGovernmentBenefits", medical.governmentBenefits.receiving);
    const items = Array.isArray(medical.governmentBenefits.items) ? medical.governmentBenefits.items : [];
    const byType = new Map(items.map((it) => [it.type, it]));
    for (const t of INTAKE_BENEFIT_TYPES) {
      const item = byType.get(t);
      setIntakeFieldValue(`benefit_${t}`, !!item);
      setIntakeFieldValue(`benefitAmount_${t}`, item?.monthlyAmount ?? null);
    }
    setIntakeFieldValue("benefitsNotes", medical.governmentBenefits.notes);
  }
}

function applyLatestIntakePrefill(latest) {
  if (!latest) return;
  // Education snapshot was stored on the latest intake
  const ed = latest.education || null;
  if (ed) {
    setIntakeFieldValue("hsGradStatus", ed.hsGradStatus);
    setIntakeFieldValue("collegeStatus", ed.collegeStatus);
    if (ed.hs) {
      setIntakeFieldValue("hsYear", ed.hs.yearCompleted);
      setIntakeFieldValue("hsGraduationDate", ed.hs.graduationDate);
      setIntakeFieldValue("hsLocation", ed.hs.location);
      setIntakeFieldValue("hsDiplomaOnFile", ed.hs.diplomaOnFile);
      setIntakeFieldValue("hsTranscriptOnFile", ed.hs.transcriptOnFile);
    }
    if (ed.college) {
      setIntakeFieldValue("collegeSchool", ed.college.school);
      setIntakeFieldValue("collegeYears", ed.college.yearsAttended);
      setIntakeFieldValue("collegeDiplomaOnFile", ed.college.diplomaOnFile);
      setIntakeFieldValue("collegeTranscriptOnFile", ed.college.transcriptOnFile);
    }
  }
  // History — auto-set previousGuest=yes; staff updates current-state fields
  setIntakeFieldValue("previousGuest", "yes");
  if (latest.intakeDate?.toDate) {
    const d = latest.intakeDate.toDate();
    const monthYear = d.toLocaleDateString(undefined, { month: "long", year: "numeric" });
    setIntakeFieldValue("previousIntakeDate", monthYear);
  }
}

function dispatchAllConditionalTriggers() {
  // Conditional-section listeners are bound to "change" events on selects
  // and checkboxes. Programmatic value-setting doesn't fire those, so we
  // dispatch a synthetic change on every relevant element after prefill.
  intakeForm.querySelectorAll('select, input[type="checkbox"]').forEach((el) => {
    el.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

async function startReentry(client) {
  reentryClientId = client.clientId;

  // Wipe any prior prefill or in-progress data so re-entry starts clean
  resetIntakeForm();

  const banner = reentryBannerEl();
  if (banner) {
    // Surface the return policy from the prior exit so staff see it at the
    // top of the form. setBy/setAt aren't shown — just the actionable flags.
    const rp = client.data?.returnPolicy || null;
    const rpParts = [];
    if (rp?.noReturn) {
      rpParts.push(`<strong class="error">This client is flagged as NOT allowed to return.</strong>`);
    }
    if (rp?.warnAtReturn) {
      rpParts.push(`<strong class="error">Warning:</strong> review this client's past history before proceeding.`);
    }
    if (rp?.eligibleToReturnDate) {
      const elig = fmtDate(rp.eligibleToReturnDate);
      const eligMs = tsMs(rp.eligibleToReturnDate);
      const stillRestricted = eligMs && eligMs > Date.now();
      rpParts.push(`Eligible to return on <strong>${escapeHtml(elig || "")}</strong>${stillRestricted ? ` <span class="error">(not yet reached)</span>` : ""}.`);
    }
    const rpHtml = rpParts.length
      ? `<div class="error" style="margin-top: 0.5rem;">${rpParts.join("<br/>")}</div>`
      : "";
    banner.innerHTML = `<strong>Re-entry intake</strong> for ${escapeHtml(client.name)} (<code>${escapeHtml(client.clientId)}</code>). Form pre-filled from prior record &mdash; review every section before saving. Drug screen, signatures, and consents must be re-collected.${rpHtml}`;
    banner.hidden = false;
  }
  const submitBtn = intakeSubmitBtnEl();
  if (submitBtn) {
    submitBtn.textContent = "Save re-entry intake";
    submitBtn.disabled = true;
  }
  setReentryPrefillStatus("Loading prior record…");

  await logAccess(AUDIT_ACTIONS.VIEW, "client", client.clientId, {
    surface: "intake-reentry-prefill",
  });

  try {
    const cid = client.clientId;
    const [identitySnap, medicalSnap, latestIntakeSnap] = await Promise.all([
      getDoc(doc(db, "clients", cid, "sensitive", "identity")),
      getDoc(doc(db, "clients", cid, "sensitive", "medical")),
      getDocs(query(
        collection(db, "intakes"),
        where("clientId", "==", cid),
        orderBy("intakeDate", "desc"),
        limit(1),
      )),
    ]);

    if (identitySnap.exists()) {
      await logAccess(AUDIT_ACTIONS.VIEW, "identity", cid, {
        surface: "intake-reentry-prefill",
      });
    }
    if (medicalSnap.exists()) {
      await logAccess(AUDIT_ACTIONS.VIEW, "medical", cid, {
        surface: "intake-reentry-prefill",
      });
    }

    applyMasterPrefill(client.data);
    if (identitySnap.exists()) applyIdentityPrefill(identitySnap.data());
    if (medicalSnap.exists()) applyMedicalPrefill(medicalSnap.data());
    if (!latestIntakeSnap.empty) applyLatestIntakePrefill(latestIntakeSnap.docs[0].data());

    dispatchAllConditionalTriggers();

    if (client.data.photoPath) {
      await prefillExistingPhoto(client.data.photoPath);
    }

    setReentryPrefillStatus(`Prefilled from ${client.data.intakeCount || 1} prior intake(s). Verify every field.`);
  } catch (err) {
    setReentryPrefillStatus(`Prefill failed: ${err.message}. You can still proceed manually.`, "error");
  } finally {
    if (submitBtn) submitBtn.disabled = false;
  }
}

const intakeReentryRoot = document.getElementById("reentry-client-picker");
if (intakeReentryRoot) {
  intakeReentryPicker = createClientPicker({
    root: intakeReentryRoot,
    placeholder: "Search existing clients to start re-entry…",
    onChange(client) {
      if (client) {
        startReentry(client);
      } else {
        // User cleared the chip × OR successful save called clear().
        // Either way: wipe stale prefill and exit re-entry mode.
        endReentry();
        resetIntakeForm();
      }
    },
  });
}

// ============================================================
// Exit slice
// ============================================================
//
// Records a guest exiting GSO. Form lives on the Exit tab; client picker
// is required before the form body shows. Save runs a single transaction
// (read master → set exits/{exitId} → update master.status='exited' +
// lastExitId + exitReasonCategory + exitDate), then uploads guest + staff
// signatures in parallel and patches the exit doc with the storage paths.
// Exit history list is rendered in the client detail view below intakes.

const HOUSING_LABELS = {
  newHousingUnit: "Moved to a new housing unit",
  familyFriends: "Moved in with family or friends",
  transitionalHousing: "Moved to transitional or temporary housing",
  shelterOrUnfit: "Moved to a shelter or place unfit for humans",
  drugRehab: "Moved to drug rehabilitation",
  mentalHealthInpatient: "Moved to mental health inpatient",
  jail: "Client went to jail",
  deceased: "Client died",
  refused: "Client refused to provide",
  other: "Other / unknown",
};

let exitClientPicker = null;
let exitSigGuestPad = null;
let exitSigStaffPad = null;
let exitSelectedClient = null;

const exitForm = document.getElementById("exit-form");
const exitFormBody = document.getElementById("exit-form-body");
const exitStatus = document.getElementById("exit-status");
const exitSuccess = document.getElementById("exit-success");

function showExitError(msg) {
  if (!exitStatus) return;
  exitStatus.textContent = msg;
  exitStatus.classList.remove("status");
  exitStatus.classList.add("error");
  exitStatus.hidden = false;
}

function resetExitForm() {
  if (!exitForm) return;
  exitForm.reset();
  if (exitFormBody) exitFormBody.hidden = true;
  if (exitStatus) exitStatus.hidden = true;
  exitSigGuestPad?.clear();
  exitSigStaffPad?.clear();
}

function showExitSuccess(client, exitId, data, sigPaths, sigErrors) {
  document.getElementById("exit-success-cid").textContent = client.clientId;
  document.getElementById("exit-success-eid").textContent = exitId;
  document.getElementById("exit-success-name").textContent = client.name;
  document.getElementById("exit-success-reason").textContent =
    HOUSING_LABELS[data.housingAssessment] || data.housingAssessment;
  // exitDate is a Firestore Timestamp at this point
  const dateStr = data.exitDate?.toDate
    ? data.exitDate.toDate().toLocaleDateString()
    : "";
  document.getElementById("exit-success-date").textContent = dateStr;

  const uploadsEl = document.getElementById("exit-success-uploads");
  const parts = [];
  if (sigPaths.guest) parts.push("guest signature");
  if (sigPaths.staff) parts.push("staff signature");
  uploadsEl.textContent = parts.length ? `Uploaded: ${parts.join(", ")}` : "No signatures captured";
  if (sigErrors.length) uploadsEl.textContent += ` — errors: ${sigErrors.join("; ")}`;

  if (exitSuccess) {
    exitSuccess.hidden = false;
    exitSuccess.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }
}

async function handleExitSubmit(e) {
  e.preventDefault();
  if (!exitStatus) return;
  exitStatus.hidden = true;
  exitStatus.classList.remove("error");

  if (!exitSelectedClient) {
    showExitError("Please select a client first.");
    return;
  }

  const fd = new FormData(exitForm);
  const exitDateStr = fd.get("exitDate");
  const exitDateValue = exitDateStr ? new Date(exitDateStr + "T00:00:00") : null;
  if (!exitDateValue || isNaN(exitDateValue)) {
    showExitError("Invalid exit date.");
    return;
  }
  const housingAssessment = fd.get("housingAssessment");
  if (!housingAssessment) {
    showExitError("Please select a housing assessment.");
    return;
  }

  // Return-eligibility policy (mirrors onto master so re-entry intake
  // can surface a warning banner). eligibleToReturnDate is optional;
  // noReturn / warnAtReturn are booleans.
  const eligibleStr = fd.get("eligibleToReturnDate");
  const eligibleValue = eligibleStr ? new Date(eligibleStr + "T00:00:00") : null;
  if (eligibleStr && (!eligibleValue || isNaN(eligibleValue))) {
    showExitError("Invalid eligible-to-return date.");
    return;
  }
  const eligibleToReturnTs = eligibleValue ? Timestamp.fromDate(eligibleValue) : null;
  const noReturn = !!fd.get("noReturn");
  const warnAtReturn = !!fd.get("warnAtReturn");

  const exitData = {
    clientId: exitSelectedClient.clientId,
    clientName: exitSelectedClient.name,
    exitDate: Timestamp.fromDate(exitDateValue),
    reason: trimOrNull(fd.get("exitReason")),
    housingAssessment,
    ackPersonalItems48h: !!fd.get("ackPersonalItems48h"),
    ackMail: !!fd.get("ackMail"),
    notes: trimOrNull(fd.get("exitNotes")),
    guestNamePrinted: trimOrNull(fd.get("guestNamePrinted")),
    eligibleToReturnDate: eligibleToReturnTs,
    noReturn,
    warnAtReturn,
    enteredBy: auth.currentUser.email,
    enteredAt: serverTimestamp(),
  };

  const submitBtn = document.getElementById("exit-submit");
  if (submitBtn) submitBtn.disabled = true;

  try {
    const exitRef = doc(collection(db, "exits"));
    let freedBedId = null;
    await runTransaction(db, async (txn) => {
      const masterRef = doc(db, "clients", exitSelectedClient.clientId);
      const masterSnap = await txn.get(masterRef);
      if (!masterSnap.exists()) {
        throw new Error(`Client ${exitSelectedClient.clientId} no longer exists.`);
      }
      const masterData = masterSnap.data();
      const oldBedId = masterData.bedAssignment?.bedId || null;
      let oldBedSnap = null;
      if (oldBedId) {
        // All reads in a Firestore transaction must precede any writes.
        oldBedSnap = await txn.get(doc(db, "beds", oldBedId));
      }
      txn.set(exitRef, exitData);
      txn.update(masterRef, {
        status: "exited",
        exitDate: serverTimestamp(),
        lastExitId: exitRef.id,
        exitReasonCategory: housingAssessment,
        bedAssignment: null,
        returnPolicy: {
          eligibleToReturnDate: eligibleToReturnTs,
          noReturn,
          warnAtReturn,
          setByExitId: exitRef.id,
          setAt: serverTimestamp(),
          setBy: auth.currentUser.email,
        },
      });
      if (oldBedId && oldBedSnap?.exists()
          && oldBedSnap.data().occupiedBy === exitSelectedClient.clientId) {
        txn.update(doc(db, "beds", oldBedId), {
          occupiedBy: null,
          occupiedByName: null,
          occupiedSince: null,
          assignedBy: null,
          updatedAt: serverTimestamp(),
          updatedBy: auth.currentUser.email,
        });
        freedBedId = oldBedId;
      }
    });

    await logAccess(AUDIT_ACTIONS.CREATE, "exit", exitRef.id, {
      clientId: exitSelectedClient.clientId, housingAssessment,
    });
    await logAccess(AUDIT_ACTIONS.UPDATE, "client", exitSelectedClient.clientId, {
      surface: "exit", status: "exited", exitId: exitRef.id,
    });
    if (freedBedId) {
      await logAccess(AUDIT_ACTIONS.UPDATE, "bed", freedBedId, {
        clientId: exitSelectedClient.clientId, action: "free", reason: "exit",
      });
    }

    // Upload signatures in parallel; failure of one doesn't block the other,
    // and the canonical exit doc is already saved.
    const sigPaths = { guest: null, staff: null };
    const sigErrors = [];
    const tasks = [];
    if (exitSigGuestPad && !exitSigGuestPad.isEmpty()) {
      tasks.push((async () => {
        try {
          const blob = await exitSigGuestPad.toBlob();
          const path = `clients/${exitSelectedClient.clientId}/signatures/exit-${exitRef.id}-guest.png`;
          await uploadBlobToStorage(path, blob, "image/png");
          await updateDoc(exitRef, { guestSignaturePath: path });
          sigPaths.guest = path;
          await logAccess(AUDIT_ACTIONS.CREATE, "signature", exitRef.id, {
            clientId: exitSelectedClient.clientId, role: "guest", path, kind: "exit",
          });
        } catch (err) {
          sigErrors.push(`guest signature: ${err.message}`);
        }
      })());
    }
    if (exitSigStaffPad && !exitSigStaffPad.isEmpty()) {
      tasks.push((async () => {
        try {
          const blob = await exitSigStaffPad.toBlob();
          const path = `clients/${exitSelectedClient.clientId}/signatures/exit-${exitRef.id}-staff.png`;
          await uploadBlobToStorage(path, blob, "image/png");
          await updateDoc(exitRef, { staffSignaturePath: path });
          sigPaths.staff = path;
          await logAccess(AUDIT_ACTIONS.CREATE, "signature", exitRef.id, {
            clientId: exitSelectedClient.clientId, role: "staff", path, kind: "exit",
          });
        } catch (err) {
          sigErrors.push(`staff signature: ${err.message}`);
        }
      })());
    }

    // Post-exit cleanup (§14.5 #5):
    //   1. Disable the client's Firebase Auth account so the PIN issued at
    //      intake can no longer sign in. Re-entry mints a fresh PIN and
    //      re-enables the account.
    //   2. Patch any open check-in/out docs to expiresAt=now so the 21-day
    //      TTL collects them promptly instead of holding stale activity for
    //      weeks past exit.
    // Both run in parallel with the signature uploads. Failure surfaces in
    // the success card via sigErrors but doesn't undo the exit — the
    // canonical exit doc is already saved.
    const exitedCid = exitSelectedClient.clientId;
    tasks.push((async () => {
      try {
        await clientAuthDisable({ clientId: exitedCid });
      } catch (err) {
        sigErrors.push(`disable client login: ${err.message}`);
      }
    })());
    // Per-client TTL collections that should expire on exit (so the client's
    // historical activity is collected within ~24h instead of waiting out the
    // full 21-day window). thriftStoreSchedule is intentionally NOT included
    // here because it's a shared per-week master that other clients are still
    // on; instead, the next task blanks the exiting client's individual shifts
    // in current/future weeks so staff see empty slots to fill.
    const exitExpireCollections = [
      "checkInOuts",
      "mealLog",
      "showerLog",
      "clientWeeklySchedule",
    ];
    for (const coll of exitExpireCollections) {
      tasks.push((async () => {
        try {
          const expireAt = Timestamp.now();
          const snap = await getDocs(query(
            collection(db, coll),
            where("clientId", "==", exitedCid),
          ));
          if (snap.empty) return;
          const batch = writeBatch(db);
          snap.docs.forEach((d) => batch.update(d.ref, { expiresAt: expireAt }));
          await batch.commit();
          await logAccess(AUDIT_ACTIONS.UPDATE, coll, exitedCid, {
            surface: "exit-cleanup", action: "expire-now", count: snap.size,
          });
        } catch (err) {
          sigErrors.push(`expire ${coll}: ${err.message}`);
        }
      })());
    }

    // Blank the exiting client's slots on the thrift store schedule for the
    // current week + any future weeks. Past weeks stay as historical record
    // (who actually worked). Empty slot is preserved (clientId/clientName set
    // to "") so staff see the gap and can fill it. Only re-saves docs that
    // actually changed.
    tasks.push((async () => {
      try {
        const currentMonday = mondayOf(new Date());
        const snap = await getDocs(query(
          collection(db, "thriftStoreSchedule"),
          where("weekStart", ">=", currentMonday),
        ));
        if (snap.empty) return;
        const batch = writeBatch(db);
        let totalShiftsBlanked = 0;
        let docsTouched = 0;
        for (const d of snap.docs) {
          const shifts = Array.isArray(d.data().shifts) ? d.data().shifts : [];
          let changed = false;
          const next = shifts.map((s) => {
            if (s.clientId !== exitedCid) return s;
            changed = true;
            totalShiftsBlanked++;
            return { ...s, clientId: "", clientName: "" };
          });
          if (changed) {
            docsTouched++;
            batch.update(d.ref, {
              shifts: next,
              updatedAt: serverTimestamp(),
              updatedBy: auth.currentUser.email,
            });
          }
        }
        if (docsTouched === 0) return;
        await batch.commit();
        await logAccess(AUDIT_ACTIONS.UPDATE, "thriftStoreSchedule", exitedCid, {
          surface: "exit-cleanup", action: "blank-shifts",
          weeksTouched: docsTouched, shiftsBlanked: totalShiftsBlanked,
        });
      } catch (err) {
        sigErrors.push(`blank thrift shifts: ${err.message}`);
      }
    })());

    await Promise.all(tasks);

    showExitSuccess(exitSelectedClient, exitRef.id, exitData, sigPaths, sigErrors);
    resetExitForm();
    // Clearing the picker fires onChange(null) → resetExitForm again
    // (idempotent). The success card lives outside the form so it stays.
    exitClientPicker?.clear();
  } catch (err) {
    showExitError(err.message || "Save failed.");
  } finally {
    if (submitBtn) submitBtn.disabled = false;
  }
}

if (exitForm) {
  const exitSigGuestCanvas = document.getElementById("exit-sig-guest");
  const exitSigStaffCanvas = document.getElementById("exit-sig-staff");
  exitSigGuestPad = exitSigGuestCanvas ? new SignaturePad(exitSigGuestCanvas) : null;
  exitSigStaffPad = exitSigStaffCanvas ? new SignaturePad(exitSigStaffCanvas) : null;

  document.getElementById("exit-sig-guest-clear")?.addEventListener("click", () => exitSigGuestPad?.clear());
  document.getElementById("exit-sig-staff-clear")?.addEventListener("click", () => exitSigStaffPad?.clear());

  const exitPickerRoot = document.getElementById("exit-client-picker");
  if (exitPickerRoot) {
    exitClientPicker = createClientPicker({
      root: exitPickerRoot,
      placeholder: `Search for the guest exiting ${TENANT.orgShort}…`,
      onChange(client) {
        exitSelectedClient = client;
        if (client) {
          if (exitFormBody) exitFormBody.hidden = false;
          if (exitSuccess) exitSuccess.hidden = true;
          // Default exit date to today on first reveal
          const dateInput = exitForm.elements.exitDate;
          if (dateInput && !dateInput.value) {
            dateInput.value = new Date().toISOString().slice(0, 10);
          }
        } else {
          resetExitForm();
        }
      },
    });
  }

  exitForm.addEventListener("submit", handleExitSubmit);
}

// ----- Exit history (in client detail view) -----

async function loadClientExits(cid) {
  const el = document.getElementById("client-exits");
  if (!el) return;
  try {
    const snap = await getDocs(query(
      collection(db, "exits"),
      where("clientId", "==", cid),
      orderBy("exitDate", "desc"),
    ));
    if (snap.empty) {
      el.innerHTML = `<p class="note">No exits recorded.</p>`;
      return;
    }
    el.innerHTML = snap.docs.map((d) => {
      const data = d.data();
      const date = fmtDate(data.exitDate) || "(no date)";
      const housing = HOUSING_LABELS[data.housingAssessment]
        || data.housingAssessment
        || "(no assessment)";
      const acks = [];
      if (data.ackPersonalItems48h) acks.push("personal-items 48h");
      if (data.ackMail) acks.push("change-of-address");
      const sigs = [];
      if (data.guestSignaturePath) sigs.push("guest signature");
      if (data.staffSignaturePath) sigs.push("staff signature");
      const returnPolicyParts = [];
      if (data.noReturn) returnPolicyParts.push(`<span class="error">Not allowed to return</span>`);
      if (data.warnAtReturn) returnPolicyParts.push(`<span class="error">Warn at re-intake — review past history</span>`);
      if (data.eligibleToReturnDate) returnPolicyParts.push(`Eligible to return ${escapeHtml(fmtDate(data.eligibleToReturnDate) || "")}`);
      return `
        <div class="exit-row">
          <div class="exit-row-header">
            <strong>${escapeHtml(date)}</strong>
            <span class="meta">Recorded by ${escapeHtml(data.enteredBy || "(unknown)")}</span>
          </div>
          <dl class="kv-grid">
            ${kv("Housing assessment", housing)}
            ${kv("Reason", data.reason)}
            ${kv("Notes", data.notes)}
            ${kv("Guest's name printed", data.guestNamePrinted)}
            ${kv("Acknowledgements", acks.join(", "))}
            ${kv("Signatures captured", sigs.join(", "))}
            ${returnPolicyParts.length ? kv("Return policy", returnPolicyParts.join(" &middot; "), { raw: true }) : ""}
            ${kv("Exit ID", `<code>${escapeHtml(d.id)}</code>`, { raw: true })}
          </dl>
        </div>
      `;
    }).join("");
  } catch (err) {
    el.innerHTML = `<p class="error">Could not load exits: ${escapeHtml(err.message)}</p>`;
  }
}

// ============================================================
// Client status updates
// ============================================================
//
// A status update is a single record of "this client gained X" — a document
// (SSN card, birth cert, diploma, insurance, …) or a life milestone (job,
// housing, sobriety, …). Each save:
//   1. writes a clientStatusUpdates/{updateId} doc (the permanent history)
//   2. mirrors latest state to clients/{cid}.documents.{type} or
//      .milestones.{type} so the Clients tab + Reports can read current
//      state without joining the history collection
//   3. writes an accessLog 'create' entry tagged surface=client-status-update
//
// History is rendered chronologically on the client detail panel below the
// log-an-update form. Composite index (clientId asc, occurredOn desc) backs
// the per-client query.

const STATUS_UPDATE_TYPE_LABELS = {
  // Documents
  socialSecurityCard: "Social Security card",
  birthCertificate: "Birth certificate",
  stateId: "State ID / driver's license",
  hsDiploma: "HS diploma / GED",
  hsTranscript: "HS transcript",
  collegeDiploma: "College diploma / certificate",
  collegeTranscript: "College transcript",
  medicalInsurance: "Medical insurance",
  vaCard: "VA card",
  dd214: "DD-214",
  voterRegistration: "Voter registration",
  // Healthcare connections (treated as milestones internally)
  connectedDoctor: "Connected with a doctor",
  connectedCounselor: "Connected with a counselor",
  // Government benefits (own category — ongoing, with monthly amounts)
  foodStamps: "Food stamps (SNAP)",
  ssi: "SSI",
  ssdi: "SSDI",
  rsdi: "RSDI / Social Security retirement",
  vaDisability: "VA disability",
  vaRetirement: "VA retirement",
  retirement: "Retirement (other)",
  workersComp: "Workers' compensation",
  tribalBenefits: "Tribal benefits",
  otherBenefit: "Other benefit",
  // Life milestones
  employment: "Got a job",
  housing: "Got housing",
  bankAccount: "Opened a bank account",
  phone: "Got a phone",
  startedSchool: "Started college / trade school",
  sobrietyMilestone: "Sobriety milestone",
  programCompletion: "Completed a program",
  lostEmployment: "Lost job",
  // Reviews — paragraph-form notes kept as history; latest mirrors to
  // master.reviews.{updateType}. Panel Results is the monthly progress
  // review that drives the client's next steps in the program.
  panelResults: "Panel Results",
};

const STATUS_UPDATE_DOCUMENT_TYPES = new Set([
  "socialSecurityCard", "birthCertificate", "stateId",
  "hsDiploma", "hsTranscript", "collegeDiploma", "collegeTranscript",
  "medicalInsurance", "vaCard", "dd214", "voterRegistration",
]);

const STATUS_UPDATE_BENEFIT_TYPES = new Set([
  "foodStamps", "ssi", "ssdi", "rsdi", "vaDisability", "vaRetirement",
  "retirement", "workersComp", "tribalBenefits", "otherBenefit",
]);

const STATUS_UPDATE_REVIEW_TYPES = new Set([
  "panelResults",
]);

function statusUpdateCategory(updateType) {
  if (STATUS_UPDATE_DOCUMENT_TYPES.has(updateType)) return "document";
  if (STATUS_UPDATE_BENEFIT_TYPES.has(updateType)) return "benefit";
  if (STATUS_UPDATE_REVIEW_TYPES.has(updateType)) return "review";
  return "milestone";
}

async function loadClientStatusUpdates(cid) {
  const el = document.getElementById("client-status-updates");
  if (!el) return;
  try {
    const snap = await getDocs(query(
      collection(db, "clientStatusUpdates"),
      where("clientId", "==", cid),
      orderBy("occurredOn", "desc"),
    ));
    if (snap.empty) {
      el.innerHTML = `<p class="note">No status updates recorded yet.</p>`;
      return;
    }
    el.innerHTML = snap.docs.map((d) => {
      const data = d.data();
      const date = fmtDate(data.occurredOn) || "(no date)";
      const label = STATUS_UPDATE_TYPE_LABELS[data.updateType] || data.updateType;
      const cat = data.category || statusUpdateCategory(data.updateType);
      return `
        <div class="status-update-row">
          <div class="status-update-row-header">
            <strong>${escapeHtml(label)}</strong>
            <span class="muted">${escapeHtml(cat)}</span>
            <span class="meta">${escapeHtml(date)} &middot; recorded by ${escapeHtml(data.recordedBy || "(unknown)")}</span>
          </div>
          ${data.notes ? `<p class="status-update-notes">${escapeHtml(data.notes)}</p>` : ""}
        </div>
      `;
    }).join("");
  } catch (err) {
    el.innerHTML = `<p class="error">Could not load status updates: ${escapeHtml(err.message)}</p>`;
  }
}

const statusUpdateForm = document.getElementById("status-update-form");
const statusUpdateStatusEl = document.getElementById("status-update-status");
const statusUpdateSaveBtn = document.getElementById("status-update-save");

if (statusUpdateForm) {
  statusUpdateForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    const cid = currentDetailClientId;
    if (!cid) return;

    const fd = new FormData(statusUpdateForm);
    const updateType = (fd.get("updateType") || "").toString();
    const occurredOnStr = (fd.get("occurredOn") || "").toString();
    const notes = (fd.get("notes") || "").toString().trim();

    if (!updateType || !STATUS_UPDATE_TYPE_LABELS[updateType]) {
      showStatusUpdateError("Pick what changed.");
      return;
    }
    const occurredOnDate = occurredOnStr ? new Date(occurredOnStr + "T00:00:00") : null;
    if (!occurredOnDate || isNaN(occurredOnDate)) {
      showStatusUpdateError("Pick a valid date.");
      return;
    }

    statusUpdateSaveBtn.disabled = true;
    statusUpdateStatusEl.hidden = true;
    statusUpdateStatusEl.classList.remove("error");

    const category = statusUpdateCategory(updateType);
    const occurredOnTs = Timestamp.fromDate(occurredOnDate);
    const userEmail = auth.currentUser.email;

    try {
      // Write the history doc first so the audit trail exists even if the
      // master mirror update fails afterward.
      const ref = await addDoc(collection(db, "clientStatusUpdates"), {
        clientId: cid,
        updateType,
        category,
        occurredOn: occurredOnTs,
        notes: notes || null,
        recordedBy: userEmail,
        createdAt: serverTimestamp(),
        createdBy: userEmail,
      });

      // Mirror latest state to the master client record. Nested map field
      // path keeps siblings intact (e.g. updating .documents.stateId does
      // not wipe .documents.socialSecurityCard).
      const masterPatch = {};
      masterPatch[`${category}s.${updateType}`] = {
        obtained: true,
        obtainedOn: occurredOnTs,
        lastUpdateId: ref.id,
        lastUpdateAt: serverTimestamp(),
        lastUpdateBy: userEmail,
      };
      await updateDoc(doc(db, "clients", cid), masterPatch);

      await logAccess(AUDIT_ACTIONS.CREATE, "clientStatusUpdate", ref.id, {
        clientId: cid, updateType, category, surface: "client-status-update",
      });

      statusUpdateForm.reset();
      // Re-default the date input to today so back-to-back saves are fast.
      const todayInput = statusUpdateForm.elements.occurredOn;
      if (todayInput) todayInput.value = todayLocalDate();

      statusUpdateStatusEl.textContent = "Saved.";
      statusUpdateStatusEl.classList.remove("error");
      statusUpdateStatusEl.classList.add("status");
      statusUpdateStatusEl.hidden = false;
      setTimeout(() => { statusUpdateStatusEl.hidden = true; }, 3000);

      await loadClientStatusUpdates(cid);
    } catch (err) {
      showStatusUpdateError(err.message || "Save failed.");
    } finally {
      statusUpdateSaveBtn.disabled = false;
    }
  });
}

function showStatusUpdateError(msg) {
  statusUpdateStatusEl.textContent = msg;
  statusUpdateStatusEl.classList.remove("status");
  statusUpdateStatusEl.classList.add("error");
  statusUpdateStatusEl.hidden = false;
}

function resetStatusUpdateForm() {
  if (!statusUpdateForm) return;
  statusUpdateForm.reset();
  const todayInput = statusUpdateForm.elements.occurredOn;
  if (todayInput) todayInput.value = todayLocalDate();
  if (statusUpdateStatusEl) statusUpdateStatusEl.hidden = true;
}

// ============================================================
// Drug tests (client detail page) — random / ongoing tests
// ============================================================
//
// Each drug test is one doc in the existing `drugTests` collection. The
// intake-time test is written with intakeId set to the new intake's id;
// random tests added here are written with intakeId=null so the UI can
// label them distinctly. History is never overwritten — every test stays
// on file. Same 15-panel + observer + admitted + agrees shape as intake.

async function loadClientDrugTests(cid) {
  const el = document.getElementById("client-drug-tests");
  if (!el) return;
  try {
    const snap = await getDocs(query(
      collection(db, "drugTests"),
      where("clientId", "==", cid),
    ));
    if (snap.empty) {
      el.innerHTML = `<p class="note">No drug tests on file yet.</p>`;
      return;
    }
    const rows = snap.docs
      .map((d) => ({ id: d.id, data: d.data() }))
      .sort((a, b) => tsMs(b.data.testDate) - tsMs(a.data.testDate));
    el.innerHTML = rows.map(({ id, data }) => {
      const date = fmtDate(data.testDate) || fmtTimestamp(data.testDate) || "(no date)";
      const panel = data.panelResults || {};
      const positives = Object.entries(panel)
        .filter(([, v]) => v === "positive" || v === "faint")
        .map(([k, v]) => `${k}${v === "faint" ? " (faint)" : ""}`);
      const summary = positives.length
        ? `<span class="error">${positives.length} non-negative: ${escapeHtml(positives.join(", "))}</span>`
        : `<span class="status">All negative</span>`;
      const origin = data.intakeId
        ? `<span class="muted">(intake-time)</span>`
        : `<span class="muted">(random)</span>`;
      const meta = [];
      if (data.observerName) meta.push(`observer ${escapeHtml(data.observerName)}`);
      if (data.admittedToOtherDrugs) meta.push(`admitted other: ${escapeHtml(data.admittedToOtherDrugs)}`);
      if (data.guestAgreesWithResults) meta.push(`agrees: ${escapeHtml(data.guestAgreesWithResults)}`);
      if (data.enteredBy) meta.push(`by ${escapeHtml(data.enteredBy)}`);
      return `
        <div class="status-update-row">
          <div class="status-update-row-header">
            <strong>${escapeHtml(date)}</strong>
            ${origin}
            ${summary}
          </div>
          ${meta.length ? `<div class="meta">${meta.join(" &middot; ")}</div>` : ""}
          ${data.notes ? `<p class="status-update-notes">${escapeHtml(data.notes)}</p>` : ""}
        </div>
      `;
    }).join("");
  } catch (err) {
    el.innerHTML = `<p class="error">Could not load drug tests: ${escapeHtml(err.message)}</p>`;
  }
}

(function bindDrugTestModal() {
  const openBtn = document.getElementById("drug-test-add-btn");
  const modal = document.getElementById("drug-test-modal");
  const cancelBtn = document.getElementById("drug-test-cancel");
  const confirmBtn = document.getElementById("drug-test-confirm");
  const backdrop = document.getElementById("drug-test-modal-backdrop");
  if (!openBtn || !modal) return;
  const dateInput = document.getElementById("drug-test-date");
  const observerInput = document.getElementById("drug-test-observer");
  const admittedSel = document.getElementById("drug-test-admitted");
  const agreesSel = document.getElementById("drug-test-agrees");
  const notesInput = document.getElementById("drug-test-notes");
  const errEl = document.getElementById("drug-test-error");
  const panelBody = document.getElementById("drug-test-panel-body");

  // Render the 15-panel rows once. Radio names are scoped with a
  // "drug-test-" prefix so they don't collide with the intake form's
  // "drug-" radios when both forms are mounted in the same document.
  if (panelBody && !panelBody.dataset.rendered) {
    panelBody.innerHTML = DRUG_PANEL.map(([code, label]) => `
      <tr>
        <td>${code} <span class="muted">(${escapeHtml(label)})</span></td>
        <td><input type="radio" name="drug-test-${code}" value="negative" /></td>
        <td><input type="radio" name="drug-test-${code}" value="positive" /></td>
        <td><input type="radio" name="drug-test-${code}" value="faint" /></td>
      </tr>
    `).join("");
    panelBody.dataset.rendered = "1";
  }

  function collectModalPanel() {
    const out = {};
    for (const [code] of DRUG_PANEL) {
      const checked = panelBody?.querySelector(`input[name="drug-test-${code}"]:checked`);
      out[code] = checked ? checked.value : null;
    }
    return out;
  }

  function resetModal() {
    if (dateInput) dateInput.value = todayLocalDate();
    if (observerInput) observerInput.value = "";
    if (admittedSel) admittedSel.value = "";
    if (agreesSel) agreesSel.value = "";
    if (notesInput) notesInput.value = "";
    if (panelBody) {
      panelBody.querySelectorAll("input[type='radio']").forEach((r) => { r.checked = false; });
    }
    if (errEl) errEl.hidden = true;
    if (confirmBtn) confirmBtn.disabled = false;
  }
  function open() { resetModal(); modal.hidden = false; }
  function close() { modal.hidden = true; }
  function showError(msg) {
    if (!errEl) return;
    errEl.textContent = msg;
    errEl.hidden = false;
  }

  openBtn.addEventListener("click", open);
  cancelBtn?.addEventListener("click", close);
  backdrop?.addEventListener("click", close);

  confirmBtn?.addEventListener("click", async () => {
    const cid = currentDetailClientId;
    if (!cid) { close(); return; }
    const dateStr = dateInput?.value || "";
    const dateValue = dateStr ? new Date(dateStr + "T00:00:00") : null;
    if (!dateValue || isNaN(dateValue)) {
      showError("Pick a valid test date.");
      return;
    }
    confirmBtn.disabled = true;
    if (errEl) errEl.hidden = true;
    try {
      const data = {
        clientId: cid,
        intakeId: null,
        panelResults: collectModalPanel(),
        admittedToOtherDrugs: admittedSel?.value || null,
        guestAgreesWithResults: agreesSel?.value || null,
        observerName: (observerInput?.value || "").trim() || null,
        notes: (notesInput?.value || "").trim() || null,
        testDate: Timestamp.fromDate(dateValue),
        enteredBy: auth.currentUser.email,
        enteredAt: serverTimestamp(),
      };
      const ref = await addDoc(collection(db, "drugTests"), data);
      await logAccess(AUDIT_ACTIONS.CREATE, "drugTest", ref.id, {
        clientId: cid, surface: "client-drug-test", random: true,
      });
      close();
      await loadClientDrugTests(cid);
    } catch (err) {
      showError(err.message || "Save failed.");
      confirmBtn.disabled = false;
    }
  });
})();

// ============================================================
// Daily Roster
// ============================================================
//
// One Firestore doc per day at `dailyGuestRoster/{YYYY-MM-DD}` mirrors
// the Excel master sheet that drives Daniel's existing daily forms.
// Each row is one active client with checkboxes for present, breakfast,
// lunch, dinner, shower, signedInBy8pm, plus a free-text notes field.
// Totals are computed in-memory and saved alongside the guests array
// so reports don't have to recompute from rows.
//
// Concurrency note: writes are last-write-wins on the whole guests
// array. Acceptable for v1 (low staff count, single-day editing).
// Per-event docs (checkInOut, showerLog) and the not-signed-in-by-8pm
// alert tile are deferred slices.

let rosterDate = null;        // current date being viewed, "YYYY-MM-DD"
let rosterGuests = [];         // working in-memory state
let rosterIsNew = true;        // controls createdAt-on-save
let rosterDirty = false;       // set on any input change
let rosterInitialized = false; // first-load gate (see clients-listener hook)

// Today's per-event aggregates from mealLog + showerLog (client app writes).
// Listeners hydrate these whenever staff is signed in; the daily-roster
// renderer ORs them into the checkbox state when viewing today's date.
// Direction is one-way: per-event presence ticks a box; nothing untiks.
// Staff can still manually untick — but a fresh client log will re-tick.
let todayMealsByClient = {};   // { [cid]: { breakfast, lunch, dinner } }
let todayShowersByClient = {}; // { [cid]: true }

const rosterDateInput = document.getElementById("roster-date");
const rosterTodayBtn = document.getElementById("roster-today-btn");
const rosterBody = document.getElementById("roster-body");
const rosterSaveBtn = document.getElementById("roster-save");
const rosterSaveStatus = document.getElementById("roster-save-status");
const rosterStatusEl = document.getElementById("roster-status");

function todayLocalDate() {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function defaultRowFields() {
  return {
    present: false, breakfast: false, lunch: false, dinner: false,
    shower: false, signedInBy8pm: false, notes: "",
  };
}

function buildGuestRow(c) {
  const fullName = [c.data.firstName, c.data.middleName, c.data.lastName]
    .filter(Boolean).join(" ");
  return {
    clientId: c.id,
    name: fullName,
    firstName: c.data.firstName || "",
    lastName: c.data.lastName || "",
    ...defaultRowFields(),
  };
}

function sortRosterGuests() {
  rosterGuests.sort((a, b) => {
    const an = `${a.lastName || ""} ${a.firstName || ""}`.toLowerCase();
    const bn = `${b.lastName || ""} ${b.firstName || ""}`.toLowerCase();
    return an.localeCompare(bn);
  });
}

async function loadRoster(date) {
  if (!rosterBody) return;
  rosterDate = date;
  rosterDirty = false;
  rosterStatusEl.hidden = false;
  rosterStatusEl.textContent = "Loading…";
  rosterBody.innerHTML = `<tr class="empty"><td colspan="8">Loading…</td></tr>`;

  try {
    const ref = doc(db, "dailyGuestRoster", date);
    const snap = await getDoc(ref);
    rosterIsNew = !snap.exists();
    const today = todayLocalDate();

    if (snap.exists()) {
      const saved = snap.data();
      const savedGuests = Array.isArray(saved.guests) ? saved.guests : [];
      // Defensive: fill in any missing default fields on saved rows
      rosterGuests = savedGuests.map((g) => ({
        ...defaultRowFields(),
        ...g,
        firstName: g.firstName || (g.name?.split(" ")[0] || ""),
        lastName: g.lastName || (g.name?.split(" ").slice(-1)[0] || ""),
      }));
      // For today: top up with active clients not yet in the saved roster
      // (e.g., new intakes after the first save). Historical days stay as-saved.
      if (date === today) {
        const present = new Set(rosterGuests.map((g) => g.clientId));
        for (const c of cachedClients) {
          if (c.data.status !== "active") continue;
          if (present.has(c.id)) continue;
          rosterGuests.push(buildGuestRow(c));
        }
      }
      const updatedStr = saved.updatedAt?.toDate
        ? saved.updatedAt.toDate().toLocaleString()
        : "(unknown)";
      rosterStatusEl.textContent = `Loaded saved roster (last updated ${updatedStr} by ${saved.updatedBy || "unknown"}).`;
    } else {
      // First time saving for this date — start from current active clients
      rosterGuests = cachedClients
        .filter((c) => c.data.status === "active")
        .map(buildGuestRow);
      rosterStatusEl.textContent = `New roster — populated from ${rosterGuests.length} active clients. Save to record.`;
    }

    sortRosterGuests();
    // OR-merge any client-logged meals/showers so today's view auto-ticks
    // before the first render. Only fires for today's date; historical
    // days stay as-saved. Idempotent — safe even if listeners haven't
    // fired yet (aggregates start empty).
    applyPerEventToRoster();
    renderRoster();
    updateRosterStats();
    rosterSaveStatus.textContent = "No changes";
    rosterSaveStatus.classList.remove("error");
    rosterSaveStatus.classList.add("muted");
  } catch (err) {
    rosterStatusEl.textContent = `Could not load: ${err.message}`;
    rosterBody.innerHTML = `<tr class="empty"><td colspan="8">Load failed.</td></tr>`;
  }
}

function renderRoster() {
  if (rosterGuests.length === 0) {
    rosterBody.innerHTML = `<tr class="empty"><td colspan="8">No active clients.</td></tr>`;
    return;
  }
  rosterBody.innerHTML = rosterGuests.map((g, i) => `
    <tr data-idx="${i}">
      <td>
        ${escapeHtml(g.name || "(no name)")}
        <div class="muted">${escapeHtml(g.clientId)}</div>
      </td>
      <td><input type="checkbox" data-field="present" ${g.present ? "checked" : ""} /></td>
      <td><input type="checkbox" data-field="breakfast" ${g.breakfast ? "checked" : ""} /></td>
      <td><input type="checkbox" data-field="lunch" ${g.lunch ? "checked" : ""} /></td>
      <td><input type="checkbox" data-field="dinner" ${g.dinner ? "checked" : ""} /></td>
      <td><input type="checkbox" data-field="shower" ${g.shower ? "checked" : ""} /></td>
      <td><input type="checkbox" data-field="signedInBy8pm" ${g.signedInBy8pm ? "checked" : ""} /></td>
      <td><input type="text" data-field="notes" value="${escapeHtml(g.notes || "")}" /></td>
    </tr>
  `).join("");
}

function computeRosterTotals() {
  return {
    presentCount: rosterGuests.filter((g) => g.present).length,
    breakfastCount: rosterGuests.filter((g) => g.breakfast).length,
    lunchCount: rosterGuests.filter((g) => g.lunch).length,
    dinnerCount: rosterGuests.filter((g) => g.dinner).length,
    showerCount: rosterGuests.filter((g) => g.shower).length,
    notSignedInBy8pmCount: rosterGuests.filter((g) => g.present && !g.signedInBy8pm).length,
  };
}

function updateRosterStats() {
  const t = computeRosterTotals();
  document.getElementById("stat-present").textContent = t.presentCount;
  document.getElementById("stat-breakfast").textContent = t.breakfastCount;
  document.getElementById("stat-lunch").textContent = t.lunchCount;
  document.getElementById("stat-dinner").textContent = t.dinnerCount;
  document.getElementById("stat-shower").textContent = t.showerCount;
  const nsiWrap = document.getElementById("stat-not-signed-in-wrap");
  if (t.notSignedInBy8pmCount > 0) {
    nsiWrap.hidden = false;
    document.getElementById("stat-not-signed-in").textContent = t.notSignedInBy8pmCount;
  } else {
    nsiWrap.hidden = true;
  }
}

function markRosterDirty() {
  rosterDirty = true;
  rosterSaveStatus.textContent = "Unsaved changes";
  rosterSaveStatus.classList.remove("muted");
  rosterSaveStatus.classList.add("error");
}

if (rosterBody) {
  rosterBody.addEventListener("change", (e) => {
    const tr = e.target.closest("tr[data-idx]");
    if (!tr) return;
    const idx = Number(tr.dataset.idx);
    const field = e.target.dataset.field;
    if (!Number.isInteger(idx) || !field || !rosterGuests[idx]) return;
    if (e.target.type === "checkbox") {
      rosterGuests[idx][field] = e.target.checked;
    } else {
      rosterGuests[idx][field] = e.target.value;
    }
    markRosterDirty();
    updateRosterStats();
  });
  // notes input fires "input" not "change" — catch keystrokes too
  rosterBody.addEventListener("input", (e) => {
    if (e.target.type !== "text") return;
    const tr = e.target.closest("tr[data-idx]");
    if (!tr) return;
    const idx = Number(tr.dataset.idx);
    const field = e.target.dataset.field;
    if (!Number.isInteger(idx) || !field || !rosterGuests[idx]) return;
    rosterGuests[idx][field] = e.target.value;
    markRosterDirty();
  });
}

if (rosterDateInput) {
  rosterDateInput.addEventListener("change", () => {
    if (rosterDirty && !confirm("Unsaved changes will be lost. Continue?")) {
      rosterDateInput.value = rosterDate;
      return;
    }
    loadRoster(rosterDateInput.value);
  });
}

if (rosterTodayBtn) {
  rosterTodayBtn.addEventListener("click", () => {
    const today = todayLocalDate();
    if (rosterDate === today) return;
    if (rosterDirty && !confirm("Unsaved changes will be lost. Continue?")) return;
    rosterDateInput.value = today;
    loadRoster(today);
  });
}

if (rosterSaveBtn) {
  rosterSaveBtn.addEventListener("click", async () => {
    if (!rosterDate) return;
    rosterSaveBtn.disabled = true;
    try {
      const totals = computeRosterTotals();
      // Strip transient first/last name fields kept only for sorting in-memory
      const guestsToSave = rosterGuests.map((g) => ({
        clientId: g.clientId,
        name: g.name,
        present: !!g.present,
        breakfast: !!g.breakfast,
        lunch: !!g.lunch,
        dinner: !!g.dinner,
        shower: !!g.shower,
        signedInBy8pm: !!g.signedInBy8pm,
        notes: g.notes || "",
      }));
      const dateAt = new Date(rosterDate + "T00:00:00");
      const ref = doc(db, "dailyGuestRoster", rosterDate);

      await runTransaction(db, async (txn) => {
        const snap = await txn.get(ref);
        const isFirst = !snap.exists();
        const payload = {
          date: rosterDate,
          dateTimestamp: Timestamp.fromDate(dateAt),
          guests: guestsToSave,
          totals,
          updatedAt: serverTimestamp(),
          updatedBy: auth.currentUser.email,
        };
        if (isFirst) {
          payload.createdAt = serverTimestamp();
          payload.createdBy = auth.currentUser.email;
        }
        txn.set(ref, payload, { merge: true });
      });

      rosterIsNew = false;
      rosterDirty = false;
      rosterSaveStatus.textContent = `Saved ${new Date().toLocaleTimeString()}`;
      rosterSaveStatus.classList.remove("error");
      rosterSaveStatus.classList.add("muted");

      await logAccess(AUDIT_ACTIONS.UPDATE, "dailyGuestRoster", rosterDate, { totals });
    } catch (err) {
      alert(`Save failed: ${err.message}`);
    } finally {
      rosterSaveBtn.disabled = false;
    }
  });
}

// First-load hook: clients-listener calls this on every snapshot, but the
// rosterInitialized flag ensures we only fire once per session. We need
// cachedClients populated to seed today's roster from the active set.
function tryInitRoster() {
  if (rosterInitialized) return;
  if (!rosterDateInput) return;
  rosterInitialized = true;
  const today = todayLocalDate();
  if (!rosterDateInput.value) rosterDateInput.value = today;
  loadRoster(rosterDateInput.value);
}

// ---- Per-event log listeners (mealLog + showerLog) ----
// Hydrate todayMealsByClient / todayShowersByClient so the Daily Roster
// auto-ticks the corresponding box whenever a client self-logs from the
// client app. Started on staff sign-in, stopped on sign-out.

let stopMealLogTodayListener = null;
let stopShowerLogTodayListener = null;

function startStaffPerEventListener() {
  stopStaffPerEventListener();
  // Single-field range query on eventTime — uses the auto-created index.
  const todayStart = todayStartTimestamp();
  const mealQ = query(collection(db, "mealLog"), where("eventTime", ">=", todayStart));
  stopMealLogTodayListener = onSnapshot(mealQ, (snap) => {
    const next = {};
    for (const d of snap.docs) {
      const data = d.data();
      const cid = data.clientId;
      const meal = data.meal;
      if (!cid || !["breakfast", "lunch", "dinner"].includes(meal)) continue;
      if (!next[cid]) next[cid] = { breakfast: false, lunch: false, dinner: false };
      next[cid][meal] = true;
    }
    todayMealsByClient = next;
    applyPerEventToRoster();
  }, (err) => console.warn("[staff] mealLog listener error", err));

  const showerQ = query(collection(db, "showerLog"), where("eventTime", ">=", todayStart));
  stopShowerLogTodayListener = onSnapshot(showerQ, (snap) => {
    const next = {};
    for (const d of snap.docs) {
      const cid = d.data().clientId;
      if (cid) next[cid] = true;
    }
    todayShowersByClient = next;
    applyPerEventToRoster();
  }, (err) => console.warn("[staff] showerLog listener error", err));
}

function stopStaffPerEventListener() {
  if (stopMealLogTodayListener) { stopMealLogTodayListener(); stopMealLogTodayListener = null; }
  if (stopShowerLogTodayListener) { stopShowerLogTodayListener(); stopShowerLogTodayListener = null; }
  todayMealsByClient = {};
  todayShowersByClient = {};
}

// OR-merges today's per-event presence into the in-memory roster guests so
// boxes auto-tick. Only applies when viewing today's date. Doesn't untick:
// if staff manually unchecks despite a client log, the unchecked state
// persists until a new client log lands (then it re-ticks). Acceptable for
// v1; an explicit "staff override" UI is a future refinement if needed.
function applyPerEventToRoster() {
  if (!rosterDate || rosterDate !== todayLocalDate()) return;
  if (!rosterGuests.length) return;
  let changed = false;
  for (const g of rosterGuests) {
    const meals = todayMealsByClient[g.clientId];
    if (meals?.breakfast && !g.breakfast) { g.breakfast = true; changed = true; }
    if (meals?.lunch && !g.lunch) { g.lunch = true; changed = true; }
    if (meals?.dinner && !g.dinner) { g.dinner = true; changed = true; }
    if (todayShowersByClient[g.clientId] && !g.shower) { g.shower = true; changed = true; }
  }
  if (changed) {
    renderRoster();
    updateRosterStats();
    markRosterDirty();
  }
}

// ============================================================
// Schedules
// ============================================================
//
// Replaces Daniel's Monday Excel consolidation. Per-week schedules:
//   clientWeeklySchedule/{clientId}-{weekStart}  (one doc per client per week,
//                                                events array)
//   thriftStoreSchedule/{weekStart}              (single master doc per week,
//                                                shifts array)
//
// Conflict detection runs in-memory on every save / week change:
//   1. Two events overlapping within one client's own schedule
//   2. A thrift shift overlapping that client's other commitments
//
// Consolidated view = vertical list per day, sorted by start time, every
// event + shift across all active clients.

const DAYS = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"];
// DAY_LABELS, EVENT_TYPES, EVENT_TYPE_LABELS now live in shared/schedule-helpers.js
// (imported at top). DAYS stays here until Schedule itself moves (Phase 2.6).

// Standard thrift-store shift template: Mon–Sat × three shifts (9–12, 12–3,
// 2–5). Seeded into a fresh week so the editor and print matrix always show
// the three time slots; staff fill in clientId per row. Plan §11.
const THRIFT_TEMPLATE_SHIFTS = [
  { startTime: "09:00", endTime: "12:00" },
  { startTime: "12:00", endTime: "15:00" },
  { startTime: "14:00", endTime: "17:00" },
];

function buildThriftTemplateShifts() {
  const days = DAYS.slice(0, 6); // Mon–Sat (store closed Sundays)
  return days.flatMap((day) => THRIFT_TEMPLATE_SHIFTS.map((s) => ({
    day, startTime: s.startTime, endTime: s.endTime,
    clientId: "", clientName: "", role: "",
    clientId2: "", clientName2: "", role2: "",
  })));
}

let scheduleWeekStart = null;
let scheduleClientPicker = null;
let scheduleSelectedClient = null;
let clientScheduleEvents = [];
let clientScheduleDirty = false;
let clientScheduleIsNew = true;
let thriftScheduleShifts = [];
let thriftScheduleDirty = false;
let thriftScheduleIsNew = true;
let allClientSchedulesForWeek = [];
let scheduleInitialized = false;

function localDateString(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function mondayOf(input) {
  let d;
  if (input instanceof Date) {
    d = new Date(input.getFullYear(), input.getMonth(), input.getDate());
  } else if (typeof input === "string" && /^\d{4}-\d{2}-\d{2}$/.test(input)) {
    const [y, m, day] = input.split("-").map(Number);
    d = new Date(y, m - 1, day);
  } else {
    d = new Date(input);
  }
  const dow = d.getDay(); // 0 = Sunday
  const diff = dow === 0 ? -6 : 1 - dow;
  d.setDate(d.getDate() + diff);
  return localDateString(d);
}

function addDays(yyyymmdd, n) {
  const [y, m, day] = yyyymmdd.split("-").map(Number);
  const d = new Date(y, m - 1, day);
  d.setDate(d.getDate() + n);
  return localDateString(d);
}

// timeToMinutes / formatTime12 / eventsOverlap now live in shared/schedule-helpers.js

// ----- Loaders -----

async function loadAllForWeek(weekStart) {
  const [csSnap, thriftSnap] = await Promise.all([
    getDocs(query(collection(db, "clientWeeklySchedule"), where("weekStart", "==", weekStart))),
    getDoc(doc(db, "thriftStoreSchedule", weekStart)),
  ]);
  allClientSchedulesForWeek = csSnap.docs.map((d) => ({ id: d.id, data: d.data() }));
  thriftScheduleIsNew = !thriftSnap.exists();
  thriftScheduleShifts = thriftSnap.exists() && Array.isArray(thriftSnap.data().shifts)
    ? thriftSnap.data().shifts.map((s) => ({ ...s }))
    : [];
  // Seed standard 3-shift × 6-day template on a brand-new week so the matrix
  // is always visible. Doesn't dirty-flag — only persists if staff hits Save.
  if (thriftScheduleIsNew && thriftScheduleShifts.length === 0) {
    thriftScheduleShifts = buildThriftTemplateShifts();
  }
  thriftScheduleDirty = false;
}

async function loadClientSchedule(clientId, weekStart) {
  const docId = `${clientId}-${weekStart}`;
  const ref = doc(db, "clientWeeklySchedule", docId);
  const snap = await getDoc(ref);
  clientScheduleIsNew = !snap.exists();
  clientScheduleEvents = snap.exists() && Array.isArray(snap.data().events)
    ? snap.data().events.map((e) => ({ ...e }))
    : [];
  clientScheduleDirty = false;
}

// ----- Renderers -----

function dayDropdown(selected) {
  return `<select data-field="day">
    <option value=""${!selected ? " selected" : ""}>—</option>
    ${DAYS.map((d) => `<option value="${d}"${selected === d ? " selected" : ""}>${DAY_LABELS[d]}</option>`).join("")}
  </select>`;
}

function typeDropdown(selected) {
  return `<select data-field="type">
    <option value=""${!selected ? " selected" : ""}>—</option>
    ${EVENT_TYPES.map((t) => `<option value="${t}"${selected === t ? " selected" : ""}>${EVENT_TYPE_LABELS[t]}</option>`).join("")}
  </select>`;
}

function clientDropdown(selected, field = "clientId") {
  const active = cachedClients.filter((c) => c.data.status === "active");
  return `<select data-field="${field}">
    <option value=""${!selected ? " selected" : ""}>—</option>
    ${active.map((c) => {
      const name = [c.data.firstName, c.data.middleName, c.data.lastName].filter(Boolean).join(" ");
      return `<option value="${escapeHtml(c.id)}"${selected === c.id ? " selected" : ""}>${escapeHtml(name)} (${escapeHtml(c.id)})</option>`;
    }).join("")}
  </select>`;
}

function renderClientScheduleTable() {
  const body = document.getElementById("client-schedule-body");
  if (!body) return;
  if (clientScheduleEvents.length === 0) {
    body.innerHTML = `<tr class="empty"><td colspan="8">No events. Click "+ Add event" to add one.</td></tr>`;
    return;
  }
  body.innerHTML = clientScheduleEvents.map((e, i) => `
    <tr data-idx="${i}">
      <td>${dayDropdown(e.day)}</td>
      <td><input type="time" data-field="startTime" value="${escapeHtml(e.startTime || "")}" /></td>
      <td><input type="time" data-field="endTime" value="${escapeHtml(e.endTime || "")}" /></td>
      <td>${typeDropdown(e.type)}</td>
      <td><input type="text" data-field="title" value="${escapeHtml(e.title || "")}" placeholder="Doctor visit, NA meeting…" /></td>
      <td><input type="text" data-field="location" value="${escapeHtml(e.location || "")}" placeholder="${escapeHtml(TENANT.clinicLocationExample)}…" /></td>
      <td><input type="text" data-field="notes" value="${escapeHtml(e.notes || "")}" /></td>
      <td><button type="button" class="row-remove" data-action="remove" aria-label="Remove">&times;</button></td>
    </tr>
  `).join("");
}

function renderThriftScheduleTable() {
  const body = document.getElementById("thrift-schedule-body");
  if (!body) return;
  if (thriftScheduleShifts.length === 0) {
    body.innerHTML = `<tr class="empty"><td colspan="8">No shifts. Click "+ Add shift" to add one.</td></tr>`;
    return;
  }
  body.innerHTML = thriftScheduleShifts.map((s, i) => `
    <tr data-idx="${i}">
      <td>${dayDropdown(s.day)}</td>
      <td><input type="time" data-field="startTime" value="${escapeHtml(s.startTime || "")}" /></td>
      <td><input type="time" data-field="endTime" value="${escapeHtml(s.endTime || "")}" /></td>
      <td>${clientDropdown(s.clientId, "clientId")}</td>
      <td><input type="text" data-field="role" value="${escapeHtml(s.role || "")}" placeholder="Register, sorting…" /></td>
      <td class="thrift-slot-divider">${clientDropdown(s.clientId2, "clientId2")}</td>
      <td><input type="text" data-field="role2" value="${escapeHtml(s.role2 || "")}" placeholder="Register, sorting…" /></td>
      <td><button type="button" class="row-remove" data-action="remove" aria-label="Remove">&times;</button></td>
    </tr>
  `).join("");
}

// ----- Conflict detection -----

function detectConflicts() {
  const conflicts = [];

  for (const cs of allClientSchedulesForWeek) {
    const events = Array.isArray(cs.data.events) ? cs.data.events : [];
    for (let i = 0; i < events.length; i++) {
      for (let j = i + 1; j < events.length; j++) {
        if (eventsOverlap(events[i], events[j])) {
          conflicts.push({
            kind: "self",
            clientId: cs.data.clientId,
            clientName: cs.data.clientName || cs.data.clientId,
            a: events[i],
            b: events[j],
          });
        }
      }
    }
  }

  const csByClient = new Map();
  for (const cs of allClientSchedulesForWeek) csByClient.set(cs.data.clientId, cs);

  for (const shift of thriftScheduleShifts) {
    // Each shift can have two assigned clients; check both against their
    // personal events for overlap.
    const slotPairs = [
      { cid: shift.clientId, name: shift.clientName },
      { cid: shift.clientId2, name: shift.clientName2 },
    ];
    for (const { cid, name } of slotPairs) {
      if (!cid) continue;
      const cs = csByClient.get(cid);
      if (!cs) continue;
      const events = Array.isArray(cs.data.events) ? cs.data.events : [];
      for (const e of events) {
        if (eventsOverlap(shift, e)) {
          conflicts.push({
            kind: "thrift",
            clientId: cid,
            clientName: name || cs.data.clientName || cid,
            shift,
            event: e,
          });
        }
      }
    }
  }

  return conflicts;
}

function renderConflicts() {
  const el = document.getElementById("schedule-conflicts");
  if (!el) return;
  const conflicts = detectConflicts();
  if (conflicts.length === 0) {
    el.innerHTML = `<p class="note">No conflicts detected for this week.</p>`;
    return;
  }
  el.innerHTML = conflicts.map((c) => {
    if (c.kind === "thrift") {
      const day = DAY_LABELS[c.shift.day] || c.shift.day || "(no day)";
      const eventDesc = c.event.title || c.event.type || "event";
      return `
        <div class="conflict-row">
          <span class="conflict-client">${escapeHtml(c.clientName)}</span>
          <span class="meta">(<code>${escapeHtml(c.clientId)}</code>)</span>
          <div>
            ${escapeHtml(day)} ${escapeHtml(formatTime12(c.shift.startTime))}&ndash;${escapeHtml(formatTime12(c.shift.endTime))}
            thrift shift conflicts with
            ${escapeHtml(formatTime12(c.event.startTime))}&ndash;${escapeHtml(formatTime12(c.event.endTime))}
            ${escapeHtml(eventDesc)}.
          </div>
        </div>
      `;
    }
    const day = DAY_LABELS[c.a.day] || c.a.day || "(no day)";
    const aDesc = c.a.title || c.a.type || "event";
    const bDesc = c.b.title || c.b.type || "event";
    return `
      <div class="conflict-row">
        <span class="conflict-client">${escapeHtml(c.clientName)}</span>
        <span class="meta">(<code>${escapeHtml(c.clientId)}</code>)</span>
        <div>
          Two events overlap on ${escapeHtml(day)}:
          ${escapeHtml(formatTime12(c.a.startTime))}&ndash;${escapeHtml(formatTime12(c.a.endTime))} ${escapeHtml(aDesc)}
          vs.
          ${escapeHtml(formatTime12(c.b.startTime))}&ndash;${escapeHtml(formatTime12(c.b.endTime))} ${escapeHtml(bDesc)}.
        </div>
      </div>
    `;
  }).join("");
}

// ----- Consolidated view -----

function renderConsolidated() {
  const el = document.getElementById("schedule-consolidated");
  if (!el) return;
  const byDay = {};
  for (const day of DAYS) byDay[day] = [];
  for (const cs of allClientSchedulesForWeek) {
    const events = Array.isArray(cs.data.events) ? cs.data.events : [];
    // Fallback name lookup for older approved schedules where the inbox
    // approve path didn't write clientName (fixed 2026-05-09 in
    // approveSubmission). cachedClients is the staff-side authoritative
    // name; only fall through to clientId if the client record itself is
    // missing from the cache.
    const cached = cachedClients.find((c) => c.id === cs.data.clientId);
    const resolvedName = cs.data.clientName
      || (cached ? clientDisplayName(cached.data) : null)
      || cs.data.clientId;
    for (const e of events) {
      if (!e.day || !DAYS.includes(e.day)) continue;
      byDay[e.day].push({
        kind: "client",
        clientId: cs.data.clientId,
        clientName: resolvedName,
        ...e,
      });
    }
  }
  for (const s of thriftScheduleShifts) {
    if (!s.day || !DAYS.includes(s.day)) continue;
    // Each shift can have two assigned clients; emit a card per filled slot.
    // Shifts with no client in either slot still surface so staff can see the
    // empty time block in the consolidated view.
    const slots = [
      { cid: s.clientId, name: s.clientName, role: s.role },
      { cid: s.clientId2, name: s.clientName2, role: s.role2 },
    ].filter((slot) => slot.cid);
    if (slots.length === 0) {
      byDay[s.day].push({
        kind: "thrift",
        clientId: "",
        clientName: "(unassigned)",
        ...s,
      });
    } else {
      for (const slot of slots) {
        byDay[s.day].push({
          kind: "thrift",
          clientId: slot.cid,
          clientName: slot.name || slot.cid,
          day: s.day,
          startTime: s.startTime,
          endTime: s.endTime,
          role: slot.role || "",
        });
      }
    }
  }
  for (const day of DAYS) {
    byDay[day].sort((a, b) => {
      const am = timeToMinutes(a.startTime) ?? 1e9;
      const bm = timeToMinutes(b.startTime) ?? 1e9;
      return am - bm;
    });
  }
  const totalEvents = DAYS.reduce((sum, d) => sum + byDay[d].length, 0);
  if (totalEvents === 0) {
    el.innerHTML = `<p class="note">Nothing scheduled this week.</p>`;
    return;
  }
  el.innerHTML = DAYS.map((day) => {
    if (byDay[day].length === 0) return "";
    return `
      <div class="consolidated-day">
        <h4>${escapeHtml(DAY_LABELS[day])}</h4>
        ${byDay[day].map((e) => {
          const time = `${escapeHtml(formatTime12(e.startTime))}&ndash;${escapeHtml(formatTime12(e.endTime))}`;
          if (e.kind === "thrift") {
            return `
              <div class="consolidated-event thrift">
                <div class="when">${time}</div>
                <div class="who">${escapeHtml(e.clientName)}</div>
                <div>Thrift shift${e.role ? ` &mdash; ${escapeHtml(e.role)}` : ""}</div>
              </div>
            `;
          }
          const detail = [e.title, e.location ? `@ ${e.location}` : ""].filter(Boolean).map(escapeHtml).join(" ");
          // Stable composite key for matching events back to the array on
          // save/delete, plus the index at render time as a secondary hint.
          const eventKey = appointmentEventKey(e);
          return `
            <div class="consolidated-event is-clickable" role="button" tabindex="0"
                 data-kind="client"
                 data-client-id="${escapeHtml(e.clientId)}"
                 data-event-key="${escapeHtml(eventKey)}">
              <div class="when">${time}</div>
              <div class="who">${escapeHtml(e.clientName)}</div>
              <div>${escapeHtml(EVENT_TYPE_LABELS[e.type] || e.type || "")}${detail ? ` &mdash; ${detail}` : ""}</div>
            </div>
          `;
        }).join("")}
      </div>
    `;
  }).join("");
}

// ----- Editing handlers -----

// Floating green confirmation banner for staff-side save actions. Mirrors the
// client-app showClientActionStatus pattern but uses a dedicated toast element
// at the page level so it's visible regardless of which schedule pane the
// user is looking at when they hit Save.
let staffSaveToastTimer = null;
function showStaffSaveConfirmation(text) {
  const el = document.getElementById("staff-save-toast");
  if (!el) return;
  el.textContent = text;
  el.hidden = false;
  if (staffSaveToastTimer) clearTimeout(staffSaveToastTimer);
  staffSaveToastTimer = setTimeout(() => { el.hidden = true; }, 3500);
}

function clientScheduleMarkDirty() {
  clientScheduleDirty = true;
  const s = document.getElementById("client-schedule-status");
  if (s) {
    s.textContent = "Unsaved changes";
    s.classList.remove("muted");
    s.classList.add("error");
  }
}

function thriftScheduleMarkDirty() {
  thriftScheduleDirty = true;
  const s = document.getElementById("thrift-schedule-status");
  if (s) {
    s.textContent = "Unsaved changes";
    s.classList.remove("muted");
    s.classList.add("error");
  }
}

function applyEditToRow(eventArr, e) {
  const tr = e.target.closest("tr[data-idx]");
  if (!tr) return false;
  const idx = Number(tr.dataset.idx);
  const field = e.target.dataset.field;
  if (!Number.isInteger(idx) || !field || !eventArr[idx]) return false;
  eventArr[idx][field] = e.target.value;
  return true;
}

const clientScheduleBody = document.getElementById("client-schedule-body");
if (clientScheduleBody) {
  clientScheduleBody.addEventListener("change", (e) => {
    if (applyEditToRow(clientScheduleEvents, e)) clientScheduleMarkDirty();
  });
  clientScheduleBody.addEventListener("input", (e) => {
    if (e.target.tagName === "INPUT" && e.target.type === "text") {
      if (applyEditToRow(clientScheduleEvents, e)) clientScheduleMarkDirty();
    }
  });
  clientScheduleBody.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-action='remove']");
    if (!btn) return;
    const tr = btn.closest("tr[data-idx]");
    if (!tr) return;
    const idx = Number(tr.dataset.idx);
    if (Number.isInteger(idx) && clientScheduleEvents[idx]) {
      clientScheduleEvents.splice(idx, 1);
      renderClientScheduleTable();
      clientScheduleMarkDirty();
    }
  });
}

const thriftScheduleBody = document.getElementById("thrift-schedule-body");
if (thriftScheduleBody) {
  thriftScheduleBody.addEventListener("change", (e) => {
    if (applyEditToRow(thriftScheduleShifts, e)) thriftScheduleMarkDirty();
  });
  thriftScheduleBody.addEventListener("input", (e) => {
    if (e.target.tagName === "INPUT" && e.target.type === "text") {
      if (applyEditToRow(thriftScheduleShifts, e)) thriftScheduleMarkDirty();
    }
  });
  thriftScheduleBody.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-action='remove']");
    if (!btn) return;
    const tr = btn.closest("tr[data-idx]");
    if (!tr) return;
    const idx = Number(tr.dataset.idx);
    if (Number.isInteger(idx) && thriftScheduleShifts[idx]) {
      thriftScheduleShifts.splice(idx, 1);
      renderThriftScheduleTable();
      thriftScheduleMarkDirty();
    }
  });
}

document.getElementById("client-schedule-add")?.addEventListener("click", () => {
  if (!scheduleSelectedClient) return;
  clientScheduleEvents.push({ day: "", startTime: "", endTime: "", type: "", title: "", location: "", notes: "" });
  renderClientScheduleTable();
  clientScheduleMarkDirty();
});

document.getElementById("thrift-schedule-add")?.addEventListener("click", () => {
  thriftScheduleShifts.push({ day: "", startTime: "", endTime: "", clientId: "", clientName: "", role: "" });
  renderThriftScheduleTable();
  thriftScheduleMarkDirty();
});

// ----- Save handlers -----

async function saveClientSchedule() {
  if (!scheduleSelectedClient) return;
  const cid = scheduleSelectedClient.clientId;
  const docId = `${cid}-${scheduleWeekStart}`;
  const ref = doc(db, "clientWeeklySchedule", docId);
  const events = clientScheduleEvents
    .filter((e) => e.day || e.startTime || e.endTime || e.title || e.location || e.notes || e.type)
    .map((e) => ({
      day: e.day || "",
      startTime: e.startTime || "",
      endTime: e.endTime || "",
      type: e.type || "",
      title: e.title || "",
      location: e.location || "",
      notes: e.notes || "",
    }));

  const saveBtn = document.getElementById("client-schedule-save");
  if (saveBtn) saveBtn.disabled = true;
  try {
    await runTransaction(db, async (txn) => {
      const snap = await txn.get(ref);
      const isFirst = !snap.exists();
      const payload = {
        clientId: cid,
        clientName: scheduleSelectedClient.name,
        weekStart: scheduleWeekStart,
        weekStartTimestamp: Timestamp.fromDate(new Date(scheduleWeekStart + "T00:00:00")),
        events,
        updatedAt: serverTimestamp(),
        updatedBy: auth.currentUser.email,
        expiresAt: scheduleExpiresAt(scheduleWeekStart),
      };
      if (isFirst) {
        payload.createdAt = serverTimestamp();
        payload.createdBy = auth.currentUser.email;
      }
      txn.set(ref, payload, { merge: true });
    });

    clientScheduleIsNew = false;
    clientScheduleDirty = false;
    clientScheduleEvents = events;
    renderClientScheduleTable();

    // Sync the in-memory all-schedules cache so conflicts + consolidated reflect the save
    const existing = allClientSchedulesForWeek.find((cs) => cs.id === docId);
    if (existing) {
      existing.data = { ...existing.data, events, clientName: scheduleSelectedClient.name };
    } else {
      allClientSchedulesForWeek.push({
        id: docId,
        data: {
          clientId: cid,
          clientName: scheduleSelectedClient.name,
          weekStart: scheduleWeekStart,
          events,
        },
      });
    }

    await logAccess(AUDIT_ACTIONS.UPDATE, "clientWeeklySchedule", docId, {
      clientId: cid, weekStart: scheduleWeekStart, eventCount: events.length,
    });

    const s = document.getElementById("client-schedule-status");
    if (s) {
      s.textContent = `Saved ${new Date().toLocaleTimeString()}`;
      s.classList.remove("error");
      s.classList.add("muted");
    }
    showStaffSaveConfirmation("Client schedule saved");
    renderConflicts();
    renderConsolidated();
  } catch (err) {
    alert(`Save failed: ${err.message}`);
  } finally {
    if (saveBtn) saveBtn.disabled = false;
  }
}

async function saveThriftSchedule() {
  const ref = doc(db, "thriftStoreSchedule", scheduleWeekStart);
  const shifts = thriftScheduleShifts
    .filter((s) => s.day || s.startTime || s.endTime || s.clientId || s.role || s.clientId2 || s.role2)
    .map((s) => {
      let clientName = s.clientName || "";
      if (s.clientId) {
        const c = cachedClients.find((c) => c.id === s.clientId);
        if (c) clientName = [c.data.firstName, c.data.middleName, c.data.lastName].filter(Boolean).join(" ");
      } else {
        clientName = "";
      }
      let clientName2 = s.clientName2 || "";
      if (s.clientId2) {
        const c2 = cachedClients.find((c) => c.id === s.clientId2);
        if (c2) clientName2 = [c2.data.firstName, c2.data.middleName, c2.data.lastName].filter(Boolean).join(" ");
      } else {
        clientName2 = "";
      }
      return {
        day: s.day || "",
        startTime: s.startTime || "",
        endTime: s.endTime || "",
        clientId: s.clientId || "",
        clientName,
        role: s.role || "",
        clientId2: s.clientId2 || "",
        clientName2,
        role2: s.role2 || "",
      };
    });

  const saveBtn = document.getElementById("thrift-schedule-save");
  if (saveBtn) saveBtn.disabled = true;
  try {
    await runTransaction(db, async (txn) => {
      const snap = await txn.get(ref);
      const isFirst = !snap.exists();
      const payload = {
        weekStart: scheduleWeekStart,
        weekStartTimestamp: Timestamp.fromDate(new Date(scheduleWeekStart + "T00:00:00")),
        shifts,
        updatedAt: serverTimestamp(),
        updatedBy: auth.currentUser.email,
        expiresAt: scheduleExpiresAt(scheduleWeekStart),
      };
      if (isFirst) {
        payload.createdAt = serverTimestamp();
        payload.createdBy = auth.currentUser.email;
      }
      txn.set(ref, payload, { merge: true });
    });

    thriftScheduleIsNew = false;
    thriftScheduleDirty = false;
    thriftScheduleShifts = shifts;
    renderThriftScheduleTable();
    // Inbox conflict detection reads canonical thrift shifts from a cache;
    // invalidate the entry for this week so the next Inbox render fetches
    // the just-saved state.
    inboxThriftCache.delete(scheduleWeekStart);

    await logAccess(AUDIT_ACTIONS.UPDATE, "thriftStoreSchedule", scheduleWeekStart, {
      shiftCount: shifts.length,
    });

    const s = document.getElementById("thrift-schedule-status");
    if (s) {
      s.textContent = `Saved ${new Date().toLocaleTimeString()}`;
      s.classList.remove("error");
      s.classList.add("muted");
    }
    showStaffSaveConfirmation("Thrift schedule saved");
    renderConflicts();
    renderConsolidated();
  } catch (err) {
    alert(`Save failed: ${err.message}`);
  } finally {
    if (saveBtn) saveBtn.disabled = false;
  }
}

document.getElementById("client-schedule-save")?.addEventListener("click", saveClientSchedule);
document.getElementById("thrift-schedule-save")?.addEventListener("click", saveThriftSchedule);
document.getElementById("thrift-schedule-print")?.addEventListener("click", handleThriftPrint);

// ----- Printable thrift schedule -----
//
// Renders the current week's thrift shifts as a Mon–Sat matrix grouped by
// time slot (rows) so staff can post a clean copy in the store. Slot rows
// are derived from whatever start/end times are actually saved this week
// — if Daniel runs the standard 9–12 / 12–3 / 2–5, those become the rows;
// if a one-off shift uses a different time, it gets its own row. Each
// cell shows the assigned client name(s); empty cells render an underline
// so anyone covering can write in by hand.

function compareTimes(a, b) {
  // Both are "HH:MM" strings; lexicographic compare works correctly.
  return (a || "").localeCompare(b || "");
}

function fmt12h(hhmm) {
  if (!hhmm || !/^\d{2}:\d{2}$/.test(hhmm)) return hhmm || "";
  const [h, m] = hhmm.split(":").map(Number);
  const ampm = h >= 12 ? "p" : "a";
  const h12 = ((h + 11) % 12) + 1;
  return m === 0 ? `${h12}${ampm}` : `${h12}:${String(m).padStart(2, "0")}${ampm}`;
}

function buildThriftPrintMatrix(shifts) {
  // Mon–Sat (Sunday is excluded — store closed on Sundays per Daniel).
  const days = DAYS.slice(0, 6);
  const slotMap = new Map();
  for (const s of shifts) {
    if (!s.day || !days.includes(s.day)) continue;
    if (!s.startTime) continue;
    const key = `${s.startTime}-${s.endTime || ""}`;
    if (!slotMap.has(key)) {
      const cells = {};
      for (const d of days) cells[d] = [];
      slotMap.set(key, { startTime: s.startTime, endTime: s.endTime || "", cells });
    }
    const slot = slotMap.get(key);
    // Each shift can have up to two assigned clients; push each filled slot
    // as its own name. The cell renderer pads to 2 lines per cell anyway.
    if (s.clientId || s.clientName) {
      slot.cells[s.day].push(s.clientName || s.clientId || "");
    }
    if (s.clientId2 || s.clientName2) {
      slot.cells[s.day].push(s.clientName2 || s.clientId2 || "");
    }
  }
  const slots = [...slotMap.values()].sort((a, b) => compareTimes(a.startTime, b.startTime));
  return { days, slots };
}

function renderThriftPrintHtml(weekStart, shifts) {
  const start = new Date(weekStart + "T00:00:00");
  const end = new Date(start);
  end.setDate(end.getDate() + 5); // Saturday
  const fmtDay = (d) => d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
  const fmtFull = (d) => d.toLocaleDateString(undefined, { weekday: "long", year: "numeric", month: "long", day: "numeric" });
  const headerRange = `${fmtDay(start)} – ${fmtDay(end)}, ${start.getFullYear()}`;

  const { days, slots } = buildThriftPrintMatrix(shifts);

  if (!slots.length) {
    return `
      <h1>${TENANT.orgShort} Thrift Store Schedule</h1>
      <p class="thrift-print-week">Week of ${escapeHtml(fmtFull(start))} (${escapeHtml(headerRange)})</p>
      <p class="thrift-print-empty">No shifts scheduled for this week.</p>
    `;
  }

  // Each cell renders up to 2 client names by default (matches the
  // "2 clients per shift" target). If staff added more than 2 to a cell,
  // we still show all of them; if fewer, we pad with blank lines so
  // anyone covering can write in by hand.
  const slotsPerCell = 2;
  const headerCells = days.map((d) =>
    `<th>${escapeHtml(DAY_LABELS[d])}</th>`
  ).join("");

  const bodyRows = slots.map((slot) => {
    const slotLabel = slot.endTime
      ? `${fmt12h(slot.startTime)}–${fmt12h(slot.endTime)}`
      : fmt12h(slot.startTime);
    const cells = days.map((d) => {
      const names = slot.cells[d];
      const lines = [];
      for (let i = 0; i < Math.max(slotsPerCell, names.length); i++) {
        const n = names[i];
        lines.push(n
          ? `<div class="thrift-print-name">${escapeHtml(n)}</div>`
          : `<div class="thrift-print-blank">&nbsp;</div>`);
      }
      return `<td>${lines.join("")}</td>`;
    }).join("");
    return `<tr><th class="thrift-print-shift">${escapeHtml(slotLabel)}</th>${cells}</tr>`;
  }).join("");

  return `
    <h1>${TENANT.orgShort} Thrift Store Schedule</h1>
    <p class="thrift-print-week">Week of ${escapeHtml(fmtFull(start))} (${escapeHtml(headerRange)})</p>
    <table class="thrift-print-table">
      <thead><tr><th class="thrift-print-shift">Shift</th>${headerCells}</tr></thead>
      <tbody>${bodyRows}</tbody>
    </table>
    <p class="thrift-print-foot note">Printed ${escapeHtml(new Date().toLocaleString())}.</p>
  `;
}

async function handleThriftPrint() {
  if (!scheduleWeekStart) return;
  const content = document.getElementById("thrift-print-content");
  if (!content) return;
  content.innerHTML = renderThriftPrintHtml(scheduleWeekStart, thriftScheduleShifts);
  document.body.classList.add("printing-thrift");

  // afterprint fires whether the user prints, saves to PDF, or cancels.
  // Use it (with a beforeprint fallback) to clean up the body class so
  // the regular UI doesn't stay hidden if the print dialog is dismissed.
  const cleanup = () => {
    document.body.classList.remove("printing-thrift");
    window.removeEventListener("afterprint", cleanup);
  };
  window.addEventListener("afterprint", cleanup);

  // Defer the print call so the browser has rendered the new HTML before
  // the print dialog snapshot is taken.
  setTimeout(() => window.print(), 50);

  await logAccess(AUDIT_ACTIONS.PRINT, "thriftStoreSchedule", scheduleWeekStart, {
    surface: "thrift-print", shiftCount: thriftScheduleShifts.length,
  });
}

// ----- Appointment edit/add modal (driven from the consolidated view) -----
//
// Lets staff click any personal appointment in the consolidated view to edit
// or delete it, and add a brand-new appointment for any client without first
// switching to the per-client editor. Thrift shifts are NOT edited here —
// they have their own editor with two-slot semantics.
//
// Event matching strategy: each card carries a composite data-event-key
// (day|startTime|endTime|type|title). On save/delete we re-find the event in
// the live events array by key to survive reorders.

let appointmentModalState = { mode: "add", clientId: "", eventKey: "" };

function appointmentEventKey(e) {
  return `${e.day || ""}|${e.startTime || ""}|${e.endTime || ""}|${e.type || ""}|${e.title || ""}`;
}

function appointmentModalEl(id) {
  return document.getElementById(id);
}

function populateAppointmentModalClientDropdown(selectedCid) {
  const sel = appointmentModalEl("appointment-modal-client");
  if (!sel) return;
  const active = cachedClients.filter((c) => c.data.status === "active");
  sel.innerHTML = `<option value="">—</option>` + active.map((c) => {
    const name = [c.data.firstName, c.data.middleName, c.data.lastName].filter(Boolean).join(" ");
    return `<option value="${escapeHtml(c.id)}"${selectedCid === c.id ? " selected" : ""}>${escapeHtml(name)} (${escapeHtml(c.id)})</option>`;
  }).join("");
}

function showAppointmentModalMsg(text, kind = "error") {
  const el = appointmentModalEl("appointment-modal-msg");
  if (!el) return;
  el.textContent = text;
  el.classList.remove("ok", "error");
  el.classList.add(kind);
  el.hidden = !text;
}

function openAppointmentModal(mode, prefill) {
  const dlg = appointmentModalEl("appointment-modal");
  if (!dlg) return;
  appointmentModalState = {
    mode,
    clientId: prefill?.clientId || "",
    eventKey: prefill?.eventKey || "",
  };
  appointmentModalEl("appointment-modal-title").textContent =
    mode === "edit" ? "Edit appointment" : "Add appointment";
  populateAppointmentModalClientDropdown(prefill?.clientId);
  const clientSel = appointmentModalEl("appointment-modal-client");
  if (clientSel) clientSel.disabled = mode === "edit";
  appointmentModalEl("appointment-modal-day").value = prefill?.day || "";
  appointmentModalEl("appointment-modal-start").value = prefill?.startTime || "";
  appointmentModalEl("appointment-modal-end").value = prefill?.endTime || "";
  appointmentModalEl("appointment-modal-type").value = prefill?.type || "";
  appointmentModalEl("appointment-modal-event-title").value = prefill?.title || "";
  appointmentModalEl("appointment-modal-location").value = prefill?.location || "";
  appointmentModalEl("appointment-modal-notes").value = prefill?.notes || "";
  const deleteBtn = appointmentModalEl("appointment-modal-delete");
  if (deleteBtn) deleteBtn.hidden = mode !== "edit";
  showAppointmentModalMsg("", "ok");
  if (typeof dlg.showModal === "function") dlg.showModal();
  else dlg.setAttribute("open", "");
}

function closeAppointmentModal() {
  const dlg = appointmentModalEl("appointment-modal");
  if (!dlg) return;
  if (typeof dlg.close === "function") dlg.close();
  else dlg.removeAttribute("open");
}

function readAppointmentModalFields() {
  return {
    clientId: appointmentModalEl("appointment-modal-client").value || "",
    day: appointmentModalEl("appointment-modal-day").value || "",
    startTime: appointmentModalEl("appointment-modal-start").value || "",
    endTime: appointmentModalEl("appointment-modal-end").value || "",
    type: appointmentModalEl("appointment-modal-type").value || "",
    title: appointmentModalEl("appointment-modal-event-title").value.trim(),
    location: appointmentModalEl("appointment-modal-location").value.trim(),
    notes: appointmentModalEl("appointment-modal-notes").value.trim(),
  };
}

async function saveAppointmentModal() {
  const fields = readAppointmentModalFields();
  const cid = appointmentModalState.mode === "edit"
    ? appointmentModalState.clientId
    : fields.clientId;
  if (!cid) { showAppointmentModalMsg("Pick a client."); return; }
  if (!fields.day) { showAppointmentModalMsg("Pick a day."); return; }
  if (!fields.startTime || !fields.endTime) { showAppointmentModalMsg("Set both start and end times."); return; }
  if (timeToMinutes(fields.startTime) >= timeToMinutes(fields.endTime)) {
    showAppointmentModalMsg("End time must be after start time."); return;
  }
  if (!fields.type) { showAppointmentModalMsg("Pick a type."); return; }

  const docId = `${cid}-${scheduleWeekStart}`;
  const ref = doc(db, "clientWeeklySchedule", docId);
  const cachedClient = cachedClients.find((c) => c.id === cid);
  const clientName = cachedClient
    ? [cachedClient.data.firstName, cachedClient.data.middleName, cachedClient.data.lastName].filter(Boolean).join(" ")
    : cid;

  const newEvent = {
    day: fields.day,
    startTime: fields.startTime,
    endTime: fields.endTime,
    type: fields.type,
    title: fields.title,
    location: fields.location,
    notes: fields.notes,
  };

  const saveBtn = appointmentModalEl("appointment-modal-save");
  if (saveBtn) saveBtn.disabled = true;
  try {
    await runTransaction(db, async (txn) => {
      const snap = await txn.get(ref);
      const isFirst = !snap.exists();
      const existing = isFirst ? [] : (Array.isArray(snap.data().events) ? snap.data().events : []);
      let next;
      if (appointmentModalState.mode === "edit") {
        const targetKey = appointmentModalState.eventKey;
        const idx = existing.findIndex((e) => appointmentEventKey(e) === targetKey);
        if (idx === -1) {
          // Lost the original (someone else edited it since this modal opened).
          // Surface the conflict instead of silently creating a duplicate.
          throw new Error("This appointment was changed by someone else. Close and re-open to see the latest.");
        }
        next = existing.slice();
        next[idx] = newEvent;
      } else {
        next = existing.concat([newEvent]);
      }
      const payload = {
        clientId: cid,
        clientName,
        weekStart: scheduleWeekStart,
        weekStartTimestamp: Timestamp.fromDate(new Date(scheduleWeekStart + "T00:00:00")),
        events: next,
        updatedAt: serverTimestamp(),
        updatedBy: auth.currentUser.email,
        expiresAt: scheduleExpiresAt(scheduleWeekStart),
      };
      if (isFirst) {
        payload.createdAt = serverTimestamp();
        payload.createdBy = auth.currentUser.email;
      }
      txn.set(ref, payload, { merge: true });
    });

    // Refresh the in-memory cache so consolidated + conflicts re-render with
    // the just-written state (mirrors saveClientSchedule).
    const freshSnap = await getDoc(ref);
    if (freshSnap.exists()) {
      const data = freshSnap.data();
      const existing = allClientSchedulesForWeek.find((cs) => cs.id === docId);
      if (existing) existing.data = data;
      else allClientSchedulesForWeek.push({ id: docId, data });
      // If the user happens to have this client picked in the per-client
      // editor, refresh the editor's view too.
      if (scheduleSelectedClient && scheduleSelectedClient.clientId === cid) {
        clientScheduleEvents = Array.isArray(data.events) ? data.events.map((e) => ({ ...e })) : [];
        clientScheduleIsNew = false;
        clientScheduleDirty = false;
        renderClientScheduleTable();
      }
    }

    await logAccess(AUDIT_ACTIONS.UPDATE, "clientWeeklySchedule", docId, {
      clientId: cid,
      weekStart: scheduleWeekStart,
      surface: appointmentModalState.mode === "edit" ? "consolidated-edit" : "consolidated-add",
      eventCount: 1,
    });

    renderConflicts();
    renderConsolidated();
    closeAppointmentModal();
  } catch (err) {
    showAppointmentModalMsg(`Save failed: ${err.message}`);
  } finally {
    if (saveBtn) saveBtn.disabled = false;
  }
}

async function deleteAppointmentModal() {
  if (appointmentModalState.mode !== "edit") return;
  if (!confirm("Delete this appointment? This can't be undone.")) return;

  const cid = appointmentModalState.clientId;
  const targetKey = appointmentModalState.eventKey;
  const docId = `${cid}-${scheduleWeekStart}`;
  const ref = doc(db, "clientWeeklySchedule", docId);
  const deleteBtn = appointmentModalEl("appointment-modal-delete");
  if (deleteBtn) deleteBtn.disabled = true;
  try {
    await runTransaction(db, async (txn) => {
      const snap = await txn.get(ref);
      if (!snap.exists()) throw new Error("Schedule no longer exists.");
      const existing = Array.isArray(snap.data().events) ? snap.data().events : [];
      const idx = existing.findIndex((e) => appointmentEventKey(e) === targetKey);
      if (idx === -1) {
        throw new Error("This appointment was changed by someone else. Close and re-open to see the latest.");
      }
      const next = existing.slice();
      next.splice(idx, 1);
      txn.set(ref, {
        events: next,
        updatedAt: serverTimestamp(),
        updatedBy: auth.currentUser.email,
      }, { merge: true });
    });

    const freshSnap = await getDoc(ref);
    if (freshSnap.exists()) {
      const data = freshSnap.data();
      const existing = allClientSchedulesForWeek.find((cs) => cs.id === docId);
      if (existing) existing.data = data;
      if (scheduleSelectedClient && scheduleSelectedClient.clientId === cid) {
        clientScheduleEvents = Array.isArray(data.events) ? data.events.map((e) => ({ ...e })) : [];
        clientScheduleIsNew = false;
        clientScheduleDirty = false;
        renderClientScheduleTable();
      }
    }

    await logAccess(AUDIT_ACTIONS.UPDATE, "clientWeeklySchedule", docId, {
      clientId: cid,
      weekStart: scheduleWeekStart,
      surface: "consolidated-delete",
    });

    renderConflicts();
    renderConsolidated();
    closeAppointmentModal();
  } catch (err) {
    showAppointmentModalMsg(`Delete failed: ${err.message}`);
  } finally {
    if (deleteBtn) deleteBtn.disabled = false;
  }
}

function handleConsolidatedClick(e) {
  const card = e.target.closest('.consolidated-event[data-kind="client"]');
  if (!card) return;
  const cid = card.dataset.clientId;
  const key = card.dataset.eventKey;
  if (!cid) return;
  const cs = allClientSchedulesForWeek.find((s) => s.data.clientId === cid);
  if (!cs) return;
  const event = (cs.data.events || []).find((ev) => appointmentEventKey(ev) === key);
  if (!event) return;
  openAppointmentModal("edit", { clientId: cid, eventKey: key, ...event });
}

function handleConsolidatedKeydown(e) {
  if (e.key !== "Enter" && e.key !== " ") return;
  const card = e.target.closest('.consolidated-event[data-kind="client"]');
  if (!card) return;
  e.preventDefault();
  handleConsolidatedClick(e);
}

document.getElementById("schedule-consolidated")?.addEventListener("click", handleConsolidatedClick);
document.getElementById("schedule-consolidated")?.addEventListener("keydown", handleConsolidatedKeydown);
document.getElementById("consolidated-add-appointment")?.addEventListener("click", () => {
  if (!scheduleWeekStart) {
    alert("Pick a week first.");
    return;
  }
  openAppointmentModal("add", {});
});
document.getElementById("appointment-modal-save")?.addEventListener("click", saveAppointmentModal);
document.getElementById("appointment-modal-delete")?.addEventListener("click", deleteAppointmentModal);
document.getElementById("appointment-modal-cancel")?.addEventListener("click", closeAppointmentModal);

// ----- Week navigation -----

async function changeWeek(newWeekStart, force = false) {
  if (!force && (clientScheduleDirty || thriftScheduleDirty)) {
    if (!confirm("Unsaved changes will be lost. Continue?")) return;
  }
  scheduleWeekStart = newWeekStart;
  const input = document.getElementById("schedule-week");
  if (input) input.value = newWeekStart;

  scheduleSelectedClient = null;
  scheduleClientPicker?.clear();
  const editor = document.getElementById("client-schedule-editor");
  if (editor) editor.hidden = true;
  clientScheduleEvents = [];
  clientScheduleDirty = false;
  const cs = document.getElementById("client-schedule-status");
  if (cs) {
    cs.textContent = "No changes";
    cs.classList.remove("error");
    cs.classList.add("muted");
  }

  await loadAllForWeek(newWeekStart);
  renderThriftScheduleTable();
  const ts = document.getElementById("thrift-schedule-status");
  if (ts) {
    ts.textContent = "No changes";
    ts.classList.remove("error");
    ts.classList.add("muted");
  }
  renderConflicts();
  renderConsolidated();
}

const scheduleWeekInput = document.getElementById("schedule-week");
if (scheduleWeekInput) {
  scheduleWeekInput.addEventListener("change", () => {
    if (!scheduleWeekInput.value) return;
    const monday = mondayOf(scheduleWeekInput.value);
    if (monday !== scheduleWeekStart) changeWeek(monday);
    else scheduleWeekInput.value = monday;
  });
}
document.getElementById("schedule-prev-week")?.addEventListener("click", () => {
  if (scheduleWeekStart) changeWeek(addDays(scheduleWeekStart, -7));
});
document.getElementById("schedule-next-week")?.addEventListener("click", () => {
  if (scheduleWeekStart) changeWeek(addDays(scheduleWeekStart, 7));
});
document.getElementById("schedule-this-week")?.addEventListener("click", () => {
  changeWeek(mondayOf(new Date()));
});

// ----- Mount client picker -----

const scheduleClientPickerRoot = document.getElementById("client-schedule-picker");
if (scheduleClientPickerRoot) {
  scheduleClientPicker = createClientPicker({
    root: scheduleClientPickerRoot,
    placeholder: "Search and select a client to edit their week…",
    onChange: async (client) => {
      scheduleSelectedClient = client;
      const editor = document.getElementById("client-schedule-editor");
      if (!client) {
        if (editor) editor.hidden = true;
        clientScheduleEvents = [];
        return;
      }
      if (editor) editor.hidden = false;
      await loadClientSchedule(client.clientId, scheduleWeekStart);
      renderClientScheduleTable();
      const cs = document.getElementById("client-schedule-status");
      if (cs) {
        cs.textContent = "No changes";
        cs.classList.remove("error");
        cs.classList.add("muted");
      }
    },
  });
}

// First-load hook: clients-listener fires this on the first snapshot of the
// session. We need cachedClients populated to render the thrift client
// dropdown and to filter active clients for the consolidated view.
function tryInitSchedules() {
  if (scheduleInitialized) return;
  if (!scheduleWeekInput) return;
  scheduleInitialized = true;
  scheduleWeekStart = mondayOf(new Date());
  scheduleWeekInput.value = scheduleWeekStart;
  loadAllForWeek(scheduleWeekStart).then(() => {
    renderThriftScheduleTable();
    renderConflicts();
    renderConsolidated();
  }).catch((err) => {
    console.warn("schedule init failed:", err);
  });
}

// ============================================================
// Weekly Reports
// ============================================================
//
// Replaces the hand-typed weekly metrics workflow. Ad-hoc compute on
// every week navigation; no persisted reports/{week} doc. Single-field
// range queries on intakeDate/exitDate/createdAt/dateResolved use
// auto-created indexes — no schema deploy required.
//
// Demographic stats reflect the CURRENT state of active clients, not a
// historical snapshot of the week. Activity counts (intakes/exits/
// self-evals) and daily aggregates (roster totals) ARE historical.

let reportInitialized = false;
let reportMode = "weekly"; // "daily" | "weekly" | "monthly" | "yearly" | "client"
let reportDay = null;     // YYYY-MM-DD
let reportWeekStart = null;
let reportMonth = null;   // YYYY-MM
let reportYear = null;
let reportClientId = null;
let reportClientPicker = null;

function dayRange(yyyymmdd) {
  const start = new Date(yyyymmdd + "T00:00:00");
  const end = new Date(start);
  end.setDate(start.getDate() + 1);
  return {
    start, end,
    startTs: Timestamp.fromDate(start),
    endTs: Timestamp.fromDate(end),
  };
}

function weekRange(weekStart) {
  const start = new Date(weekStart + "T00:00:00");
  const end = new Date(start);
  end.setDate(start.getDate() + 7);
  return {
    start, end,
    startTs: Timestamp.fromDate(start),
    endTs: Timestamp.fromDate(end),
  };
}

function monthRange(yyyymm) {
  const [y, m] = yyyymm.split("-").map(Number);
  const start = new Date(y, m - 1, 1, 0, 0, 0);
  const end = new Date(y, m, 1, 0, 0, 0);
  return {
    start, end,
    startTs: Timestamp.fromDate(start),
    endTs: Timestamp.fromDate(end),
  };
}

function yearRange(year) {
  const start = new Date(year, 0, 1, 0, 0, 0);
  const end = new Date(year + 1, 0, 1, 0, 0, 0);
  return {
    start, end,
    startTs: Timestamp.fromDate(start),
    endTs: Timestamp.fromDate(end),
  };
}

function thisMonthString() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

function addMonths(yyyymm, n) {
  const [y, m] = yyyymm.split("-").map(Number);
  const d = new Date(y, m - 1 + n, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

function todayString() {
  return localDateString(new Date());
}

function fmtReportDate(d) {
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

// Demographic helpers — used to slice both active-clients snapshot and the
// gained-this-period rows.

const AGE_RANGE_BUCKETS = ["under18", "18-24", "25-34", "35-44", "45-54", "55-64", "65+", "unknown"];
const AGE_RANGE_LABELS = {
  "under18": "Under 18",
  "18-24": "18–24",
  "25-34": "25–34",
  "35-44": "35–44",
  "45-54": "45–54",
  "55-64": "55–64",
  "65+": "65+",
  "unknown": "Unknown",
};

function ageOf(client) {
  if (!client?.dob || typeof client.dob.toDate !== "function") return null;
  const dob = client.dob.toDate();
  if (isNaN(dob)) return null;
  const today = new Date();
  let age = today.getFullYear() - dob.getFullYear();
  const monthDiff = today.getMonth() - dob.getMonth();
  if (monthDiff < 0 || (monthDiff === 0 && today.getDate() < dob.getDate())) age--;
  return age >= 0 && age < 130 ? age : null;
}

function ageBucketOf(age) {
  if (age == null) return "unknown";
  if (age < 18) return "under18";
  if (age <= 24) return "18-24";
  if (age <= 34) return "25-34";
  if (age <= 44) return "35-44";
  if (age <= 54) return "45-54";
  if (age <= 64) return "55-64";
  return "65+";
}

// Build a clientId → master map from cachedClients for fast lookups while
// computing breakdowns (no extra Firestore reads).
function clientMap() {
  const m = new Map();
  for (const c of cachedClients) m.set(c.id, c.data);
  return m;
}

function emptyDemographicAgg() {
  return {
    race: {},
    hispanic: { yes: 0, no: 0, na: 0, unspecified: 0 },
    ageRange: AGE_RANGE_BUCKETS.reduce((acc, k) => (acc[k] = 0, acc), {}),
    veteran: { yes: 0, no: 0 },
    marital: {},
    employed: { yes: 0, no: 0 },
    total: 0,
  };
}

function tallyDemographics(agg, master) {
  if (!master) return;
  agg.total++;
  const races = Array.isArray(master.raceEthnicity) ? master.raceEthnicity : [];
  for (const r of races) agg.race[r] = (agg.race[r] || 0) + 1;
  const h = master.hispanicLatino;
  if (h && Object.prototype.hasOwnProperty.call(agg.hispanic, h)) agg.hispanic[h]++;
  else agg.hispanic.unspecified++;
  agg.ageRange[ageBucketOf(ageOf(master))]++;
  if (master.veteran === true) agg.veteran.yes++;
  else agg.veteran.no++;
  const ms = master.maritalStatus || "unspecified";
  agg.marital[ms] = (agg.marital[ms] || 0) + 1;
  if (master.currentEmployment) agg.employed.yes++;
  else agg.employed.no++;
}

function renderDemographicAgg(agg) {
  if (!agg.total) return `<p class="note">No clients in this group.</p>`;
  const raceList = Object.entries(agg.race)
    .sort((a, b) => b[1] - a[1])
    .map(([k, v]) => `<li>${escapeHtml(RACE_LABELS[k] || k)}: ${v}</li>`)
    .join("");
  const ageList = AGE_RANGE_BUCKETS
    .filter((b) => agg.ageRange[b] > 0)
    .map((b) => `<li>${escapeHtml(AGE_RANGE_LABELS[b])}: ${agg.ageRange[b]}</li>`)
    .join("");
  const maritalList = Object.entries(agg.marital)
    .sort((a, b) => b[1] - a[1])
    .map(([k, v]) => `<li>${escapeHtml(MARITAL_LABELS[k] || k || "Unspecified")}: ${v}</li>`)
    .join("");
  return `
    <div class="demographic-breakdown">
      <dl class="kv-grid">
        ${kv("Total in group", agg.total)}
        ${raceList ? `<dt>Race / ethnicity</dt><dd><ul class="breakdown">${raceList}</ul></dd>` : ""}
        ${kv("Hispanic / Latino — Yes", agg.hispanic.yes)}
        ${kv("Hispanic / Latino — No", agg.hispanic.no)}
        ${agg.hispanic.na ? kv("Hispanic / Latino — N/A", agg.hispanic.na) : ""}
        ${ageList ? `<dt>Age range</dt><dd><ul class="breakdown">${ageList}</ul></dd>` : ""}
        ${kv("Veterans", agg.veteran.yes)}
        ${maritalList ? `<dt>Marital status</dt><dd><ul class="breakdown">${maritalList}</ul></dd>` : ""}
        ${kv("Currently employed", agg.employed.yes)}
      </dl>
    </div>
  `;
}

async function loadReport(opts) {
  const { kind, range, weekStart } = opts;

  // Roster fetch:
  //   daily   → 1 getDoc call by docId
  //   weekly  → 7 getDoc calls by docId (YYYY-MM-DD)
  //   monthly → single range query on dateTimestamp (auto-indexed single field)
  //   yearly  → single range query on dateTimestamp
  // useRosterRangeQuery covers monthly + yearly.
  const rosterDates = [];
  if (kind === "weekly") {
    for (let i = 0; i < 7; i++) rosterDates.push(addDays(weekStart, i));
  } else if (kind === "daily") {
    rosterDates.push(opts.day);
  }
  const useRosterRangeQuery = kind === "yearly" || kind === "monthly";

  const [intakesSnap, exitsSnap, seCreatedSnap, seResolvedSnap, allUnresolvedSnap, statusUpdatesSnap, rangeRostersSnap, ...rosterSnaps] =
    await Promise.all([
      getDocs(query(
        collection(db, "intakes"),
        where("intakeDate", ">=", range.startTs),
        where("intakeDate", "<", range.endTs),
      )),
      getDocs(query(
        collection(db, "exits"),
        where("exitDate", ">=", range.startTs),
        where("exitDate", "<", range.endTs),
      )),
      getDocs(query(
        collection(db, "selfEvaluations"),
        where("createdAt", ">=", range.startTs),
        where("createdAt", "<", range.endTs),
      )),
      getDocs(query(
        collection(db, "selfEvaluations"),
        where("dateResolved", ">=", range.startTs),
        where("dateResolved", "<", range.endTs),
      )),
      getDocs(query(
        collection(db, "selfEvaluations"),
        where("dateResolved", "==", null),
      )),
      getDocs(query(
        collection(db, "clientStatusUpdates"),
        where("occurredOn", ">=", range.startTs),
        where("occurredOn", "<", range.endTs),
      )),
      useRosterRangeQuery
        ? getDocs(query(
            collection(db, "dailyGuestRoster"),
            where("dateTimestamp", ">=", range.startTs),
            where("dateTimestamp", "<", range.endTs),
          ))
        : Promise.resolve(null),
      ...rosterDates.map((d) => getDoc(doc(db, "dailyGuestRoster", d))),
    ]);

  const intakes = intakesSnap.docs.map((d) => d.data());
  const exits = exitsSnap.docs.map((d) => d.data());
  const seCreated = seCreatedSnap.docs.map((d) => d.data());
  const seResolved = seResolvedSnap.docs.map((d) => d.data());
  const unresolved = allUnresolvedSnap.docs.map((d) => d.data());
  const statusUpdates = statusUpdatesSnap.docs.map((d) => d.data());
  const rosters = rosterSnaps.map((s) => s.exists() ? s.data() : null);
  const rangeRosters = rangeRostersSnap?.docs.map((d) => d.data()) || [];

  // Activity counts
  const newIntakes = intakes.filter((i) => !i.reentry).length;
  const reentries = intakes.filter((i) => i.reentry === true).length;
  const exitHousingCounts = {};
  for (const e of exits) {
    const cat = e.housingAssessment || "other";
    exitHousingCounts[cat] = (exitHousingCounts[cat] || 0) + 1;
  }

  // Daily aggregates — same shape across all modes. mealsSum collapses
  // breakfast/lunch/dinner into one number per Daniel's spec. Per-day "not
  // signed in by 8pm" flags are daily/weekly only (monthly/yearly use a
  // total flag count instead — listing every day would be too noisy).
  const aggregated = useRosterRangeQuery ? rangeRosters : rosters;
  const daily = {
    presentSum: 0,
    mealsSum: 0,
    showerSum: 0,
    daysWithNotSignedIn: [],
    notSignedInBy8pmTotal: 0,
  };
  aggregated.forEach((r, i) => {
    if (!r) return;
    const t = r.totals || {};
    daily.presentSum += t.presentCount || 0;
    daily.mealsSum += (t.breakfastCount || 0) + (t.lunchCount || 0) + (t.dinnerCount || 0);
    daily.showerSum += t.showerCount || 0;
    daily.notSignedInBy8pmTotal += t.notSignedInBy8pmCount || 0;
    if ((kind === "weekly" || kind === "daily") && (t.notSignedInBy8pmCount || 0) > 0) {
      daily.daysWithNotSignedIn.push({
        date: rosterDates[i] || (r.date || null),
        count: t.notSignedInBy8pmCount,
      });
    }
  });

  // Documents and benefits gained this period — sourced from clientStatusUpdates.
  // Each update has category + updateType; we group and demographically slice.
  // Note: documents acquired BEFORE intake (i.e. client already had SSN when
  // they came in) are not "gains" — they're pre-existing. clientStatusUpdates
  // captures only newly-obtained items, which is the right semantics here.
  const cmap = clientMap();
  const docGains = new Map();      // updateType → [master,...]
  const benefitGains = new Map();
  for (const u of statusUpdates) {
    const cli = cmap.get(u.clientId);
    if (!cli) continue;
    if (u.category === "document") {
      if (!docGains.has(u.updateType)) docGains.set(u.updateType, []);
      docGains.get(u.updateType).push(cli);
    } else if (u.category === "benefit") {
      if (!benefitGains.has(u.updateType)) benefitGains.set(u.updateType, []);
      benefitGains.get(u.updateType).push(cli);
    }
  }
  const documentsGained = [...docGains.entries()].map(([type, clients]) => {
    const agg = emptyDemographicAgg();
    for (const c of clients) tallyDemographics(agg, c);
    return { type, count: clients.length, demographics: agg };
  }).sort((a, b) => b.count - a.count);
  const benefitsGained = [...benefitGains.entries()].map(([type, clients]) => {
    const agg = emptyDemographicAgg();
    for (const c of clients) tallyDemographics(agg, c);
    return { type, count: clients.length, demographics: agg };
  }).sort((a, b) => b.count - a.count);

  // Active-clients snapshot (current state)
  const active = cachedClients
    .filter((c) => c.data.status === "active")
    .map((c) => c.data);
  const total = active.length;

  const activeAgg = emptyDemographicAgg();
  for (const c of active) tallyDemographics(activeAgg, c);

  const ages = active.map((c) => ageOf(c)).filter((a) => a !== null);
  const avgAge = ages.length > 0
    ? Math.round(ages.reduce((sum, a) => sum + a, 0) / ages.length)
    : null;

  // Currently-held documents and currently-receiving benefits
  const activeDocuments = {};
  const activeBenefits = {};
  for (const c of active) {
    const docs = c.documents || {};
    for (const [k, v] of Object.entries(docs)) {
      if (v && v.obtained) activeDocuments[k] = (activeDocuments[k] || 0) + 1;
    }
    const bens = c.benefits || {};
    for (const [k, v] of Object.entries(bens)) {
      if (v && v.receiving) activeBenefits[k] = (activeBenefits[k] || 0) + 1;
    }
  }

  // Outstanding self-evals: clients with 3+ unresolved
  const counts = new Map();
  for (const u of unresolved) {
    const name = (u.clientName || "").trim();
    if (!name) continue;
    counts.set(name, (counts.get(name) || 0) + 1);
  }
  const flagged = [...counts.entries()]
    .filter(([, n]) => n >= 3)
    .sort((a, b) => b[1] - a[1])
    .map(([name, n]) => ({ name, count: n }));

  return {
    kind,
    day: opts.day || null,
    weekStart,
    month: opts.month || null,
    year: opts.year || null,
    range,
    activity: {
      intakeCount: intakes.length,
      newIntakes,
      reentries,
      exitCount: exits.length,
      exitHousingCounts,
      selfEvalsCreated: seCreated.length,
      selfEvalsResolved: seResolved.length,
      statusUpdateCount: statusUpdates.length,
    },
    daily,
    documentsGained,
    benefitsGained,
    active: {
      total,
      avgAge,
      demographics: activeAgg,
      activeDocuments,
      activeBenefits,
    },
    outstanding: {
      totalUnresolved: unresolved.length,
      flagged,
    },
  };
}

function renderReportView(r) {
  // True iff the mode renders a single roster day and its per-day flag list
  // (Daily and Weekly). False for Monthly and Yearly, which roll up.
  const isSingleDay = r.kind === "daily";
  const isWeekly = r.kind === "weekly";
  const isMonthly = r.kind === "monthly";
  const isShortSpan = isSingleDay || isWeekly;
  const monthLabel = isMonthly && r.month
    ? new Date(r.range.start).toLocaleDateString(undefined, { month: "long", year: "numeric" })
    : "";

  // Title
  let title;
  if (isSingleDay) {
    title = `Daily Report — ${fmtReportDate(r.range.start)}`;
  } else if (isWeekly) {
    const sun = new Date(r.range.end);
    sun.setDate(sun.getDate() - 1);
    title = `Weekly Report — ${fmtReportDate(r.range.start)} to ${fmtReportDate(sun)}`;
  } else if (isMonthly) {
    title = `Monthly Report — ${monthLabel}`;
  } else {
    title = `Yearly Report — ${r.year}`;
  }
  document.getElementById("report-title").textContent = title;

  // Daily-totals section: visible in all modes. Single-day modes (daily) show
  // guest-nights/meals/showers + the day's "not signed in by 8pm" flag.
  // Multi-day modes (weekly/monthly/yearly) sum across the range. Weekly +
  // daily list the days flagged; monthly/yearly show a total flag count.
  const dailySection = document.getElementById("report-daily-section");
  if (dailySection) dailySection.hidden = false;

  // Activity
  const exitBreakdown = Object.entries(r.activity.exitHousingCounts)
    .sort((a, b) => b[1] - a[1])
    .map(([k, v]) => `<li>${escapeHtml(HOUSING_LABELS[k] || k)}: ${v}</li>`)
    .join("");
  const activityHtml = [
    kv("Intakes", r.activity.intakeCount),
    kv("  New clients", r.activity.newIntakes),
    kv("  Re-entries", r.activity.reentries),
    kv("Exits", r.activity.exitCount),
    r.activity.exitCount > 0
      ? `<dt></dt><dd><ul class="breakdown">${exitBreakdown}</ul></dd>`
      : "",
    kv("Status updates logged", r.activity.statusUpdateCount),
    kv("Self-evals submitted", r.activity.selfEvalsCreated),
    kv("Self-evals resolved", r.activity.selfEvalsResolved),
  ].join("");
  document.getElementById("report-activity").innerHTML = activityHtml;

  // Daily totals
  if (r.daily) {
    const lines = [];
    if (isShortSpan) lines.push(kv(isSingleDay ? "Guest-nights" : "Total guest-nights", r.daily.presentSum));
    lines.push(kv(isSingleDay ? "Meals served" : "Total meals served", r.daily.mealsSum));
    if (isShortSpan) lines.push(kv("Showers", r.daily.showerSum));
    if (!isShortSpan && r.daily.notSignedInBy8pmTotal > 0) {
      lines.push(kv("Not signed in by 8pm — total events", r.daily.notSignedInBy8pmTotal));
    }
    document.getElementById("report-daily").innerHTML = lines.join("");

    const flagsEl = document.getElementById("report-daily-flags");
    if (isShortSpan) {
      flagsEl.hidden = false;
      if (r.daily.daysWithNotSignedIn.length === 0) {
        const subject = isSingleDay ? "today" : "this week";
        flagsEl.textContent = `All present clients signed in by 8pm ${subject}.`;
        flagsEl.classList.remove("error");
      } else {
        const list = r.daily.daysWithNotSignedIn
          .map((d) => `${fmtReportDate(new Date((d.date || "") + "T00:00:00"))} (${d.count})`)
          .join(" · ");
        const label = isSingleDay ? "Not signed in by 8pm" : "Days with someone not signed in by 8pm";
        flagsEl.textContent = `${label}: ${list}.`;
        flagsEl.classList.add("error");
      }
    } else {
      flagsEl.hidden = true;
    }
  }

  // Documents gained this period — expandable per-row demographic breakdown
  document.getElementById("report-documents").innerHTML =
    renderGainedSection(r.documentsGained, "No documents gained in this period.");
  // Benefits gained this period
  document.getElementById("report-benefits").innerHTML =
    renderGainedSection(r.benefitsGained, "No benefits gained in this period.");

  // Active clients snapshot — demographics + age ranges + currently held
  const dem = r.active.demographics;
  const raceList = Object.entries(dem.race)
    .sort((a, b) => b[1] - a[1])
    .map(([k, v]) => `<li>${escapeHtml(RACE_LABELS[k] || k)}: ${v}</li>`)
    .join("");
  const ageList = AGE_RANGE_BUCKETS
    .filter((b) => dem.ageRange[b] > 0)
    .map((b) => `<li>${escapeHtml(AGE_RANGE_LABELS[b])}: ${dem.ageRange[b]}</li>`)
    .join("");
  const maritalList = Object.entries(dem.marital)
    .sort((a, b) => b[1] - a[1])
    .map(([k, v]) => `<li>${escapeHtml(MARITAL_LABELS[k] || k || "Unspecified")}: ${v}</li>`)
    .join("");
  const activeHtml = [
    kv("Total active clients", r.active.total),
    raceList ? `<dt>Race / ethnicity</dt><dd><ul class="breakdown">${raceList}</ul></dd>` : "",
    kv("Hispanic / Latino — Yes", dem.hispanic.yes),
    kv("Hispanic / Latino — No", dem.hispanic.no),
    dem.hispanic.na ? kv("Hispanic / Latino — N/A", dem.hispanic.na) : "",
    ageList ? `<dt>Age range</dt><dd><ul class="breakdown">${ageList}</ul></dd>` : "",
    kv("Average age", r.active.avgAge !== null ? `${r.active.avgAge} years` : null),
    kv("Veterans", dem.veteran.yes),
    maritalList ? `<dt>Marital status</dt><dd><ul class="breakdown">${maritalList}</ul></dd>` : "",
    kv("Currently employed", dem.employed.yes),
  ].filter(Boolean).join("");
  document.getElementById("report-active").innerHTML = activeHtml;

  // Currently-held documents (active clients)
  document.getElementById("report-active-documents").innerHTML = renderActiveCountsList(
    r.active.activeDocuments, STATUS_UPDATE_TYPE_LABELS, "No documents currently on file.");
  // Currently-receiving benefits
  document.getElementById("report-active-benefits").innerHTML = renderActiveCountsList(
    r.active.activeBenefits, STATUS_UPDATE_TYPE_LABELS, "No benefits currently received.");

  // Outstanding self-evals
  const seEl = document.getElementById("report-self-evals");
  if (r.outstanding.flagged.length === 0) {
    seEl.innerHTML = `<p class="note">${r.outstanding.totalUnresolved} unresolved overall, none with 3+ flags.</p>`;
  } else {
    seEl.innerHTML = `
      <p class="note">Total unresolved: ${r.outstanding.totalUnresolved}. Clients with 3+ unresolved:</p>
      <ul class="breakdown">
        ${r.outstanding.flagged.map((f) => `<li><strong>${escapeHtml(f.name)}</strong>: ${f.count} unresolved</li>`).join("")}
      </ul>
    `;
  }
}

function renderGainedSection(gainedList, emptyMessage) {
  if (!gainedList.length) return `<p class="note">${escapeHtml(emptyMessage)}</p>`;
  return gainedList.map((g) => `
    <details class="gained-row">
      <summary>
        <strong>${escapeHtml(STATUS_UPDATE_TYPE_LABELS[g.type] || g.type)}</strong>
        <span class="gained-count">${g.count}</span>
      </summary>
      ${renderDemographicAgg(g.demographics)}
    </details>
  `).join("");
}

function renderActiveCountsList(counts, labels, emptyMessage) {
  const entries = Object.entries(counts).sort((a, b) => b[1] - a[1]);
  if (entries.length === 0) return `<p class="note">${escapeHtml(emptyMessage)}</p>`;
  return entries
    .map(([k, v]) => kv(labels[k] || k, v))
    .join("");
}

async function loadAndRenderReport(opts) {
  // opts: { kind: "daily", day }
  //     | { kind: "weekly", weekStart }
  //     | { kind: "monthly", month }   // month = YYYY-MM
  //     | { kind: "yearly", year }
  //     | { kind: "client", clientId }
  let range;
  if (opts.kind === "daily") range = dayRange(opts.day);
  else if (opts.kind === "weekly") range = weekRange(opts.weekStart);
  else if (opts.kind === "monthly") range = monthRange(opts.month);
  else if (opts.kind === "yearly") range = yearRange(opts.year);
  // Per-client report doesn't use a date range.

  reportMode = opts.kind;
  if (opts.kind === "daily") {
    reportDay = opts.day;
    const inp = document.getElementById("report-day");
    if (inp) inp.value = opts.day;
  } else if (opts.kind === "weekly") {
    reportWeekStart = opts.weekStart;
    const dateInput = document.getElementById("report-week");
    if (dateInput) dateInput.value = opts.weekStart;
  } else if (opts.kind === "monthly") {
    reportMonth = opts.month;
    const inp = document.getElementById("report-month");
    if (inp) inp.value = opts.month;
  } else if (opts.kind === "yearly") {
    reportYear = opts.year;
    const yearSel = document.getElementById("report-year");
    if (yearSel) yearSel.value = String(opts.year);
  } else if (opts.kind === "client") {
    reportClientId = opts.clientId;
  }
  const loadingEl = document.getElementById("report-loading");
  const standardBody = document.getElementById("weekly-report-body");
  const clientBody = document.getElementById("client-report-body");
  if (loadingEl) {
    loadingEl.hidden = false;
    loadingEl.textContent = "Loading…";
    loadingEl.classList.remove("error");
  }
  if (standardBody) standardBody.hidden = true;
  if (clientBody) clientBody.hidden = true;

  const auditId = opts.kind === "daily" ? opts.day
    : opts.kind === "weekly" ? opts.weekStart
    : opts.kind === "monthly" ? opts.month
    : opts.kind === "yearly" ? String(opts.year)
    : opts.kind === "client" ? (opts.clientId || "(none)")
    : "(unknown)";
  await logAccess(AUDIT_ACTIONS.VIEW, "report", auditId, { kind: opts.kind });

  try {
    if (opts.kind === "client") {
      await loadAndRenderClientReport(opts.clientId);
      if (loadingEl) loadingEl.hidden = true;
      if (clientBody) clientBody.hidden = false;
      return;
    }
    const r = await loadReport({
      kind: opts.kind, range,
      day: opts.day, weekStart: opts.weekStart, month: opts.month, year: opts.year,
    });
    renderReportView(r);
    if (loadingEl) loadingEl.hidden = true;
    if (standardBody) standardBody.hidden = false;
  } catch (err) {
    if (loadingEl) {
      loadingEl.textContent = `Could not load: ${err.message}`;
      loadingEl.classList.add("error");
    }
  }
}

function setReportMode(mode) {
  reportMode = mode;
  const modes = ["daily", "weekly", "monthly", "yearly", "client"];
  for (const m of modes) {
    const btn = document.getElementById(`report-mode-${m}`);
    if (btn) btn.classList.toggle("active", mode === m);
    const ctl = document.getElementById(`report-controls-${m}`);
    if (ctl) ctl.hidden = (mode !== m);
  }
}

function populateYearOptions() {
  const sel = document.getElementById("report-year");
  if (!sel || sel.options.length > 0) return;
  const current = new Date().getFullYear();
  // Show 2024..currentYear (GSO data starts ~2024); scrolls if more years
  for (let y = current + 1; y >= 2024; y--) {
    const opt = document.createElement("option");
    opt.value = String(y);
    opt.textContent = String(y);
    sel.appendChild(opt);
  }
  sel.value = String(current);
}

document.getElementById("report-mode-daily")?.addEventListener("click", () => {
  setReportMode("daily");
  loadAndRenderReport({ kind: "daily", day: reportDay || todayString() });
});
document.getElementById("report-mode-weekly")?.addEventListener("click", () => {
  setReportMode("weekly");
  loadAndRenderReport({ kind: "weekly", weekStart: reportWeekStart || mondayOf(new Date()) });
});
document.getElementById("report-mode-monthly")?.addEventListener("click", () => {
  setReportMode("monthly");
  loadAndRenderReport({ kind: "monthly", month: reportMonth || thisMonthString() });
});
document.getElementById("report-mode-yearly")?.addEventListener("click", () => {
  setReportMode("yearly");
  populateYearOptions();
  loadAndRenderReport({ kind: "yearly", year: reportYear || new Date().getFullYear() });
});
document.getElementById("report-mode-client")?.addEventListener("click", () => {
  setReportMode("client");
  ensureReportClientPicker();
  if (reportClientId) {
    loadAndRenderReport({ kind: "client", clientId: reportClientId });
  } else {
    const loadingEl = document.getElementById("report-loading");
    if (loadingEl) {
      loadingEl.hidden = false;
      loadingEl.textContent = "Pick a client to load their report.";
      loadingEl.classList.remove("error");
    }
    document.getElementById("weekly-report-body").hidden = true;
    document.getElementById("client-report-body").hidden = true;
  }
});

// Daily controls
document.getElementById("report-prev-day")?.addEventListener("click", () => {
  if (!reportDay) return;
  loadAndRenderReport({ kind: "daily", day: addDays(reportDay, -1) });
});
document.getElementById("report-next-day")?.addEventListener("click", () => {
  if (!reportDay) return;
  loadAndRenderReport({ kind: "daily", day: addDays(reportDay, 1) });
});
document.getElementById("report-today")?.addEventListener("click", () => {
  loadAndRenderReport({ kind: "daily", day: todayString() });
});
document.getElementById("report-day")?.addEventListener("change", () => {
  const v = document.getElementById("report-day").value;
  if (v && v !== reportDay) loadAndRenderReport({ kind: "daily", day: v });
});

// Weekly controls
document.getElementById("report-prev-week")?.addEventListener("click", () => {
  if (!reportWeekStart) return;
  loadAndRenderReport({ kind: "weekly", weekStart: addDays(reportWeekStart, -7) });
});
document.getElementById("report-next-week")?.addEventListener("click", () => {
  if (!reportWeekStart) return;
  loadAndRenderReport({ kind: "weekly", weekStart: addDays(reportWeekStart, 7) });
});
document.getElementById("report-this-week")?.addEventListener("click", () => {
  loadAndRenderReport({ kind: "weekly", weekStart: mondayOf(new Date()) });
});
document.getElementById("report-week")?.addEventListener("change", () => {
  const v = document.getElementById("report-week").value;
  if (!v) return;
  const monday = mondayOf(v);
  if (monday !== reportWeekStart) loadAndRenderReport({ kind: "weekly", weekStart: monday });
});

// Monthly controls
document.getElementById("report-prev-month")?.addEventListener("click", () => {
  if (!reportMonth) return;
  loadAndRenderReport({ kind: "monthly", month: addMonths(reportMonth, -1) });
});
document.getElementById("report-next-month")?.addEventListener("click", () => {
  if (!reportMonth) return;
  loadAndRenderReport({ kind: "monthly", month: addMonths(reportMonth, 1) });
});
document.getElementById("report-this-month")?.addEventListener("click", () => {
  loadAndRenderReport({ kind: "monthly", month: thisMonthString() });
});
document.getElementById("report-month")?.addEventListener("change", () => {
  const v = document.getElementById("report-month").value;
  if (v && v !== reportMonth) loadAndRenderReport({ kind: "monthly", month: v });
});

document.getElementById("report-prev-year")?.addEventListener("click", () => {
  if (!reportYear) return;
  loadAndRenderReport({ kind: "yearly", year: reportYear - 1 });
});
document.getElementById("report-next-year")?.addEventListener("click", () => {
  if (!reportYear) return;
  loadAndRenderReport({ kind: "yearly", year: reportYear + 1 });
});
document.getElementById("report-this-year")?.addEventListener("click", () => {
  loadAndRenderReport({ kind: "yearly", year: new Date().getFullYear() });
});
document.getElementById("report-year")?.addEventListener("change", () => {
  const v = parseInt(document.getElementById("report-year").value, 10);
  if (!isNaN(v)) loadAndRenderReport({ kind: "yearly", year: v });
});

document.getElementById("report-print")?.addEventListener("click", () => {
  // Expand all <details> in the active report sections so the print copy
  // shows every demographic breakdown (weekly/yearly modes) or every
  // collapsed history block (per-client mode) without staff manually
  // clicking each row.
  document.querySelectorAll("#report-documents details, #report-benefits details, #client-report-body details")
    .forEach((d) => d.open = true);
  window.print();
});

function tryInitReports() {
  if (reportInitialized) return;
  if (!document.getElementById("report-week")) return;
  reportInitialized = true;
  populateYearOptions();
  loadAndRenderReport({ kind: "weekly", weekStart: mondayOf(new Date()) });
}

// ----- Per-client query report -----
//
// Pulls everything for a single client from the activity history and renders
// a self-contained printable. Same `#report-print` button works because we
// only show one body at a time (#weekly-report-body or #client-report-body).

function ensureReportClientPicker() {
  const root = document.getElementById("report-client-picker");
  if (!root || reportClientPicker) return;
  reportClientPicker = createClientPicker({
    root,
    onChange: (sel) => {
      if (!sel) { reportClientId = null; return; }
      reportClientId = sel.clientId;
      loadAndRenderReport({ kind: "client", clientId: sel.clientId });
    },
  });
}

async function loadAndRenderClientReport(cid) {
  const cli = cachedClients.find((c) => c.id === cid);
  if (!cli) throw new Error(`Client ${cid} not in cache yet`);
  const master = cli.data;

  // Parallel fetch — all per-client collections by `where("clientId", "==", cid)`.
  // The ones with composite indexes use orderBy; the rest sort client-side.
  const [
    intakesSnap, exitsSnap, statusUpdatesSnap,
    drugTestsSnap, medicationsSnap, selfEvalsSnap,
    checkInOutsSnap, mealsSnap, showersSnap,
    schedulesSnap,
    scannedDocsSnap, phiRecordsSnap, odh206Snap, consentsSnap,
  ] = await Promise.all([
    getDocs(query(collection(db, "intakes"), where("clientId", "==", cid), orderBy("intakeDate", "desc"))),
    getDocs(query(collection(db, "exits"), where("clientId", "==", cid), orderBy("exitDate", "desc"))),
    getDocs(query(collection(db, "clientStatusUpdates"), where("clientId", "==", cid), orderBy("occurredOn", "desc"))),
    getDocs(query(collection(db, "drugTests"), where("clientId", "==", cid))),
    getDocs(query(collection(db, "medications"), where("clientId", "==", cid))),
    getDocs(query(collection(db, "selfEvaluations"), where("clientId", "==", cid))),
    getDocs(query(collection(db, "checkInOuts"), where("clientId", "==", cid), orderBy("eventTime", "desc"), limit(100))),
    getDocs(query(collection(db, "mealLog"), where("clientId", "==", cid), orderBy("eventTime", "desc"), limit(100))),
    getDocs(query(collection(db, "showerLog"), where("clientId", "==", cid), orderBy("eventTime", "desc"), limit(100))),
    getDocs(query(collection(db, "clientWeeklySchedule"), where("clientId", "==", cid))),
    getDocs(collection(db, "clients", cid, "scannedDocs")),
    getDocs(collection(db, "clients", cid, "phiRecords")),
    getDocs(collection(db, "clients", cid, "odh206")),
    getDocs(collection(db, "clients", cid, "consents")),
  ]);

  const intakes = intakesSnap.docs.map((d) => ({ id: d.id, data: d.data() }));
  const exits = exitsSnap.docs.map((d) => ({ id: d.id, data: d.data() }));
  const statusUpdates = statusUpdatesSnap.docs.map((d) => ({ id: d.id, data: d.data() }));
  const drugTests = drugTestsSnap.docs.map((d) => ({ id: d.id, data: d.data() }))
    .sort((a, b) => tsMs(b.data.testDate) - tsMs(a.data.testDate));
  const medications = medicationsSnap.docs.map((d) => ({ id: d.id, data: d.data() }))
    .sort((a, b) => tsMs(b.data.startDate) - tsMs(a.data.startDate));
  const selfEvals = selfEvalsSnap.docs.map((d) => ({ id: d.id, data: d.data() }))
    .sort((a, b) => tsMs(b.data.dateGiven || b.data.createdAt) - tsMs(a.data.dateGiven || a.data.createdAt));
  const checkInOuts = checkInOutsSnap.docs.map((d) => d.data());
  const meals = mealsSnap.docs.map((d) => d.data());
  const showers = showersSnap.docs.map((d) => d.data());
  const schedules = schedulesSnap.docs.map((d) => ({ id: d.id, data: d.data() }))
    .sort((a, b) => (b.data.weekStart || "").localeCompare(a.data.weekStart || ""));
  const scannedDocs = scannedDocsSnap.docs.map((d) => ({ id: d.id, data: d.data() }));
  const phiRecords = phiRecordsSnap.docs.map((d) => ({ id: d.id, data: d.data() }));
  const odh206 = odh206Snap.docs.map((d) => ({ id: d.id, data: d.data() }));
  const consents = consentsSnap.docs.map((d) => ({ id: d.id, data: d.data() }));

  document.getElementById("report-title").textContent =
    `Client Report — ${clientDisplayName(master)} (${cid})`;

  const body = document.getElementById("client-report-body");
  body.innerHTML = renderClientReportHtml({
    cid, master,
    intakes, exits, statusUpdates,
    drugTests, medications, selfEvals,
    checkInOuts, meals, showers, schedules,
    scannedDocs, phiRecords, odh206, consents,
  });
}

function tsMs(ts) {
  if (!ts) return 0;
  if (typeof ts.toMillis === "function") return ts.toMillis();
  if (typeof ts === "number") return ts;
  return 0;
}

function renderClientReportHtml(d) {
  const { cid, master,
    intakes, exits, statusUpdates,
    drugTests, medications, selfEvals,
    checkInOuts, meals, showers, schedules,
    scannedDocs, phiRecords, odh206, consents } = d;

  // Header
  const age = ageOf(master);
  const headerKvs = [
    kv("Client ID", `<code>${escapeHtml(cid)}</code>`, { raw: true }),
    kv("Name", clientDisplayName(master)),
    kv("DOB", fmtDate(master.dob) || "—"),
    age !== null ? kv("Age", `${age}`) : "",
    kv("Status", master.status === "exited" ? "Exited" : "Active"),
    master.bedAssignment?.bedId ? kv("Bed", `${escapeHtml(master.bedAssignment.dormLabel || "")} · ${escapeHtml(master.bedAssignment.bedId)}`, { raw: true }) : "",
    master.level ? kv("Program level", levelDisplay(master)) : "",
    master.leadershipRole ? kv("Leadership", LEADERSHIP_ROLES[master.leadershipRole] || master.leadershipRole) : "",
    kv("Currently employed", master.currentEmployment ? "Yes" : "No"),
    master.contact?.phone ? kv("Phone", master.contact.phone) : "",
    master.contact?.email ? kv("Email", master.contact.email) : "",
  ].filter(Boolean).join("");

  // Currently held documents / benefits / milestones (from master mirror maps)
  const docsHtml = renderActiveCountsList(
    countOnFile(master.documents), STATUS_UPDATE_TYPE_LABELS, "No documents currently on file.");
  const bensHtml = renderActiveCountsList(
    countOnFile(master.benefits, "receiving"), STATUS_UPDATE_TYPE_LABELS, "No benefits currently received.");
  const milesHtml = renderActiveCountsList(
    countOnFile(master.milestones), STATUS_UPDATE_TYPE_LABELS, "No milestones recorded.");

  // Intakes
  const intakesHtml = intakes.length
    ? intakes.map(({ id, data }) => `
        <li>${escapeHtml(fmtDate(data.intakeDate) || "(no date)")} ${data.reentry ? "<span class=\"muted\">(re-entry)</span>" : "<span class=\"muted\">(new)</span>"} · staff ${escapeHtml(data.staffEmail || "—")} · <code>${escapeHtml(id)}</code></li>`).join("")
    : `<li class="note">No intake records.</li>`;

  // Exits
  const exitsHtml = exits.length
    ? exits.map(({ id, data }) => `
        <li>${escapeHtml(fmtDate(data.exitDate) || "(no date)")} → ${escapeHtml(HOUSING_LABELS[data.housingAssessment] || data.housingAssessment || "—")} · <code>${escapeHtml(id)}</code></li>`).join("")
    : `<li class="note">No exit records.</li>`;

  // Status updates
  const updatesHtml = statusUpdates.length
    ? statusUpdates.map(({ id, data }) => `
        <li>${escapeHtml(fmtDate(data.occurredOn) || "(no date)")} · <strong>${escapeHtml(STATUS_UPDATE_TYPE_LABELS[data.updateType] || data.updateType)}</strong> <span class="muted">(${escapeHtml(data.category || statusUpdateCategory(data.updateType))})</span>${data.notes ? ` — ${escapeHtml(data.notes)}` : ""}</li>`).join("")
    : `<li class="note">No status updates.</li>`;

  // Drug tests
  const drugTestsHtml = drugTests.length
    ? drugTests.map(({ id, data }) => {
        const positives = Object.entries(data.panelResults || {})
          .filter(([, v]) => v === "positive" || v === "faint")
          .map(([k]) => k);
        return `<li>${escapeHtml(fmtDate(data.testDate) || "(no date)")} · ${positives.length ? `<span class="error">${positives.length} non-negative: ${escapeHtml(positives.join(", "))}</span>` : "all negative"} · observer ${escapeHtml(data.observerName || "—")}</li>`;
      }).join("")
    : `<li class="note">No drug tests.</li>`;

  // Medications (active vs historical)
  const activeMeds = medications.filter((m) => !m.data.endDate);
  const pastMeds = medications.filter((m) => m.data.endDate);
  const medsActiveHtml = activeMeds.length
    ? activeMeds.map(({ data }) => `<li>${escapeHtml(data.medicationName || "(med)")} — ${escapeHtml(data.dosage || "")} ${escapeHtml(data.frequency || "")}${data.reasonForMedication ? ` · for ${escapeHtml(data.reasonForMedication)}` : ""}</li>`).join("")
    : `<li class="note">No active medications.</li>`;
  const medsPastHtml = pastMeds.length
    ? `<details><summary>Discontinued (${pastMeds.length})</summary><ul>${
        pastMeds.map(({ data }) => `<li>${escapeHtml(data.medicationName || "(med)")} — ${escapeHtml(fmtDate(data.startDate) || "")} → ${escapeHtml(fmtDate(data.endDate) || "")}</li>`).join("")
      }</ul></details>`
    : "";

  // Self-evaluations
  const selfEvalsHtml = selfEvals.length
    ? selfEvals.map(({ id, data }) => `
        <li>${escapeHtml(fmtDate(data.dateGiven) || fmtDate(data.createdAt) || "(no date)")} · ${escapeHtml(data.reason || "(no reason)")} · ${data.dateResolved ? `<span class="muted">resolved ${escapeHtml(fmtDate(data.dateResolved))}</span>` : `<span class="error">unresolved</span>`}</li>`).join("")
    : `<li class="note">No self-evaluations on record.</li>`;

  // Schedules (chronological recent first)
  const schedulesHtml = schedules.length
    ? schedules.slice(0, 20).map(({ id, data }) => `
        <li>Week of ${escapeHtml(data.weekStart || "—")} · ${(data.events || []).length} event${(data.events || []).length === 1 ? "" : "s"} · last updated ${escapeHtml(fmtDate(data.updatedAt) || "—")}</li>`).join("")
    : `<li class="note">No weekly schedules on record.</li>`;

  // Check-in/out + meals + showers — last 3 weeks (TTL-bounded)
  const dailyActivityHtml = `
    <li>${checkInOuts.length} check-in/out events in last 3 weeks (TTL window)</li>
    <li>${meals.length} meal logs in last 3 weeks</li>
    <li>${showers.length} shower logs in last 3 weeks</li>
  `;

  // Documents we hold (scanned docs / PHI / authorizations / consents)
  const documentsHeldHtml = `
    <li>${scannedDocs.length} scanned identity/insurance/etc document${scannedDocs.length === 1 ? "" : "s"}</li>
    <li>${phiRecords.length} PHI record${phiRecords.length === 1 ? "" : "s"} (received under ODH 206)</li>
    <li>${odh206.length} ODH 206 authorization${odh206.length === 1 ? "" : "s"}</li>
    <li>${consents.length} consent record${consents.length === 1 ? "" : "s"}</li>
  `;

  return `
    <fieldset class="section report-section">
      <legend>Client</legend>
      <dl class="kv-grid">${headerKvs}</dl>
    </fieldset>

    <fieldset class="section report-section">
      <legend>Currently held — documents</legend>
      <dl class="kv-grid">${docsHtml}</dl>
    </fieldset>
    <fieldset class="section report-section">
      <legend>Currently held — benefits</legend>
      <dl class="kv-grid">${bensHtml}</dl>
    </fieldset>
    <fieldset class="section report-section">
      <legend>Milestones recorded</legend>
      <dl class="kv-grid">${milesHtml}</dl>
    </fieldset>

    <fieldset class="section report-section">
      <legend>Intakes (${intakes.length})</legend>
      <ul>${intakesHtml}</ul>
    </fieldset>
    <fieldset class="section report-section">
      <legend>Exits (${exits.length})</legend>
      <ul>${exitsHtml}</ul>
    </fieldset>

    <fieldset class="section report-section">
      <legend>Status updates (${statusUpdates.length})</legend>
      <ul>${updatesHtml}</ul>
    </fieldset>

    <fieldset class="section report-section">
      <legend>Drug tests (${drugTests.length})</legend>
      <ul>${drugTestsHtml}</ul>
    </fieldset>

    <fieldset class="section report-section">
      <legend>Medications</legend>
      <p class="subsection-header">Active</p>
      <ul>${medsActiveHtml}</ul>
      ${medsPastHtml}
    </fieldset>

    <fieldset class="section report-section">
      <legend>Self-evaluations (${selfEvals.length})</legend>
      <ul>${selfEvalsHtml}</ul>
    </fieldset>

    <fieldset class="section report-section">
      <legend>Weekly schedules (${schedules.length})</legend>
      <ul>${schedulesHtml}</ul>
    </fieldset>

    <fieldset class="section report-section">
      <legend>Daily activity (last 3 weeks)</legend>
      <ul>${dailyActivityHtml}</ul>
    </fieldset>

    <fieldset class="section report-section">
      <legend>Documents on file</legend>
      <ul>${documentsHeldHtml}</ul>
    </fieldset>
  `;
}

// Convert a master mirror map ({key: {obtained|receiving: true, ...}}) into
// a simple key→1 map so renderActiveCountsList can render it as a checklist
// for a single client. Different categories use different truthiness keys:
//   documents.{type}.obtained, benefits.{type}.receiving, milestones.{type} (boolean or obtained).
function countOnFile(map, truthyKey = "obtained") {
  if (!map || typeof map !== "object") return {};
  const out = {};
  for (const [k, v] of Object.entries(map)) {
    if (!v) continue;
    if (v === true) { out[k] = 1; continue; }
    if (typeof v === "object" && (v[truthyKey] || v.obtained || v.receiving)) out[k] = 1;
  }
  return out;
}

// ============================================================
// Bed assignment slice
// ============================================================
//
// Source of truth: beds/{bedId} (24 docs, seeded once via admin/seed-beds.mjs).
// Mirror: clients/{cid}.bedAssignment = { bedId, dorm, dormLabel, assignedAt,
// assignedBy } | null.
//
// Assign / reassign / unassign all run in a Firestore transaction so two staff
// can't double-book a bed. The exit flow's transaction also frees the bed in
// the same atomic write that flips master.status to 'exited'.

const DORMS = {
  alpha:    { label: "Alpha Dorm",    beds: ["A-1", "A-2", "A-3", "A-4", "A-5"] },
  bravo:    { label: "Bravo Dorm",    beds: ["B-1", "B-2", "B-3", "B-4", "B-5", "B-6", "B-7"] },
  charlie:  { label: "Charlie Dorm",  beds: ["C-1", "C-2", "C-3", "C-4", "C-5", "C-6", "C-7", "C-8", "C-9"] },
  veterans: { label: "Veterans Dorm", beds: ["V-1", "V-2", "V-3"] },
};
const DORM_KEY_BY_BED = (() => {
  const m = {};
  for (const [k, d] of Object.entries(DORMS)) for (const b of d.beds) m[b] = k;
  return m;
})();

let cachedBeds = new Map(); // bedId -> bed doc data
let unsubscribeBeds = null;

function startBedsListener() {
  if (unsubscribeBeds) return;
  const q = query(collection(db, "beds"));
  unsubscribeBeds = onSnapshot(q, (snap) => {
    cachedBeds = new Map();
    for (const d of snap.docs) cachedBeds.set(d.id, d.data());
    renderBedsTab();
    // If the client detail panel is open, refresh its bed fieldset so the
    // detail page reflects assignment changes made from the Beds tab.
    if (currentDetailClientId) {
      const c = cachedClients.find((c) => c.id === currentDetailClientId);
      if (c) renderClientBedAssignment(currentDetailClientId, c.data);
    }
  }, (err) => {
    const status = document.getElementById("beds-status");
    if (status) {
      status.textContent = `Could not load beds: ${err.message}`;
      status.classList.add("error");
    }
  });
}

function stopBedsListener() {
  if (unsubscribeBeds) { unsubscribeBeds(); unsubscribeBeds = null; }
  cachedBeds = new Map();
}

function renderBedsTab() {
  const map = document.getElementById("beds-map");
  const status = document.getElementById("beds-status");
  const occ = document.getElementById("beds-occupancy");
  if (!map) return;

  if (cachedBeds.size === 0) {
    if (status) {
      status.hidden = false;
      status.textContent = "No beds yet — run admin/seed-beds.mjs to seed the 24-bed catalog.";
    }
    map.innerHTML = "";
    if (occ) occ.textContent = "0 / 0";
    return;
  }
  if (status) status.hidden = true;

  let totalOccupied = 0;
  let totalBeds = 0;
  let html = "";
  for (const [dormKey, dorm] of Object.entries(DORMS)) {
    let dormOccupied = 0;
    const cellsHtml = dorm.beds.map((bedId) => {
      const bed = cachedBeds.get(bedId);
      const occupant = bed?.occupiedBy ? bed.occupiedByName || bed.occupiedBy : null;
      if (occupant) dormOccupied++;
      const cls = occupant ? "occupied" : "empty";
      const occLine = occupant
        ? `<span class="bed-occupant">${escapeHtml(occupant)}</span>`
        : `<span class="bed-occupant empty-label">Empty</span>`;
      return `
        <div class="bed-cell ${cls}" data-bed-id="${escapeHtml(bedId)}">
          <span class="bed-id">${escapeHtml(bedId)}</span>
          ${occLine}
        </div>
      `;
    }).join("");
    totalOccupied += dormOccupied;
    totalBeds += dorm.beds.length;
    html += `
      <div class="dorm-section">
        <h3>${escapeHtml(dorm.label)} <span class="dorm-occupancy">${dormOccupied} / ${dorm.beds.length} occupied</span></h3>
        <div class="bed-grid">${cellsHtml}</div>
      </div>
    `;
  }
  map.innerHTML = html;
  if (occ) occ.textContent = `${totalOccupied} / ${totalBeds} occupied`;
}

// Click on a bed cell in the Beds tab → open the modal targeting that bed.
document.getElementById("beds-map")?.addEventListener("click", (e) => {
  const cell = e.target.closest(".bed-cell");
  if (!cell) return;
  const bedId = cell.dataset.bedId;
  if (!bedId) return;
  openBedAssignModal({ bedId });
});

// ----- Client detail bed fieldset -----

function renderClientBedAssignment(cid, master) {
  const el = document.getElementById("client-bed-assignment");
  if (!el) return;
  const ba = master?.bedAssignment;
  if (!ba || !ba.bedId) {
    el.innerHTML = `
      <span class="bed-current unassigned">No bed assigned</span>
      <button type="button" class="bed-assign-from-client" data-cid="${escapeHtml(cid)}">Assign a bed</button>
    `;
  } else {
    const dormLabel = DORMS[ba.dorm]?.label || ba.dormLabel || ba.dorm || "";
    const since = fmtDate(ba.assignedAt) || "";
    el.innerHTML = `
      <span class="bed-current">
        ${escapeHtml(dormLabel)} <span class="bed-tag">${escapeHtml(ba.bedId)}</span>
        ${since ? `<span class="muted">since ${escapeHtml(since)}</span>` : ""}
      </span>
      <button type="button" class="ghost bed-assign-from-client" data-cid="${escapeHtml(cid)}">Change bed</button>
      <button type="button" class="ghost bed-unassign-from-client" data-cid="${escapeHtml(cid)}">Unassign</button>
    `;
  }
}

document.getElementById("client-detail-body")?.addEventListener("click", async (e) => {
  // Scanned-documents view + delete buttons live inside this body. Handle
  // those before the bed delegation to keep both wired off the same click.
  const viewDocBtn = e.target.closest('[data-action="view-doc"]');
  if (viewDocBtn) {
    viewScannedDocFile(
      viewDocBtn.dataset.cid,
      viewDocBtn.dataset.docId,
      viewDocBtn.dataset.side,
      viewDocBtn.dataset.docType,
    );
    return;
  }
  const delDocBtn = e.target.closest('[data-action="delete-doc"]');
  if (delDocBtn) {
    const cid = delDocBtn.dataset.cid;
    const docId = delDocBtn.dataset.docId;
    if (!cid || !docId) return;
    if (!confirm("Delete this scanned document? The files are removed from storage too.")) return;
    delDocBtn.disabled = true;
    try {
      const dref = doc(db, "clients", cid, "scannedDocs", docId);
      const dsnap = await getDoc(dref);
      if (dsnap.exists()) {
        const data = dsnap.data();
        // Delete storage objects best-effort; missing files don't block
        // the Firestore delete.
        for (const path of [data.frontPath, data.backPath]) {
          if (!path) continue;
          try { await deleteObject(storageRef(storage, path)); } catch {}
        }
        await deleteDoc(dref);
        await logAccess(AUDIT_ACTIONS.DELETE, "scannedDoc", docId, {
          clientId: cid, docType: data.type || "", surface: "clients-detail",
        });
      }
      await loadClientScannedDocs(cid);
    } catch (err) {
      alert("Delete failed: " + err.message);
      delDocBtn.disabled = false;
    }
    return;
  }
  const viewPhiBtn = e.target.closest('[data-action="view-phi"]');
  if (viewPhiBtn) {
    viewPhiRecordFile(viewPhiBtn.dataset.cid, viewPhiBtn.dataset.recId);
    return;
  }
  const delPhiBtn = e.target.closest('[data-action="delete-phi"]');
  if (delPhiBtn) {
    deletePhiRecord(delPhiBtn.dataset.cid, delPhiBtn.dataset.recId, delPhiBtn);
    return;
  }
  const assignBtn = e.target.closest(".bed-assign-from-client");
  const unassignBtn = e.target.closest(".bed-unassign-from-client");
  if (assignBtn) {
    openBedAssignModal({ clientId: assignBtn.dataset.cid });
    return;
  }
  if (unassignBtn) {
    const cid = unassignBtn.dataset.cid;
    if (!cid) return;
    if (!confirm("Unassign this client's bed?")) return;
    unassignBtn.disabled = true;
    try {
      await unassignBedForClient(cid);
    } catch (err) {
      alert("Could not unassign bed: " + err.message);
    } finally {
      unassignBtn.disabled = false;
    }
  }
});

// ----- Modal: pick a bed -----
//
// Two entry modes:
//   - { bedId }       → user clicked a specific bed in the Beds tab; we need
//                       to pick (or change) the client occupying it.
//   - { clientId }    → user clicked Assign/Change on a client detail; we need
//                       to pick which bed to put them in.

let bedModalState = null;

function openBedAssignModal(opts) {
  const modal = document.getElementById("bed-assign-modal");
  const title = document.getElementById("bed-assign-modal-title");
  const body = document.getElementById("bed-assign-modal-body");
  const saveBtn = document.getElementById("bed-assign-modal-save");
  const cancelBtn = document.getElementById("bed-assign-modal-cancel");
  const unassignBtn = document.getElementById("bed-assign-modal-unassign");
  const backdrop = document.getElementById("bed-assign-modal-backdrop");
  if (!modal) return;

  bedModalState = {
    mode: opts.clientId ? "for-client" : "for-bed",
    clientId: opts.clientId || null,
    bedId: opts.bedId || null,
    selectedBedId: null,
    selectedClientId: opts.clientId || null,
  };

  if (bedModalState.mode === "for-bed") {
    const existingBed = cachedBeds.get(bedModalState.bedId);
    const occupantId = existingBed?.occupiedBy || null;
    bedModalState.selectedClientId = occupantId;
    title.textContent = `Assign bed ${bedModalState.bedId}`;
    body.innerHTML = renderBedModalForBed(bedModalState.bedId, existingBed);
    saveBtn.textContent = occupantId ? "Reassign bed" : "Assign";
    unassignBtn.hidden = !occupantId;
  } else {
    const client = cachedClients.find((c) => c.id === bedModalState.clientId);
    const clientName = client ? clientDisplayName(client.data) : bedModalState.clientId;
    bedModalState.selectedBedId = client?.data?.bedAssignment?.bedId || null;
    title.textContent = `Pick a bed for ${clientName}`;
    body.innerHTML = renderBedModalForClient(bedModalState.clientId, bedModalState.selectedBedId);
    saveBtn.textContent = bedModalState.selectedBedId ? "Save" : "Assign";
    unassignBtn.hidden = !client?.data?.bedAssignment?.bedId;
  }
  modal.hidden = false;

  const cleanup = () => {
    modal.hidden = true;
    saveBtn.removeEventListener("click", onSave);
    cancelBtn.removeEventListener("click", onCancel);
    unassignBtn.removeEventListener("click", onUnassign);
    backdrop?.removeEventListener("click", onCancel);
    body.removeEventListener("click", onBodyClick);
    document.removeEventListener("keydown", onKey);
    bedModalState = null;
  };
  const onCancel = () => cleanup();
  const onKey = (e) => { if (e.key === "Escape") cleanup(); };
  const onBodyClick = (e) => {
    if (bedModalState.mode === "for-bed") {
      const row = e.target.closest("[data-modal-client-id]");
      if (row) {
        bedModalState.selectedClientId = row.dataset.modalClientId || null;
        body.querySelectorAll("[data-modal-client-id]").forEach((el) =>
          el.classList.toggle("selected", el === row));
      }
    } else {
      const cell = e.target.closest(".bed-cell:not(.disabled)");
      if (cell) {
        bedModalState.selectedBedId = cell.dataset.bedId;
        body.querySelectorAll(".bed-cell").forEach((el) =>
          el.classList.toggle("selected", el === cell));
      }
    }
  };
  const onSave = async () => {
    saveBtn.disabled = true;
    try {
      if (bedModalState.mode === "for-bed") {
        if (!bedModalState.selectedClientId) throw new Error("Pick a client.");
        await assignBed(bedModalState.selectedClientId, bedModalState.bedId);
      } else {
        if (!bedModalState.selectedBedId) throw new Error("Pick a bed.");
        await assignBed(bedModalState.clientId, bedModalState.selectedBedId);
      }
      cleanup();
    } catch (err) {
      alert("Could not save: " + err.message);
      saveBtn.disabled = false;
    }
  };
  const onUnassign = async () => {
    unassignBtn.disabled = true;
    try {
      if (bedModalState.mode === "for-bed") {
        const existingBed = cachedBeds.get(bedModalState.bedId);
        if (existingBed?.occupiedBy) {
          await unassignBedForClient(existingBed.occupiedBy);
        }
      } else {
        await unassignBedForClient(bedModalState.clientId);
      }
      cleanup();
    } catch (err) {
      alert("Could not unassign: " + err.message);
      unassignBtn.disabled = false;
    }
  };
  saveBtn.disabled = false;
  unassignBtn.disabled = false;
  saveBtn.addEventListener("click", onSave);
  cancelBtn.addEventListener("click", onCancel);
  unassignBtn.addEventListener("click", onUnassign);
  backdrop?.addEventListener("click", onCancel);
  body.addEventListener("click", onBodyClick);
  document.addEventListener("keydown", onKey);
}

// Modal body when picking a CLIENT for a known bed.
// Shows: list of active clients (those without a bed first, then those already in another bed).
function renderBedModalForBed(bedId, existingBed) {
  const occupantId = existingBed?.occupiedBy || null;
  const active = cachedClients
    .filter((c) => c.data.status === "active")
    .map((c) => ({
      id: c.id,
      name: clientDisplayName(c.data),
      currentBed: c.data.bedAssignment?.bedId || null,
    }))
    .sort((a, b) => {
      // unassigned first, then by name
      const aHas = a.currentBed ? 1 : 0;
      const bHas = b.currentBed ? 1 : 0;
      if (aHas !== bHas) return aHas - bHas;
      return a.name.localeCompare(b.name);
    });

  const head = occupantId
    ? `<p class="note">Currently occupied by <strong>${escapeHtml(existingBed.occupiedByName || occupantId)}</strong>. Pick a different client below to reassign, or click Unassign bed.</p>`
    : `<p class="note">Pick which active client should occupy ${escapeHtml(bedId)}.</p>`;

  if (active.length === 0) {
    return head + `<p class="note">No active clients.</p>`;
  }

  const rows = active.map((c) => {
    const sel = c.id === occupantId ? "selected" : "";
    const bedTag = c.currentBed
      ? `<span class="bed-tag" style="margin-left:0.4rem;">currently ${escapeHtml(c.currentBed)}</span>`
      : "";
    return `
      <div class="bed-cell ${sel}" data-modal-client-id="${escapeHtml(c.id)}" style="cursor:pointer;">
        <span class="bed-id">${escapeHtml(c.name)}</span>
        <span class="bed-occupant"><code>${escapeHtml(c.id)}</code>${bedTag}</span>
      </div>
    `;
  }).join("");

  return `
    <div class="bed-modal-section">
      ${head}
      <div class="bed-grid" style="grid-template-columns: repeat(auto-fill, minmax(200px, 1fr));">${rows}</div>
    </div>
  `;
}

// Modal body when picking a BED for a known client.
// Shows the dorm map; occupied beds are disabled (except the client's current bed).
function renderBedModalForClient(clientId, currentBedId) {
  let html = "";
  for (const [dormKey, dorm] of Object.entries(DORMS)) {
    const cellsHtml = dorm.beds.map((bedId) => {
      const bed = cachedBeds.get(bedId);
      const occupiedByOther = bed?.occupiedBy && bed.occupiedBy !== clientId;
      const isCurrent = bedId === currentBedId;
      const occupant = bed?.occupiedBy
        ? (isCurrent ? "You — current bed" : (bed.occupiedByName || bed.occupiedBy))
        : "Empty";
      const baseCls = bed?.occupiedBy ? "occupied" : "empty";
      const stateCls = [
        baseCls,
        occupiedByOther ? "disabled" : "",
        isCurrent ? "selected" : "",
      ].join(" ").trim();
      const dataAttr = occupiedByOther ? "" : `data-bed-id="${escapeHtml(bedId)}"`;
      return `
        <div class="bed-cell ${stateCls}" ${dataAttr}>
          <span class="bed-id">${escapeHtml(bedId)}</span>
          <span class="bed-occupant ${bed?.occupiedBy ? "" : "empty-label"}">${escapeHtml(occupant)}</span>
        </div>
      `;
    }).join("");
    html += `
      <div class="bed-modal-section">
        <h4>${escapeHtml(dorm.label)}</h4>
        <div class="bed-grid">${cellsHtml}</div>
      </div>
    `;
  }
  return html;
}

// ----- Transactional bed write paths -----

// Assign clientId to bedId. If client already has a different bed, free that
// bed in the same transaction. If bedId is occupied by a different client,
// reject (caller should confirm-then-call this with the bed already cleared,
// or pick a different bed).
async function assignBed(clientId, bedId) {
  if (!clientId || !bedId) throw new Error("Need both client and bed.");
  if (!DORM_KEY_BY_BED[bedId]) throw new Error(`Unknown bed: ${bedId}`);
  const dormKey = DORM_KEY_BY_BED[bedId];
  const dormLabel = DORMS[dormKey].label;

  const clientRef = doc(db, "clients", clientId);
  const newBedRef = doc(db, "beds", bedId);

  const result = await runTransaction(db, async (txn) => {
    const clientSnap = await txn.get(clientRef);
    if (!clientSnap.exists()) throw new Error(`Client ${clientId} not found.`);
    const clientData = clientSnap.data();
    const newBedSnap = await txn.get(newBedRef);
    if (!newBedSnap.exists()) throw new Error(`Bed ${bedId} not in catalog. Run seed-beds.mjs.`);
    const newBed = newBedSnap.data();

    // If the client already has a different bed, free it.
    const oldBedId = clientData.bedAssignment?.bedId;
    let freedBedId = null;
    if (oldBedId && oldBedId !== bedId) {
      const oldBedRef = doc(db, "beds", oldBedId);
      const oldBedSnap = await txn.get(oldBedRef);
      if (oldBedSnap.exists() && oldBedSnap.data().occupiedBy === clientId) {
        txn.update(oldBedRef, {
          occupiedBy: null,
          occupiedByName: null,
          occupiedSince: null,
          assignedBy: null,
          updatedAt: serverTimestamp(),
          updatedBy: auth.currentUser.email,
        });
        freedBedId = oldBedId;
      }
    }

    if (newBed.occupiedBy && newBed.occupiedBy !== clientId) {
      throw new Error(`${bedId} is already occupied by ${newBed.occupiedByName || newBed.occupiedBy}.`);
    }

    const fullName = clientDisplayName(clientData);
    const now = serverTimestamp();
    txn.update(newBedRef, {
      occupiedBy: clientId,
      occupiedByName: fullName,
      occupiedSince: now,
      assignedBy: auth.currentUser.email,
      updatedAt: now,
      updatedBy: auth.currentUser.email,
    });
    txn.update(clientRef, {
      bedAssignment: {
        bedId,
        dorm: dormKey,
        dormLabel,
        assignedAt: Timestamp.now(),
        assignedBy: auth.currentUser.email,
      },
    });

    return { freedBedId };
  });

  await logAccess(AUDIT_ACTIONS.UPDATE, "bed", bedId, {
    clientId, action: "assign",
  });
  await logAccess(AUDIT_ACTIONS.UPDATE, "client", clientId, {
    surface: "bed-assignment", bedId,
  });
  if (result.freedBedId) {
    await logAccess(AUDIT_ACTIONS.UPDATE, "bed", result.freedBedId, {
      clientId, action: "free", reason: "reassigned",
    });
  }
}

async function unassignBedForClient(clientId) {
  if (!clientId) throw new Error("Need client.");
  const clientRef = doc(db, "clients", clientId);

  const result = await runTransaction(db, async (txn) => {
    const clientSnap = await txn.get(clientRef);
    if (!clientSnap.exists()) throw new Error(`Client ${clientId} not found.`);
    const clientData = clientSnap.data();
    const bedId = clientData.bedAssignment?.bedId;
    if (!bedId) return { freedBedId: null };
    const bedRef = doc(db, "beds", bedId);
    const bedSnap = await txn.get(bedRef);
    if (bedSnap.exists() && bedSnap.data().occupiedBy === clientId) {
      txn.update(bedRef, {
        occupiedBy: null,
        occupiedByName: null,
        occupiedSince: null,
        assignedBy: null,
        updatedAt: serverTimestamp(),
        updatedBy: auth.currentUser.email,
      });
    }
    txn.update(clientRef, { bedAssignment: null });
    return { freedBedId: bedId };
  });

  if (result.freedBedId) {
    await logAccess(AUDIT_ACTIONS.UPDATE, "bed", result.freedBedId, {
      clientId, action: "free", reason: "unassign",
    });
    await logAccess(AUDIT_ACTIONS.UPDATE, "client", clientId, {
      surface: "bed-assignment", bedId: null,
    });
  }
}

// ============================================================
// Program slice — level, probation, leadership role
// ============================================================
//
// Master fields:
//   level: "alpha" | "bravo" | "charlie" | "delta"
//   probationUntil: Timestamp | null    (in future = on probation)
//   probationReason: string | null
//   leadershipRole: keyword | null      (one of LEADERSHIP_ROLES)
//
// New intakes default to Alpha + 14-day probation. Re-entries reset the clock
// (Daniel: returning clients restart the program). Staff edits via the
// "GSO Program" fieldset on the client detail page.

function renderClientProgram(cid, master) {
  const summary = document.getElementById("client-program-summary");
  const form = document.getElementById("client-program-form");
  if (!summary || !form) return;

  // Summary chips at the top — level (with -P suffix if on probation),
  // probation end date if applicable, leadership role.
  const lvlKey = master?.level || "alpha";
  const onProb = isOnProbation(master);
  const probEndStr = master?.probationUntil
    ? fmtDate(master.probationUntil)
    : null;
  const roleLabel = master?.leadershipRole
    ? LEADERSHIP_ROLES[master.leadershipRole] || master.leadershipRole
    : null;
  const reason = (master?.probationReason || "").trim();

  const chips = [];
  chips.push(`<span class="level-chip level-${lvlKey} ${onProb ? "on-probation" : ""}">${escapeHtml(levelDisplay(master))}</span>`);
  if (onProb && probEndStr) {
    chips.push(`<span class="probation-meta">Probation through ${escapeHtml(probEndStr)}${reason ? ` — ${escapeHtml(reason)}` : ""}</span>`);
  } else if (reason && master?.probationUntil) {
    chips.push(`<span class="probation-meta muted">Last probation reason: ${escapeHtml(reason)} (ended ${escapeHtml(probEndStr || "")})</span>`);
  }
  if (roleLabel) {
    chips.push(`<span class="leadership-chip">${escapeHtml(roleLabel)}</span>`);
  }
  summary.innerHTML = chips.join(" ");

  // Populate form
  form.elements.level.value = LEVEL_KEYS.includes(lvlKey) ? lvlKey : "alpha";
  form.elements.leadershipRole.value = master?.leadershipRole && LEADERSHIP_ROLES[master.leadershipRole]
    ? master.leadershipRole
    : "";
  form.elements.probationUntil.value = probEndStr
    ? toDateInputValue(master.probationUntil)
    : "";
  form.elements.probationReason.value = reason;
  form.dataset.cid = cid;

  const status = document.getElementById("program-save-status");
  if (status) {
    status.textContent = "No changes";
    status.classList.remove("error", "ok");
  }
}

// Convert a Firestore Timestamp / Date to YYYY-MM-DD for <input type="date">.
function toDateInputValue(ts) {
  let d;
  if (!ts) return "";
  if (typeof ts.toDate === "function") d = ts.toDate();
  else if (ts.seconds != null) d = new Date(ts.seconds * 1000);
  else if (ts instanceof Date) d = ts;
  else return "";
  return d.toISOString().slice(0, 10);
}

(function bindProgramForm() {
  const form = document.getElementById("client-program-form");
  if (!form) return;
  const status = document.getElementById("program-save-status");
  const endBtn = document.getElementById("program-end-probation");
  const saveBtn = document.getElementById("program-save");

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const cid = form.dataset.cid;
    if (!cid) return;
    saveBtn.disabled = true;
    if (status) {
      status.textContent = "Saving…";
      status.classList.remove("error", "ok");
    }
    try {
      const fd = new FormData(form);
      const level = fd.get("level") || "alpha";
      if (!LEVEL_KEYS.includes(level)) throw new Error("Invalid level.");
      const leadershipRoleRaw = (fd.get("leadershipRole") || "").toString();
      const leadershipRole = leadershipRoleRaw && LEADERSHIP_ROLES[leadershipRoleRaw]
        ? leadershipRoleRaw
        : null;
      const probUntilStr = (fd.get("probationUntil") || "").toString();
      const probationUntil = probUntilStr
        ? Timestamp.fromDate(new Date(probUntilStr + "T00:00:00"))
        : null;
      const probationReason = (fd.get("probationReason") || "").toString().trim() || null;

      await updateDoc(doc(db, "clients", cid), {
        level,
        leadershipRole,
        probationUntil,
        probationReason,
      });
      await logAccess(AUDIT_ACTIONS.UPDATE, "client", cid, {
        surface: "program",
        level, leadershipRole,
        probationUntil: probUntilStr || null,
        probationReason,
      });
      if (status) {
        status.textContent = "Saved.";
        status.classList.add("ok");
      }
    } catch (err) {
      if (status) {
        status.textContent = `Save failed: ${err.message}`;
        status.classList.add("error");
      }
    } finally {
      saveBtn.disabled = false;
    }
  });

  endBtn?.addEventListener("click", async () => {
    const cid = form.dataset.cid;
    if (!cid) return;
    if (!confirm("End probation for this client now?")) return;
    endBtn.disabled = true;
    if (status) {
      status.textContent = "Ending probation…";
      status.classList.remove("error", "ok");
    }
    try {
      await updateDoc(doc(db, "clients", cid), {
        probationUntil: null,
        // Keep probationReason as historical context; UI hides it once the
        // probation isn't active. Staff can clear it manually if they want.
      });
      await logAccess(AUDIT_ACTIONS.UPDATE, "client", cid, {
        surface: "program",
        action: "end-probation-early",
      });
      // Clear the date field; render will refresh from snapshot
      form.elements.probationUntil.value = "";
      if (status) {
        status.textContent = "Probation ended.";
        status.classList.add("ok");
      }
    } catch (err) {
      if (status) {
        status.textContent = `Failed: ${err.message}`;
        status.classList.add("error");
      }
    } finally {
      endBtn.disabled = false;
    }
  });
})();

// ============================================================
// Check-in/out slice — per-event sign-out/sign-in tracking
// ============================================================
//
// Schema at checkInOuts/{eventId} — see plan §14.2:
//   clientId, clientName, direction ("out"|"in"), eventTime,
//   reason (only when direction="out"), reasonNote (only when reason="other"),
//   submittedBy (clientId for client self-submit, staff email for backfill),
//   submittedAt, expiresAt (= submittedAt + 21d, native Firestore TTL deletes).
//
// This slice ships the staff-facing surface: a "Sign In/Out" tab with the
// "currently signed out" tile + recent activity feed + staff backfill, plus
// a per-client fieldset on the detail page. Client self-submission lands
// in a later slice once the clientAuth Cloud Function ships (§14.1).

const CHECKINOUT_REASONS = {
  work: "Work",
  drAppt: "Doctor's appointment",
  counseling: "Counseling",
  shopping: "Shopping",
  jobHunt: "Job hunting",
  school: "School",
  thriftStore: "Thrift store",
  other: "Other",
};
const CHECKINOUT_TTL_DAYS = 21;
const PER_EVENT_TTL_DAYS = 21;        // mealLog, showerLog — same shape as checkInOuts
const SCHEDULE_TTL_DAYS_AFTER_WEEK = 21; // clientWeeklySchedule, thriftStoreSchedule
const RECENT_ACTIVITY_HOURS = 24;

// expiresAt for per-event log writes (mealLog, showerLog, checkInOuts).
// Always submittedAt + 21 days; Firestore TTL collects on the field.
function perEventExpiresAt(now = new Date()) {
  return Timestamp.fromDate(new Date(now.getTime() + PER_EVENT_TTL_DAYS * 86400 * 1000));
}

// expiresAt for weekly-schedule docs (per-client schedule + master thrift
// schedule). The week itself ends 7 days after weekStart (Monday); we keep
// the doc for SCHEDULE_TTL_DAYS_AFTER_WEEK additional days for review.
function scheduleExpiresAt(weekStartStr) {
  const d = new Date(weekStartStr + "T00:00:00");
  d.setDate(d.getDate() + 7 + SCHEDULE_TTL_DAYS_AFTER_WEEK);
  return Timestamp.fromDate(d);
}

function checkInOutReasonLabel(key) {
  return CHECKINOUT_REASONS[key] || key || "—";
}

function clientFullName(data) {
  return [data.firstName, data.middleName, data.lastName].filter(Boolean).join(" ") || "(no name)";
}

function tsToDate(ts) {
  if (!ts) return null;
  if (typeof ts.toDate === "function") return ts.toDate();
  if (ts.seconds != null) return new Date(ts.seconds * 1000);
  if (ts instanceof Date) return ts;
  return null;
}

function fmtElapsed(ts) {
  const d = tsToDate(ts);
  if (!d || isNaN(d)) return "";
  const ms = Date.now() - d.getTime();
  if (ms < 0) return "in the future";
  const min = Math.floor(ms / 60000);
  if (min < 1) return "just now";
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ${min % 60}m ago`;
  const day = Math.floor(hr / 24);
  return `${day}d ${hr % 24}h ago`;
}

function fmtTimeShort(ts) {
  const d = tsToDate(ts);
  if (!d || isNaN(d)) return "";
  return d.toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

// A client is "overdue past 8pm" if they're currently out AND it's past 8pm
// local time on the day they signed out (or any day after that).
function isOverduePast8pm(eventTime) {
  const d = tsToDate(eventTime);
  if (!d) return false;
  const now = new Date();
  const past8 = now.getHours() >= 20;
  // Same calendar day → overdue iff it's past 8pm now
  if (d.toDateString() === now.toDateString()) return past8;
  // Different day → they've been out across days; overdue regardless of hour
  return d <= now;
}

// ----- Listener: last 24h of events (powers tab tile + recent activity) -----

let cachedRecentEvents = []; // sorted desc by eventTime
let unsubscribeCheckInOuts = null;

function startCheckInOutListener() {
  if (unsubscribeCheckInOuts) return;
  const cutoff = Timestamp.fromDate(new Date(Date.now() - RECENT_ACTIVITY_HOURS * 3600 * 1000));
  const q = query(
    collection(db, "checkInOuts"),
    where("eventTime", ">=", cutoff),
    orderBy("eventTime", "desc"),
  );
  unsubscribeCheckInOuts = onSnapshot(
    q,
    (snap) => {
      cachedRecentEvents = snap.docs.map((d) => ({ id: d.id, data: d.data() }));
      renderCheckInOutTab();
      // Refresh open client detail summary; the per-client history is loaded
      // separately by loadClientCheckInOut (kept fresh on every tab open).
      if (currentDetailClientId && document.getElementById("client-checkinout-summary")) {
        renderClientCheckInOutSummary(currentDetailClientId);
      }
    },
    (err) => {
      console.warn("checkInOuts listener failed:", err);
    },
  );
}

function stopCheckInOutListener() {
  if (unsubscribeCheckInOuts) {
    unsubscribeCheckInOuts();
    unsubscribeCheckInOuts = null;
  }
  cachedRecentEvents = [];
}

// cachedRecentEvents is already sorted desc by eventTime, so the first
// occurrence of each clientId is its most recent event in the last 24h.
function getLatestEventByClient(events) {
  const latest = new Map();
  for (const e of events) {
    if (!latest.has(e.data.clientId)) latest.set(e.data.clientId, e);
  }
  return latest;
}

// ----- Tab render: currently-out tile + recent activity -----

function renderCheckInOutTab() {
  renderCurrentlyOutCard();
  renderRecentActivityList();
  // If a client is selected in the quick-log picker, refresh its state row
  // so the buttons toggle correctly when a new event lands.
  if (checkInOutQuickClient) refreshQuickActionsState();
}

function renderCurrentlyOutCard() {
  const listEl = document.getElementById("currently-out-list");
  const countEl = document.getElementById("checkinout-currently-out-count");
  if (!listEl || !countEl) return;

  const latest = getLatestEventByClient(cachedRecentEvents);
  const out = [];
  for (const [cid, ev] of latest) {
    if (ev.data.direction === "out") out.push({ cid, ev });
  }
  // Oldest first → longest out at the top (more likely overdue).
  out.sort((a, b) => (a.ev.data.eventTime?.toMillis?.() ?? 0) - (b.ev.data.eventTime?.toMillis?.() ?? 0));

  countEl.textContent = `${out.length} currently out`;

  if (out.length === 0) {
    listEl.innerHTML = `<p class="note">All clients are signed in.</p>`;
    return;
  }

  listEl.innerHTML = out.map(({ cid, ev }) => {
    const reason = checkInOutReasonLabel(ev.data.reason);
    const reasonNote = ev.data.reasonNote ? ` — ${escapeHtml(ev.data.reasonNote)}` : "";
    const elapsed = fmtElapsed(ev.data.eventTime);
    const eventTimeStr = fmtTimeShort(ev.data.eventTime);
    const overdue = isOverduePast8pm(ev.data.eventTime);
    const overdueChip = overdue ? `<span class="overdue-chip">Past 8pm</span>` : "";
    return `
      <div class="currently-out-row${overdue ? " overdue" : ""}">
        <div class="cor-name"><strong>${escapeHtml(ev.data.clientName || cid)}</strong> <code>${escapeHtml(cid)}</code> ${overdueChip}</div>
        <div class="cor-meta">${escapeHtml(reason)}${reasonNote} · out at ${escapeHtml(eventTimeStr)} (${escapeHtml(elapsed)})</div>
        <button type="button" class="ghost cor-signin" data-cid="${escapeHtml(cid)}">Sign in now</button>
      </div>
    `;
  }).join("");

  listEl.querySelectorAll(".cor-signin").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const cid = btn.dataset.cid;
      const c = cachedClients.find((c) => c.id === cid);
      const name = c ? clientFullName(c.data) : cid;
      btn.disabled = true;
      try {
        await submitCheckInOut({ clientId: cid, clientName: name, direction: "in" });
      } catch (err) {
        alert(`Sign-in failed: ${err.message}`);
        btn.disabled = false;
      }
    });
  });
}

function renderRecentActivityList() {
  const listEl = document.getElementById("recent-activity-list");
  if (!listEl) return;

  if (cachedRecentEvents.length === 0) {
    listEl.innerHTML = `<p class="note">No activity in the last 24 hours.</p>`;
    return;
  }

  listEl.innerHTML = cachedRecentEvents.map((ev) => {
    const cid = ev.data.clientId;
    const name = ev.data.clientName || cid;
    const dir = ev.data.direction === "out" ? "Signed out" : "Signed in";
    const reasonStr = ev.data.direction === "out"
      ? ` · ${escapeHtml(checkInOutReasonLabel(ev.data.reason))}${ev.data.reasonNote ? ` (${escapeHtml(ev.data.reasonNote)})` : ""}`
      : "";
    const submittedBy = ev.data.submittedBy === cid ? "self" : escapeHtml(ev.data.submittedBy || "—");
    return `
      <div class="activity-row activity-${ev.data.direction}">
        <span class="activity-time">${escapeHtml(fmtTimeShort(ev.data.eventTime))}</span>
        <span class="activity-name"><strong>${escapeHtml(name)}</strong> <code>${escapeHtml(cid)}</code></span>
        <span class="activity-dir">${escapeHtml(dir)}${reasonStr}</span>
        <span class="activity-by muted">by ${submittedBy}</span>
      </div>
    `;
  }).join("");
}

// ----- Tab: staff backfill quick-log -----

let checkInOutQuickPicker = null;
let checkInOutQuickClient = null; // {clientId, name, data}

function mountCheckInOutQuickPicker() {
  const root = document.getElementById("checkinout-picker");
  if (!root || checkInOutQuickPicker) return;
  checkInOutQuickPicker = createClientPicker({
    root,
    placeholder: "Search by name, alias, or client ID…",
    onChange: (sel) => {
      checkInOutQuickClient = sel;
      const status = document.getElementById("checkinout-quick-status");
      if (status) { status.textContent = ""; status.classList.remove("error", "ok"); }
      refreshQuickActionsState();
    },
  });
}

function refreshQuickActionsState() {
  const wrap = document.getElementById("checkinout-quick-actions");
  const stateEl = document.getElementById("checkinout-quick-state");
  const outBtn = document.getElementById("checkinout-quick-out");
  const inBtn = document.getElementById("checkinout-quick-in");
  if (!wrap || !stateEl || !outBtn || !inBtn) return;

  const sel = checkInOutQuickClient;
  if (!sel) {
    wrap.hidden = true;
    return;
  }
  wrap.hidden = false;

  const latest = getLatestEventByClient(cachedRecentEvents);
  const ev = latest.get(sel.clientId);
  if (ev?.data.direction === "out") {
    const reason = checkInOutReasonLabel(ev.data.reason);
    stateEl.textContent = `Currently signed out (${reason}, ${fmtElapsed(ev.data.eventTime)}).`;
    outBtn.disabled = true;
    inBtn.disabled = false;
  } else {
    stateEl.textContent = ev
      ? `Currently signed in. Last event: signed in ${fmtElapsed(ev.data.eventTime)}.`
      : "No events in the last 24 hours.";
    outBtn.disabled = false;
    inBtn.disabled = true;
  }
}

(function bindCheckInOutQuickActions() {
  const outBtn = document.getElementById("checkinout-quick-out");
  const inBtn = document.getElementById("checkinout-quick-in");
  const status = document.getElementById("checkinout-quick-status");
  if (!outBtn || !inBtn) return;

  outBtn.addEventListener("click", () => {
    if (!checkInOutQuickClient) return;
    const sel = checkInOutQuickClient;
    openReasonModal({
      clientName: sel.name,
      onConfirm: async ({ reason, reasonNote }) => {
        outBtn.disabled = true;
        if (status) { status.textContent = "Saving…"; status.classList.remove("error", "ok"); }
        try {
          await submitCheckInOut({
            clientId: sel.clientId,
            clientName: sel.name,
            direction: "out",
            reason,
            reasonNote,
          });
          if (status) { status.textContent = `Signed out: ${checkInOutReasonLabel(reason)}.`; status.classList.add("ok"); }
        } catch (err) {
          if (status) { status.textContent = `Sign-out failed: ${err.message}`; status.classList.add("error"); }
          outBtn.disabled = false;
        }
      },
    });
  });

  inBtn.addEventListener("click", async () => {
    if (!checkInOutQuickClient) return;
    const sel = checkInOutQuickClient;
    inBtn.disabled = true;
    if (status) { status.textContent = "Saving…"; status.classList.remove("error", "ok"); }
    try {
      await submitCheckInOut({
        clientId: sel.clientId,
        clientName: sel.name,
        direction: "in",
      });
      if (status) { status.textContent = "Signed in."; status.classList.add("ok"); }
    } catch (err) {
      if (status) { status.textContent = `Sign-in failed: ${err.message}`; status.classList.add("error"); }
      inBtn.disabled = false;
    }
  });
})();

// ----- Reason picker modal -----

let reasonModalState = { onConfirm: null, selectedReason: null };

function openReasonModal({ clientName, onConfirm }) {
  reasonModalState = { onConfirm, selectedReason: null };
  const modal = document.getElementById("reason-modal");
  const subtitle = document.getElementById("reason-modal-subtitle");
  const optionsEl = document.getElementById("reason-options");
  const otherWrap = document.getElementById("reason-other-wrap");
  const otherText = document.getElementById("reason-other-text");
  const confirmBtn = document.getElementById("reason-modal-confirm");
  if (!modal || !optionsEl || !confirmBtn) return;

  subtitle.textContent = `Sign-out reason for ${clientName}.`;
  otherWrap.hidden = true;
  otherText.value = "";
  confirmBtn.disabled = true;

  optionsEl.innerHTML = Object.entries(CHECKINOUT_REASONS).map(([key, label]) => `
    <button type="button" class="reason-option" data-reason="${escapeHtml(key)}">${escapeHtml(label)}</button>
  `).join("");

  optionsEl.querySelectorAll(".reason-option").forEach((btn) => {
    btn.addEventListener("click", () => {
      reasonModalState.selectedReason = btn.dataset.reason;
      optionsEl.querySelectorAll(".reason-option").forEach((b) => b.classList.toggle("selected", b === btn));
      otherWrap.hidden = btn.dataset.reason !== "other";
      confirmBtn.disabled = false;
      if (btn.dataset.reason === "other") otherText.focus();
    });
  });

  modal.hidden = false;
}

function closeReasonModal() {
  const modal = document.getElementById("reason-modal");
  if (modal) modal.hidden = true;
  reasonModalState = { onConfirm: null, selectedReason: null };
}

(function bindReasonModal() {
  const cancelBtn = document.getElementById("reason-modal-cancel");
  const confirmBtn = document.getElementById("reason-modal-confirm");
  const backdrop = document.getElementById("reason-modal-backdrop");
  if (!cancelBtn || !confirmBtn) return;

  cancelBtn.addEventListener("click", closeReasonModal);
  backdrop?.addEventListener("click", closeReasonModal);
  confirmBtn.addEventListener("click", () => {
    const { onConfirm, selectedReason } = reasonModalState;
    if (!onConfirm || !selectedReason) return;
    const otherText = document.getElementById("reason-other-text");
    const reasonNote = selectedReason === "other"
      ? (otherText?.value || "").trim()
      : null;
    if (selectedReason === "other" && !reasonNote) {
      otherText?.focus();
      return;
    }
    closeReasonModal();
    onConfirm({ reason: selectedReason, reasonNote });
  });
})();

// ----- Write a check-in/out event -----

async function submitCheckInOut({ clientId, clientName, direction, reason = null, reasonNote = null }) {
  if (!auth.currentUser) throw new Error("Not signed in.");
  if (!["out", "in"].includes(direction)) throw new Error("Invalid direction.");
  if (direction === "out" && !CHECKINOUT_REASONS[reason]) throw new Error("Invalid reason.");
  if (!CLIENT_ID_RE.test(clientId)) throw new Error("Invalid client ID.");

  // Branch on the cached role: client self-submit sets submittedBy to their
  // own clientId (matches the rule); staff backfill sets it to the staff
  // email. Surface tag distinguishes the two in the audit log.
  const isClient = currentUserRole === "client";
  const submittedBy = isClient ? clientId : auth.currentUser.email;
  const surface = isClient ? "client-app" : "staff-backfill";

  const now = new Date();
  const expiresAt = Timestamp.fromDate(new Date(now.getTime() + CHECKINOUT_TTL_DAYS * 86400 * 1000));
  const data = {
    clientId,
    clientName: clientName || clientId,
    direction,
    eventTime: Timestamp.fromDate(now),
    submittedBy,
    submittedAt: serverTimestamp(),
    expiresAt,
  };
  if (direction === "out") {
    data.reason = reason;
    if (reason === "other" && reasonNote) data.reasonNote = reasonNote;
  }

  const ref = await addDoc(collection(db, "checkInOuts"), data);
  await logAccess(AUDIT_ACTIONS.CREATE, "checkInOut", ref.id, {
    clientId, direction,
    reason: direction === "out" ? reason : null,
    surface,
  });
  return ref.id;
}

// One-tap shower / meal helpers used by the client app. Staff side has its
// own roster checkboxes that don't write per-event docs (see §13.5); these
// per-event docs are the client-app source of truth and feed reports.
async function submitShowerLog({ clientId, clientName }) {
  if (!auth.currentUser) throw new Error("Not signed in.");
  if (!CLIENT_ID_RE.test(clientId)) throw new Error("Invalid client ID.");
  const now = new Date();
  const ref = await addDoc(collection(db, "showerLog"), {
    clientId,
    clientName: clientName || clientId,
    eventTime: Timestamp.fromDate(now),
    submittedBy: currentUserRole === "client" ? clientId : auth.currentUser.email,
    submittedAt: serverTimestamp(),
    expiresAt: perEventExpiresAt(now),
  });
  await logAccess(AUDIT_ACTIONS.CREATE, "showerLog", ref.id, {
    clientId, surface: currentUserRole === "client" ? "client-app" : "staff-backfill",
  });
  return ref.id;
}

async function submitMealLog({ clientId, clientName, meal }) {
  if (!auth.currentUser) throw new Error("Not signed in.");
  if (!CLIENT_ID_RE.test(clientId)) throw new Error("Invalid client ID.");
  if (!["breakfast", "lunch", "dinner"].includes(meal)) {
    throw new Error("Invalid meal.");
  }
  const now = new Date();
  const ref = await addDoc(collection(db, "mealLog"), {
    clientId,
    clientName: clientName || clientId,
    meal,
    eventTime: Timestamp.fromDate(now),
    submittedBy: currentUserRole === "client" ? clientId : auth.currentUser.email,
    submittedAt: serverTimestamp(),
    expiresAt: perEventExpiresAt(now),
  });
  await logAccess(AUDIT_ACTIONS.CREATE, "mealLog", ref.id, {
    clientId, meal, surface: currentUserRole === "client" ? "client-app" : "staff-backfill",
  });
  return ref.id;
}

// ----- Client detail: per-client history fieldset -----

let clientCheckInOutHistory = [];

async function loadClientCheckInOut(cid) {
  const summary = document.getElementById("client-checkinout-summary");
  const histEl = document.getElementById("client-checkinout-history");
  const status = document.getElementById("client-checkinout-status");
  if (!summary || !histEl) return;
  if (status) { status.textContent = ""; status.classList.remove("error", "ok"); }

  try {
    const cutoff = Timestamp.fromDate(new Date(Date.now() - CHECKINOUT_TTL_DAYS * 86400 * 1000));
    const q = query(
      collection(db, "checkInOuts"),
      where("clientId", "==", cid),
      where("eventTime", ">=", cutoff),
      orderBy("eventTime", "desc"),
      limit(200),
    );
    const snap = await getDocs(q);
    clientCheckInOutHistory = snap.docs.map((d) => ({ id: d.id, data: d.data() }));
    renderClientCheckInOutHistory();
    renderClientCheckInOutSummary(cid);
  } catch (err) {
    histEl.innerHTML = `<p class="error">Could not load: ${escapeHtml(err.message)}</p>`;
  }
}

function renderClientCheckInOutSummary(cid) {
  const summary = document.getElementById("client-checkinout-summary");
  const outBtn = document.getElementById("client-checkinout-out");
  const inBtn = document.getElementById("client-checkinout-in");
  if (!summary) return;

  // Latest event = most recent across the 24h listener cache and the
  // per-client load. The listener wins when both have data (real-time).
  const latest = getLatestEventByClient(cachedRecentEvents);
  let ev = latest.get(cid);
  if (!ev && clientCheckInOutHistory.length > 0) ev = clientCheckInOutHistory[0];

  if (!ev) {
    summary.innerHTML = `<span class="checkinout-state state-in">Signed in</span> <span class="muted">No events in the last 3 weeks.</span>`;
    if (outBtn) outBtn.disabled = false;
    if (inBtn) inBtn.disabled = true;
    return;
  }

  if (ev.data.direction === "out") {
    const reason = checkInOutReasonLabel(ev.data.reason);
    const reasonNote = ev.data.reasonNote ? ` — ${escapeHtml(ev.data.reasonNote)}` : "";
    summary.innerHTML = `<span class="checkinout-state state-out">Signed out</span> <span class="muted">${escapeHtml(reason)}${reasonNote} · ${escapeHtml(fmtElapsed(ev.data.eventTime))}</span>`;
    if (outBtn) outBtn.disabled = true;
    if (inBtn) inBtn.disabled = false;
  } else {
    summary.innerHTML = `<span class="checkinout-state state-in">Signed in</span> <span class="muted">Last event ${escapeHtml(fmtElapsed(ev.data.eventTime))}</span>`;
    if (outBtn) outBtn.disabled = false;
    if (inBtn) inBtn.disabled = true;
  }
}

function renderClientCheckInOutHistory() {
  const histEl = document.getElementById("client-checkinout-history");
  if (!histEl) return;

  if (clientCheckInOutHistory.length === 0) {
    histEl.innerHTML = `<p class="note">No events in the last 3 weeks.</p>`;
    return;
  }

  histEl.innerHTML = clientCheckInOutHistory.map((ev) => {
    const dir = ev.data.direction === "out" ? "OUT" : "IN";
    const reasonStr = ev.data.direction === "out"
      ? ` · ${escapeHtml(checkInOutReasonLabel(ev.data.reason))}${ev.data.reasonNote ? ` (${escapeHtml(ev.data.reasonNote)})` : ""}`
      : "";
    const submittedBy = ev.data.submittedBy === ev.data.clientId ? "self" : escapeHtml(ev.data.submittedBy || "—");
    return `
      <div class="activity-row activity-${ev.data.direction}">
        <span class="activity-time">${escapeHtml(fmtTimeShort(ev.data.eventTime))}</span>
        <span class="activity-name"></span>
        <span class="activity-dir"><strong>${dir}</strong>${reasonStr}</span>
        <span class="activity-by muted">by ${submittedBy}</span>
      </div>
    `;
  }).join("");
}

// ----- Reset PIN button (client detail) -----

(function bindResetPin() {
  const btn = document.getElementById("client-reset-pin");
  const status = document.getElementById("client-reset-pin-status");
  const wrap = document.getElementById("client-reset-pin-display");
  const valueEl = document.getElementById("client-reset-pin-value");
  const clearBtn = document.getElementById("client-reset-pin-clear");
  if (!btn) return;

  btn.addEventListener("click", async () => {
    const cid = currentDetailClientId;
    if (!cid) return;
    if (!confirm("Generate a new PIN for this client? The old PIN will stop working immediately.")) return;
    btn.disabled = true;
    if (status) {
      status.textContent = "Generating…";
      status.classList.remove("ok", "error");
    }
    if (wrap) wrap.hidden = true;
    try {
      const result = await clientAuthReset({ clientId: cid });
      const pin = result?.data?.pin;
      if (!pin) throw new Error("No PIN returned.");
      if (valueEl) valueEl.textContent = pin;
      if (wrap) wrap.hidden = false;
      if (status) {
        status.textContent = "Generated. Write down or print for the client — won't be shown again after Clear.";
        status.classList.add("ok");
      }
    } catch (err) {
      const msg = err?.message || "Reset failed.";
      if (status) {
        status.textContent = `Failed: ${msg}`;
        status.classList.add("error");
      }
    } finally {
      btn.disabled = false;
    }
  });

  clearBtn?.addEventListener("click", () => {
    if (valueEl) valueEl.textContent = "";
    if (wrap) wrap.hidden = true;
    if (status) {
      status.textContent = "";
      status.classList.remove("ok", "error");
    }
  });
})();

(function bindClientCheckInOutButtons() {
  const outBtn = document.getElementById("client-checkinout-out");
  const inBtn = document.getElementById("client-checkinout-in");
  const status = document.getElementById("client-checkinout-status");
  if (!outBtn || !inBtn) return;

  outBtn.addEventListener("click", () => {
    const cid = currentDetailClientId;
    if (!cid) return;
    const c = cachedClients.find((c) => c.id === cid);
    const name = c ? clientFullName(c.data) : cid;
    openReasonModal({
      clientName: name,
      onConfirm: async ({ reason, reasonNote }) => {
        outBtn.disabled = true;
        if (status) { status.textContent = "Saving…"; status.classList.remove("error", "ok"); }
        try {
          await submitCheckInOut({ clientId: cid, clientName: name, direction: "out", reason, reasonNote });
          if (status) { status.textContent = `Signed out: ${checkInOutReasonLabel(reason)}.`; status.classList.add("ok"); }
          await loadClientCheckInOut(cid);
        } catch (err) {
          if (status) { status.textContent = `Sign-out failed: ${err.message}`; status.classList.add("error"); }
          outBtn.disabled = false;
        }
      },
    });
  });

  inBtn.addEventListener("click", async () => {
    const cid = currentDetailClientId;
    if (!cid) return;
    const c = cachedClients.find((c) => c.id === cid);
    const name = c ? clientFullName(c.data) : cid;
    inBtn.disabled = true;
    if (status) { status.textContent = "Saving…"; status.classList.remove("error", "ok"); }
    try {
      await submitCheckInOut({ clientId: cid, clientName: name, direction: "in" });
      if (status) { status.textContent = "Signed in."; status.classList.add("ok"); }
      await loadClientCheckInOut(cid);
    } catch (err) {
      if (status) { status.textContent = `Sign-in failed: ${err.message}`; status.classList.add("error"); }
      inBtn.disabled = false;
    }
  });
})();

// ============================================================
// Client app — sign-in + home screen (§14.3, §14.5 #6)
// ============================================================
//
// Mobile-first single-column UI used by clients on their phone (or any
// browser) for the four daily interactions: check-in/out, shower, three
// meal logs. Lives behind role="client" routing in onAuthStateChanged.
// Reuses submitCheckInOut + the existing reason-picker modal — no separate
// per-event write path. Listeners scope every read by clientId so a client
// only ever sees their own data, enforced again at the Firestore rules layer.

let clientAppListeners = [];
let clientAppMaster = null;
let todayCheckInOuts = [];
let todayMeals = [];
let todayShowers = [];

// My-schedule panel state. Personal events come from a single query over
// clientWeeklySchedule filtered to this client; we pick out the two weeks of
// interest in the renderer. Thrift comes from one onSnapshot per week's
// master doc. Querying-by-clientId for personal avoids a "rule denies getDoc
// on a non-existent doc" trap when the client has no schedule yet.
let clientMyScheduleAllUnsub = null;
let clientMyScheduleThriftUnsubs = [];
let clientMySchedulePersonalAll = [];
let clientMyScheduleThrift = { thisWeek: null, lastWeek: null };
let clientMyScheduleThisWeekStart = null;
let clientMyScheduleLastWeekStart = null;

// ----- Client sign-in form (PIN-based) -----
// The Client ID field is split visually into a static "GSO-" prefix and a
// digit-only input. We only ever read/write the digit portion here; the
// prefix is baked into the DOM by config.js applyTenantBranding().
(function bindClientSignInForm() {
  const form = document.getElementById("client-signin-form");
  if (!form) return;
  const digitsInput = document.getElementById("client-signin-id-digits");
  const pinInput = document.getElementById("client-signin-pin");
  const errEl = document.getElementById("client-signin-error");
  const btn = document.getElementById("client-signin-btn");

  const cidPrefix = TENANT.clientIdPrefix;
  const cidDigits = TENANT.clientIdDigits;
  const digitsRe = new RegExp(`^\\d{${cidDigits}}$`);

  // If a client pastes a full ID (e.g. "GSO-12345") or a value with stray
  // characters, strip to digits and keep the last cidDigits so the visible
  // prefix still makes sense.
  digitsInput.addEventListener("paste", (e) => {
    const raw = (e.clipboardData || window.clipboardData)?.getData("text") || "";
    const digits = raw.replace(/\D+/g, "").slice(-cidDigits);
    if (digits) {
      e.preventDefault();
      digitsInput.value = digits;
    }
  });

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    errEl.hidden = true;
    const digits = digitsInput.value.trim();
    const pin = pinInput.value.trim();
    if (!digitsRe.test(digits)) {
      errEl.textContent = `Client ID must be a ${cidDigits}-digit number.`;
      errEl.hidden = false;
      return;
    }
    if (!/^\d{6}$/.test(pin)) {
      errEl.textContent = "PIN must be 6 digits.";
      errEl.hidden = false;
      return;
    }
    const clientId = `${cidPrefix}-${digits}`;
    btn.disabled = true;
    btn.textContent = "Signing in…";
    try {
      const result = await clientAuthSignIn({ clientId, pin });
      const token = result?.data?.token;
      if (!token) throw new Error("Sign-in failed (no token returned).");
      await signInWithCustomToken(auth, token);
      pinInput.value = "";
    } catch (err) {
      // Cloud Function HttpsError surfaces a `message`; show it verbatim so
      // the client sees lockout / wrong-credentials messaging.
      errEl.textContent = err?.message || "Sign-in failed.";
      errEl.hidden = false;
    } finally {
      btn.disabled = false;
      btn.textContent = "Sign in";
    }
  });
})();

// ----- Client home screen -----

async function initClientApp(user, clientId) {
  stopClientAppListeners();
  if (!clientId) {
    showClientActionStatus("Missing client ID on token.", "error");
    return;
  }
  try {
    const masterSnap = await getDoc(doc(db, "clients", clientId));
    if (!masterSnap.exists()) {
      showClientActionStatus("Client record not found.", "error");
      return;
    }
    clientAppMaster = { clientId, ...masterSnap.data() };
  } catch (err) {
    console.error("[client-app] master load failed", err);
    clientAppMaster = { clientId };
  }
  const greetName = clientAppMaster.firstName || clientId;
  document.getElementById("client-greeting-name").textContent = `Hi, ${greetName}`;
  document.getElementById("client-greeting-id").textContent = clientId;

  wireClientHomeButtons();
  startTodayListeners(clientId);

  // Schedule editor + recent-submissions feed.
  ensureClientScheduleWeekDefault();
  setClientScheduleWeek(clientScheduleWeek);
  bindClientScheduleControls();
  bindClientInfoUpdateForm();
  bindClientStaffRequestForm();
  startClientSubmissionsListener(clientId);
  startClientMyScheduleListener(clientId);
  startClientAppDocsListener(clientId);
}

function stopClientAppListeners() {
  clientAppListeners.forEach((unsub) => { try { unsub(); } catch {} });
  clientAppListeners = [];
}

function todayStartTimestamp() {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return Timestamp.fromDate(d);
}

function startTodayListeners(clientId) {
  const todayStart = todayStartTimestamp();
  const queries = [
    { coll: "checkInOuts", sink: (docs) => {
      todayCheckInOuts = docs;
      renderClientStatePill();
      renderClientTodayFeed();
    }},
    { coll: "mealLog",     sink: (docs) => { todayMeals   = docs; renderClientTodayFeed(); } },
    { coll: "showerLog",   sink: (docs) => { todayShowers = docs; renderClientTodayFeed(); } },
  ];
  for (const { coll, sink } of queries) {
    const q = query(
      collection(db, coll),
      where("clientId", "==", clientId),
      where("eventTime", ">=", todayStart),
      orderBy("eventTime", "desc"),
    );
    const unsub = onSnapshot(q, (snap) => {
      sink(snap.docs.map((d) => ({ id: d.id, data: d.data() })));
    }, (err) => {
      console.warn(`[client-app] ${coll} listener error`, err);
      // Surface so the client doesn't stare at "Loading…" forever.
      const isIndex = (err?.code || "").includes("failed-precondition")
        || /requires an index/i.test(err?.message || "");
      const detail = isIndex
        ? "Database index still building (a few minutes after a deploy). Try again shortly."
        : err?.message || String(err);
      const label = document.getElementById("client-status-label");
      if (label && coll === "checkInOuts") {
        label.textContent = `Couldn't load activity — ${detail}`;
      }
      const feed = document.getElementById("client-today-feed");
      if (feed) {
        feed.innerHTML = `<p class="error">Couldn't load ${coll}: ${escapeHtml(detail)}</p>`;
      }
    });
    clientAppListeners.push(unsub);
  }
}

function renderClientStatePill() {
  const pill = document.getElementById("client-status-pill");
  const label = document.getElementById("client-status-label");
  const outBtn = document.getElementById("client-sign-out-btn");
  const inBtn = document.getElementById("client-sign-in-btn");
  if (!pill || !label) return;
  const latest = todayCheckInOuts[0]?.data;
  pill.classList.remove("is-out", "is-in");
  if (!latest) {
    label.textContent = "No sign-in/out yet today";
    if (outBtn) outBtn.disabled = false;
    if (inBtn)  inBtn.disabled = false;
    return;
  }
  if (latest.direction === "out") {
    pill.classList.add("is-out");
    const reasonLabel = CHECKINOUT_REASONS[latest.reason] || "—";
    label.textContent = `Signed out (${reasonLabel}) at ${fmtClientTimeShort(latest.eventTime)}`;
    if (outBtn) outBtn.disabled = true;
    if (inBtn)  inBtn.disabled = false;
  } else {
    pill.classList.add("is-in");
    label.textContent = `Signed in at ${fmtClientTimeShort(latest.eventTime)}`;
    if (outBtn) outBtn.disabled = false;
    if (inBtn)  inBtn.disabled = true;
  }
}

function renderClientTodayFeed() {
  const feed = document.getElementById("client-today-feed");
  if (!feed) return;
  const events = [
    ...todayCheckInOuts.map(({ id, data }) => ({
      id, time: data.eventTime,
      label: data.direction === "out"
        ? `Signed out · ${CHECKINOUT_REASONS[data.reason] || "—"}`
        : "Signed in",
    })),
    ...todayMeals.map(({ id, data }) => ({
      id, time: data.eventTime,
      label: capitalize(data.meal),
    })),
    ...todayShowers.map(({ id, data }) => ({
      id, time: data.eventTime,
      label: "Shower",
    })),
  ];
  if (!events.length) {
    feed.innerHTML = `<p class="note">No activity yet today.</p>`;
    return;
  }
  events.sort((a, b) => (b.time?.toMillis?.() || 0) - (a.time?.toMillis?.() || 0));
  feed.innerHTML = events.map((e) => `
    <div class="client-feed-row">
      <span>${escapeHtml(e.label)}</span>
      <span class="meta">${escapeHtml(fmtClientTimeShort(e.time))}</span>
    </div>
  `).join("");
}

function showClientActionStatus(text, kind = "ok") {
  const el = document.getElementById("client-action-status");
  if (!el) return;
  el.textContent = text;
  el.classList.remove("ok", "error");
  el.classList.add(kind);
  el.hidden = false;
  setTimeout(() => { el.hidden = true; }, 4000);
}

function wireClientHomeButtons() {
  // Replace each button so handlers don't stack on re-init (clones drop
  // listeners). Cheap; runs only on sign-in.
  const ids = ["client-sign-out-btn", "client-sign-in-btn", "client-shower-btn"];
  for (const id of ids) {
    const old = document.getElementById(id);
    if (!old) continue;
    const fresh = old.cloneNode(true);
    old.parentNode.replaceChild(fresh, old);
  }
  document.querySelectorAll('#client-app-section [data-meal]').forEach((btn) => {
    const fresh = btn.cloneNode(true);
    btn.parentNode.replaceChild(fresh, btn);
  });

  document.getElementById("client-sign-out-btn")?.addEventListener("click", onClientSignOutTap);
  document.getElementById("client-sign-in-btn") ?.addEventListener("click", onClientSignInTap);
  document.getElementById("client-shower-btn")  ?.addEventListener("click", onClientShowerTap);
  document.querySelectorAll('#client-app-section [data-meal]').forEach((btn) => {
    btn.addEventListener("click", () => onClientMealTap(btn.dataset.meal));
  });
}

// Display name for the signed-in client (client-app context). Distinct from
// the existing `clientDisplayName(d)` helper which takes a doc — this one
// reads from the cached master loaded at sign-in.
function currentClientDisplayName() {
  if (!clientAppMaster) return currentUserClientId || "";
  return [clientAppMaster.firstName, clientAppMaster.lastName].filter(Boolean).join(" ")
    || clientAppMaster.clientId;
}

function onClientSignOutTap() {
  if (!currentUserClientId) return;
  openReasonModal({
    clientName: currentClientDisplayName(),
    onConfirm: async ({ reason, reasonNote }) => {
      try {
        await submitCheckInOut({
          clientId: currentUserClientId,
          clientName: currentClientDisplayName(),
          direction: "out",
          reason, reasonNote,
        });
        showClientActionStatus("Signed out.", "ok");
      } catch (err) {
        showClientActionStatus(`Sign-out failed: ${err.message}`, "error");
      }
    },
  });
}

async function onClientSignInTap() {
  if (!currentUserClientId) return;
  try {
    await submitCheckInOut({
      clientId: currentUserClientId,
      clientName: currentClientDisplayName(),
      direction: "in",
    });
    showClientActionStatus("Signed in.", "ok");
  } catch (err) {
    showClientActionStatus(`Sign-in failed: ${err.message}`, "error");
  }
}

async function onClientShowerTap() {
  if (!currentUserClientId) return;
  try {
    await submitShowerLog({
      clientId: currentUserClientId,
      clientName: currentClientDisplayName(),
    });
    showClientActionStatus("Shower logged.", "ok");
  } catch (err) {
    showClientActionStatus(`Could not log shower: ${err.message}`, "error");
  }
}

async function onClientMealTap(meal) {
  if (!currentUserClientId) return;
  try {
    await submitMealLog({
      clientId: currentUserClientId,
      clientName: currentClientDisplayName(),
      meal,
    });
    showClientActionStatus(`${capitalize(meal)} logged.`, "ok");
  } catch (err) {
    showClientActionStatus(`Could not log ${meal}: ${err.message}`, "error");
  }
}

// ============================================================
// Client weekly-schedule submission (§13.11 deferred → 2026-05-08)
// ============================================================
//
// Clients author a week's events in their app and submit; the doc lands in
// pendingClientSubmissions/{auto} with status="pending". Staff review in the
// Inbox tab (below) and approve (transactional copy into the canonical
// clientWeeklySchedule/{cid}-{weekStart}) or reject (with optional note).
// Mid-week schedule updates use the same submission shape — they just target
// the current week instead of next.

const CLIENT_SUB_TYPES = {
  weeklySchedule: "Weekly schedule",
  infoUpdate: "Info update",
  staffRequest: "Help request",
};

// Subjects clients can pick when filing a "help request" for staff.
// Stored keys are stable; labels can be reworded without breaking history.
const REQUEST_SUBJECT_LABELS = {
  school:             "School",
  veteransBenefits:   "Veterans Benefits",
  socialSecurity:     "Social Security",
  employment:         "Employment",
  identificationDocs: "Identification Documents",
  housing:            "Housing",
  legal:              "Legal",
  medical:            "Medical",
  counseling:         "Counseling",
  other:              "Other",
};

// Update types a client may self-report. Mirrors STATUS_UPDATE_TYPE_LABELS but
// excludes purely staff-tracked categories (none today — keep them aligned).
// On approval, the same dot-path mirror onto clients/{cid}.{category}s.{type}
// runs as the staff status-update flow.
const CLIENT_INFO_UPDATE_TYPES = [
  { group: "Documents", types: [
    "socialSecurityCard", "birthCertificate", "stateId",
    "hsDiploma", "hsTranscript", "collegeDiploma", "collegeTranscript",
    "medicalInsurance", "vaCard", "dd214", "voterRegistration",
  ]},
  { group: "Healthcare", types: ["connectedDoctor", "connectedCounselor"] },
  { group: "Benefits", types: [
    "foodStamps", "ssi", "ssdi", "rsdi", "vaDisability", "vaRetirement",
    "retirement", "workersComp", "tribalBenefits", "otherBenefit",
  ]},
  { group: "Milestones", types: [
    "employment", "housing", "bankAccount", "phone", "startedSchool",
    "sobrietyMilestone", "programCompletion", "lostEmployment",
  ]},
];

let clientScheduleDraft = []; // local edit buffer
let clientScheduleWeek = null;
let clientSubmissionsUnsub = null;

function ensureClientScheduleWeekDefault() {
  if (clientScheduleWeek) return;
  // Default to NEXT Monday — schedules are submitted ahead.
  const todayMonday = mondayOf(new Date());
  clientScheduleWeek = addDays(todayMonday, 7);
}

function setClientScheduleWeek(weekStart) {
  clientScheduleWeek = mondayOf(weekStart);
  const inp = document.getElementById("client-schedule-week");
  if (inp) inp.value = clientScheduleWeek;
  // Pre-fill from the latest submission for that week (if any) so clients
  // can revise after rejection without retyping.
  prefillClientScheduleFromLatest(clientScheduleWeek);
  renderClientScheduleEditor();
}

async function prefillClientScheduleFromLatest(weekStart) {
  if (!currentUserClientId) return;
  try {
    const q = query(
      collection(db, "pendingClientSubmissions"),
      where("clientId", "==", currentUserClientId),
      orderBy("submittedAt", "desc"),
      limit(20),
    );
    const snap = await getDocs(q);
    const match = snap.docs.find((d) => d.data().weekStart === weekStart);
    if (match) {
      const data = match.data();
      clientScheduleDraft = (data.events || []).map((e) => ({ ...e }));
      const statusEl = document.getElementById("client-schedule-status");
      if (statusEl) {
        const statusText = data.status === "rejected"
          ? `Last submission for this week was rejected${data.reviewNote ? `: ${data.reviewNote}` : ". Update and resubmit."}`
          : data.status === "approved"
            ? "An earlier submission for this week was approved. Submitting again will create a new pending request."
            : "A submission for this week is pending review.";
        statusEl.textContent = statusText;
        statusEl.className = `is-${data.status}`;
      }
    } else {
      clientScheduleDraft = [];
      const statusEl = document.getElementById("client-schedule-status");
      if (statusEl) { statusEl.textContent = ""; statusEl.className = ""; }
    }
  } catch (err) {
    console.warn("[client-schedule] prefill failed", err);
  }
  renderClientScheduleEditor();
}

function renderClientScheduleEditor() {
  const root = document.getElementById("client-schedule-events");
  if (!root) return;
  if (!clientScheduleDraft.length) {
    root.innerHTML = `<p class="note">No events yet. Tap "Add event" to start.</p>`;
    return;
  }
  root.innerHTML = clientScheduleDraft.map((ev, i) => `
    <div class="client-event-row" data-i="${i}">
      <select data-field="day">
        <option value=""${!ev.day ? " selected" : ""}>Day</option>
        ${DAYS.map((d) => `<option value="${d}"${ev.day === d ? " selected" : ""}>${DAY_LABELS[d]}</option>`).join("")}
      </select>
      <input type="time" data-field="startTime" value="${escapeHtml(ev.startTime || "")}" />
      <input type="time" data-field="endTime" value="${escapeHtml(ev.endTime || "")}" />
      <select data-field="type">
        ${EVENT_TYPES.map((t) => `<option value="${t}"${ev.type === t ? " selected" : ""}>${EVENT_TYPE_LABELS[t]}</option>`).join("")}
      </select>
      <div class="event-row-second">
        <input type="text" data-field="title" placeholder="Title (e.g. Doctor appt — Dr. Smith)" value="${escapeHtml(ev.title || "")}" />
        <button type="button" class="event-remove" aria-label="Remove">&times;</button>
      </div>
    </div>
  `).join("");

  root.querySelectorAll(".client-event-row").forEach((row) => {
    const i = Number(row.dataset.i);
    row.querySelectorAll("[data-field]").forEach((inp) => {
      inp.addEventListener("input", () => {
        clientScheduleDraft[i] = { ...clientScheduleDraft[i], [inp.dataset.field]: inp.value };
      });
    });
    row.querySelector(".event-remove").addEventListener("click", () => {
      clientScheduleDraft.splice(i, 1);
      renderClientScheduleEditor();
    });
  });
}

let clientScheduleControlsBound = false;
function bindClientScheduleControls() {
  if (clientScheduleControlsBound) return;
  clientScheduleControlsBound = true;
  const weekInput = document.getElementById("client-schedule-week");
  const thisBtn = document.getElementById("client-schedule-this-week");
  const nextBtn = document.getElementById("client-schedule-next-week");
  const addBtn = document.getElementById("client-schedule-add-btn");
  const submitBtn = document.getElementById("client-schedule-submit-btn");
  const msg = document.getElementById("client-schedule-msg");
  if (!weekInput || !addBtn || !submitBtn) return;

  weekInput.addEventListener("change", () => {
    if (weekInput.value) setClientScheduleWeek(weekInput.value);
  });
  thisBtn.addEventListener("click", () => setClientScheduleWeek(mondayOf(new Date())));
  nextBtn.addEventListener("click", () => setClientScheduleWeek(addDays(mondayOf(new Date()), 7)));

  addBtn.addEventListener("click", () => {
    clientScheduleDraft.push({
      day: "", startTime: "", endTime: "",
      type: "appointment", title: "", location: "", notes: "",
    });
    renderClientScheduleEditor();
  });

  submitBtn.addEventListener("click", async () => {
    msg.hidden = true;
    msg.classList.remove("ok", "error");
    if (!currentUserClientId) return;
    if (!clientScheduleWeek) {
      msg.textContent = "Pick a week first.";
      msg.classList.add("error"); msg.hidden = false;
      return;
    }
    const events = clientScheduleDraft
      .map((e) => ({
        day: (e.day || "").trim(),
        startTime: (e.startTime || "").trim(),
        endTime: (e.endTime || "").trim(),
        type: (e.type || "other").trim(),
        title: (e.title || "").trim(),
        location: (e.location || "").trim(),
        notes: (e.notes || "").trim(),
      }))
      .filter((e) => e.day && e.startTime && e.endTime);
    if (!events.length) {
      msg.textContent = "Add at least one event with a day and start/end time.";
      msg.classList.add("error"); msg.hidden = false;
      return;
    }
    submitBtn.disabled = true;
    submitBtn.textContent = "Submitting…";
    try {
      const ref = await addDoc(collection(db, "pendingClientSubmissions"), {
        clientId: currentUserClientId,
        clientName: currentClientDisplayName(),
        submissionType: "weeklySchedule",
        status: "pending",
        weekStart: clientScheduleWeek,
        events,
        submittedBy: currentUserClientId,
        submittedAt: serverTimestamp(),
        reviewedAt: null, reviewedBy: null, reviewNote: null,
      });
      await logAccess(AUDIT_ACTIONS.CREATE, "pendingClientSubmission", ref.id, {
        clientId: currentUserClientId,
        submissionType: "weeklySchedule",
        weekStart: clientScheduleWeek,
        eventCount: events.length,
      });
      msg.textContent = "Submitted. A staff member will review it.";
      msg.classList.add("ok"); msg.hidden = false;
      // Don't clear the draft — let the prefill mechanism mark it pending so
      // the client sees "pending review" status next time they open the
      // section.
      setTimeout(() => prefillClientScheduleFromLatest(clientScheduleWeek), 800);
    } catch (err) {
      msg.textContent = `Submit failed: ${err.message || err}`;
      msg.classList.add("error"); msg.hidden = false;
    } finally {
      submitBtn.disabled = false;
      submitBtn.textContent = "Submit for approval";
    }
  });
}

// ----- Client info-update submission (Plan §11 / §7 forms inventory) -----
//
// Same `pendingClientSubmissions` pattern as the weekly schedule, different
// `submissionType: "infoUpdate"`. Carries a single status-update fact
// (updateType + occurredOn + optional notes). Staff approve → the same write
// path as the staff status-update form: addDoc to clientStatusUpdates +
// dot-path mirror onto clients/{cid}.{category}s.{updateType}.

let clientInfoUpdateBound = false;
function bindClientInfoUpdateForm() {
  if (clientInfoUpdateBound) return;
  const sel = document.getElementById("client-info-update-type");
  const dateEl = document.getElementById("client-info-update-date");
  const notesEl = document.getElementById("client-info-update-notes");
  const submitBtn = document.getElementById("client-info-update-submit-btn");
  const msg = document.getElementById("client-info-update-msg");
  if (!sel || !dateEl || !submitBtn || !msg) return;
  clientInfoUpdateBound = true;

  // Populate the dropdown grouped by category.
  sel.innerHTML = `<option value="">— pick one —</option>` + CLIENT_INFO_UPDATE_TYPES
    .map((g) => `<optgroup label="${escapeHtml(g.group)}">${
      g.types.map((t) => `<option value="${escapeHtml(t)}">${escapeHtml(STATUS_UPDATE_TYPE_LABELS[t] || t)}</option>`).join("")
    }</optgroup>`)
    .join("");

  if (!dateEl.value) dateEl.value = todayLocalDate();

  submitBtn.addEventListener("click", async () => {
    msg.hidden = true;
    msg.classList.remove("ok", "error");
    if (!currentUserClientId) return;
    const updateType = sel.value;
    const occurredOnStr = dateEl.value;
    const notes = (notesEl?.value || "").trim();
    if (!updateType || !STATUS_UPDATE_TYPE_LABELS[updateType]) {
      msg.textContent = "Pick what changed.";
      msg.classList.add("error"); msg.hidden = false;
      return;
    }
    const occurredOnDate = occurredOnStr ? new Date(occurredOnStr + "T00:00:00") : null;
    if (!occurredOnDate || isNaN(occurredOnDate)) {
      msg.textContent = "Pick a valid date.";
      msg.classList.add("error"); msg.hidden = false;
      return;
    }
    submitBtn.disabled = true;
    submitBtn.textContent = "Submitting…";
    try {
      const ref = await addDoc(collection(db, "pendingClientSubmissions"), {
        clientId: currentUserClientId,
        clientName: currentClientDisplayName(),
        submissionType: "infoUpdate",
        status: "pending",
        updateType,
        occurredOn: Timestamp.fromDate(occurredOnDate),
        notes: notes || null,
        submittedBy: currentUserClientId,
        submittedAt: serverTimestamp(),
        reviewedAt: null, reviewedBy: null, reviewNote: null,
      });
      await logAccess(AUDIT_ACTIONS.CREATE, "pendingClientSubmission", ref.id, {
        clientId: currentUserClientId,
        submissionType: "infoUpdate",
        updateType,
      });
      msg.textContent = "Submitted. A staff member will review it.";
      msg.classList.add("ok"); msg.hidden = false;
      sel.value = "";
      if (notesEl) notesEl.value = "";
      dateEl.value = todayLocalDate();
    } catch (err) {
      msg.textContent = `Submit failed: ${err.message || err}`;
      msg.classList.add("error"); msg.hidden = false;
    } finally {
      submitBtn.disabled = false;
      submitBtn.textContent = "Submit for approval";
    }
  });
}

// ----- Client app: staff help request submission -----
//
// Same `pendingClientSubmissions` pattern as the weekly schedule / info
// update, different `submissionType: "staffRequest"`. Carries a subject
// (one of REQUEST_SUBJECT_LABELS keys) and a free-text description. Staff
// approval only flips status — nothing mirrors to the canonical client
// record. Approved requests get a Print button in the staff inbox.

let clientStaffRequestBound = false;
function bindClientStaffRequestForm() {
  if (clientStaffRequestBound) return;
  const sel = document.getElementById("client-staff-request-subject");
  const descEl = document.getElementById("client-staff-request-description");
  const submitBtn = document.getElementById("client-staff-request-submit-btn");
  const msg = document.getElementById("client-staff-request-msg");
  if (!sel || !descEl || !submitBtn || !msg) return;
  clientStaffRequestBound = true;

  sel.innerHTML = `<option value="">— pick one —</option>` + Object.entries(REQUEST_SUBJECT_LABELS)
    .map(([k, label]) => `<option value="${escapeHtml(k)}">${escapeHtml(label)}</option>`)
    .join("");

  submitBtn.addEventListener("click", async () => {
    msg.hidden = true;
    msg.classList.remove("ok", "error");
    if (!currentUserClientId) return;
    const subject = sel.value;
    const description = (descEl.value || "").trim();
    if (!subject || !REQUEST_SUBJECT_LABELS[subject]) {
      msg.textContent = "Pick what you need help with.";
      msg.classList.add("error"); msg.hidden = false;
      return;
    }
    if (!description) {
      msg.textContent = "Describe what you're asking for.";
      msg.classList.add("error"); msg.hidden = false;
      return;
    }
    if (description.length > 4000) {
      msg.textContent = "Description is too long (4000 character limit).";
      msg.classList.add("error"); msg.hidden = false;
      return;
    }
    submitBtn.disabled = true;
    submitBtn.textContent = "Submitting…";
    try {
      const ref = await addDoc(collection(db, "pendingClientSubmissions"), {
        clientId: currentUserClientId,
        clientName: currentClientDisplayName(),
        submissionType: "staffRequest",
        status: "pending",
        subject,
        description,
        submittedBy: currentUserClientId,
        submittedAt: serverTimestamp(),
        reviewedAt: null, reviewedBy: null, reviewNote: null,
      });
      await logAccess(AUDIT_ACTIONS.CREATE, "pendingClientSubmission", ref.id, {
        clientId: currentUserClientId,
        submissionType: "staffRequest",
        subject,
      });
      msg.textContent = "Submitted. A staff member will review it.";
      msg.classList.add("ok"); msg.hidden = false;
      sel.value = "";
      descEl.value = "";
    } catch (err) {
      msg.textContent = `Submit failed: ${err.message || err}`;
      msg.classList.add("error"); msg.hidden = false;
    } finally {
      submitBtn.disabled = false;
      submitBtn.textContent = "Submit request";
    }
  });
}

// ----- Client app: scanned-documents view (read-only) -----
//
// Subscribes to clients/{cid}/scannedDocs so a client can pull copies of
// their own ID, SSC, transcripts, etc. from the client app. Same renderer
// as the staff side — staffMode=false hides upload-by and admin-only
// delete controls. Each "View" tap routes through viewScannedDocFile,
// which writes a 'view' accessLog entry tagged surface=client-app.
let clientAppDocsUnsub = null;
function startClientAppDocsListener(clientId) {
  if (clientAppDocsUnsub) { clientAppDocsUnsub(); clientAppDocsUnsub = null; }
  const q = collection(db, "clients", clientId, "scannedDocs");
  clientAppDocsUnsub = onSnapshot(q, (snap) => {
    const el = document.getElementById("client-app-documents");
    if (!el) return;
    const rows = snap.docs
      .map((d) => ({ id: d.id, data: d.data() }))
      .sort((a, b) => {
        const ua = a.data.uploadedAt?.toMillis ? a.data.uploadedAt.toMillis() : 0;
        const ub = b.data.uploadedAt?.toMillis ? b.data.uploadedAt.toMillis() : 0;
        return ub - ua;
      });
    renderScannedDocsList(el, clientId, rows, /* staffMode */ false);
  }, (err) => {
    console.warn("[client-app] documents listener error", err);
    const el = document.getElementById("client-app-documents");
    if (el) el.innerHTML = `<p class="error">Couldn't load documents: ${escapeHtml(err?.message || String(err))}</p>`;
  });
  clientAppListeners.push(() => {
    if (clientAppDocsUnsub) { clientAppDocsUnsub(); clientAppDocsUnsub = null; }
  });
}

// Click delegation for the client-app section (mirrors the staff-detail
// delegation above). Only "View front" / "View back" do anything for
// clients — no upload, no delete buttons render in client mode.
document.getElementById("client-app-section")?.addEventListener("click", (e) => {
  const viewDocBtn = e.target.closest('[data-action="view-doc"]');
  if (!viewDocBtn) return;
  viewScannedDocFile(
    viewDocBtn.dataset.cid,
    viewDocBtn.dataset.docId,
    viewDocBtn.dataset.side,
    viewDocBtn.dataset.docType,
  );
});

// ----- My schedule (approved personal events + assigned thrift shifts) -----
//
// Two weeks shown: the current Mon-Sun week (where clients are mid-week) and
// the immediately preceding Mon-Sun week (so a Monday morning view still has
// last week's context). Source data:
//   - clientWeeklySchedule/{cid}-{weekStart} — personal approved events.
//   - thriftStoreSchedule/{weekStart}.shifts — filtered to this client.
// Other clients' thrift shifts exist in the wire payload but are filtered
// out before rendering (privacy posture confirmed acceptable 2026-05-20).

function startClientMyScheduleListener(clientId) {
  // Tear down any previous listeners + reset slot state so a re-init doesn't
  // render stale data while the new snapshots arrive.
  if (clientMyScheduleAllUnsub) { try { clientMyScheduleAllUnsub(); } catch {} }
  clientMyScheduleAllUnsub = null;
  clientMyScheduleThriftUnsubs.forEach((u) => { try { u(); } catch {} });
  clientMyScheduleThriftUnsubs = [];
  clientMySchedulePersonalAll = [];
  clientMyScheduleThrift = { thisWeek: null, lastWeek: null };

  clientMyScheduleThisWeekStart = mondayOf(new Date());
  clientMyScheduleLastWeekStart = addDays(clientMyScheduleThisWeekStart, -7);

  const personalQ = query(
    collection(db, "clientWeeklySchedule"),
    where("clientId", "==", clientId),
  );
  clientMyScheduleAllUnsub = onSnapshot(personalQ, (snap) => {
    clientMySchedulePersonalAll = snap.docs.map((d) => ({ id: d.id, data: d.data() }));
    renderClientMySchedule();
  }, (err) => {
    console.warn("[client-app] my-schedule personal listener error", err);
    renderClientMyScheduleError(err);
  });

  const buckets = [
    { key: "thisWeek", weekStart: clientMyScheduleThisWeekStart },
    { key: "lastWeek", weekStart: clientMyScheduleLastWeekStart },
  ];
  for (const { key, weekStart } of buckets) {
    const unsub = onSnapshot(doc(db, "thriftStoreSchedule", weekStart), (snap) => {
      clientMyScheduleThrift[key] = snap.exists() ? snap.data() : null;
      renderClientMySchedule();
    }, (err) => {
      console.warn(`[client-app] my-schedule thrift ${key} listener error`, err);
      renderClientMyScheduleError(err);
    });
    clientMyScheduleThriftUnsubs.push(unsub);
  }

  clientAppListeners.push(() => {
    if (clientMyScheduleAllUnsub) { try { clientMyScheduleAllUnsub(); } catch {} }
    clientMyScheduleAllUnsub = null;
    clientMyScheduleThriftUnsubs.forEach((u) => { try { u(); } catch {} });
    clientMyScheduleThriftUnsubs = [];
  });

  // Paint headings once so the user sees the date range even before snapshots arrive.
  renderClientMySchedule();
}

function renderClientMyScheduleError(err) {
  const isIndex = (err?.code || "").includes("failed-precondition")
    || /requires an index/i.test(err?.message || "");
  const detail = isIndex
    ? "Database index still building (a few minutes after a deploy). Try again shortly."
    : err?.message || String(err);
  const html = `<p class="error">Couldn't load schedule: ${escapeHtml(detail)}</p>`;
  const thisEl = document.getElementById("client-my-schedule-this-week");
  const lastEl = document.getElementById("client-my-schedule-last-week");
  if (thisEl) thisEl.innerHTML = html;
  if (lastEl) lastEl.innerHTML = html;
}

function renderClientMySchedule() {
  const thisEl = document.getElementById("client-my-schedule-this-week");
  const lastEl = document.getElementById("client-my-schedule-last-week");
  if (!thisEl || !lastEl) return;
  const thisHead = document.getElementById("client-my-schedule-this-week-heading");
  const lastHead = document.getElementById("client-my-schedule-last-week-heading");
  if (thisHead) thisHead.textContent = clientMyScheduleThisWeekStart
    ? `This week — ${formatClientWeekRange(clientMyScheduleThisWeekStart)}`
    : "This week";
  if (lastHead) lastHead.textContent = clientMyScheduleLastWeekStart
    ? `Last week — ${formatClientWeekRange(clientMyScheduleLastWeekStart)}`
    : "Last week";
  thisEl.innerHTML = renderClientMyScheduleWeekHtml(clientMyScheduleThisWeekStart, "thisWeek");
  lastEl.innerHTML = renderClientMyScheduleWeekHtml(clientMyScheduleLastWeekStart, "lastWeek");
}

function renderClientMyScheduleWeekHtml(weekStart, thriftKey) {
  if (!weekStart) return `<p class="note">Loading…</p>`;
  const personalDoc = clientMySchedulePersonalAll.find((d) => d.data.weekStart === weekStart);
  const personalEvents = (personalDoc?.data.events || []).map((e) => ({
    kind: "personal",
    day: e.day,
    startTime: e.startTime || "",
    endTime: e.endTime || "",
    type: e.type || "",
    title: e.title || "",
    location: e.location || "",
    notes: e.notes || "",
  }));
  const thriftDoc = clientMyScheduleThrift[thriftKey];
  // Each shift can have two assigned clients (clientId / clientId2); pull the
  // role from whichever slot this client is in.
  const myThrift = (thriftDoc?.shifts || [])
    .filter((s) => s.clientId === currentUserClientId || s.clientId2 === currentUserClientId)
    .map((s) => ({
      kind: "thrift",
      day: s.day,
      startTime: s.startTime || "",
      endTime: s.endTime || "",
      role: (s.clientId === currentUserClientId ? s.role : s.role2) || "",
    }));
  const all = [...personalEvents, ...myThrift];
  if (all.length === 0) {
    return `<p class="note">Nothing scheduled this week yet.</p>`;
  }
  const byDay = new Map(DAYS.map((d) => [d, []]));
  for (const ev of all) {
    if (!byDay.has(ev.day)) continue;
    byDay.get(ev.day).push(ev);
  }
  let html = "";
  for (const day of DAYS) {
    const rows = byDay.get(day);
    if (!rows.length) continue;
    rows.sort((a, b) => (timeToMinutes(a.startTime) ?? 0) - (timeToMinutes(b.startTime) ?? 0));
    html += `<div class="client-myschedule-day"><div class="client-myschedule-day-label">${escapeHtml(DAY_LABELS[day])}</div>`;
    for (const r of rows) {
      const time = r.startTime && r.endTime
        ? `${formatTime12(r.startTime)}–${formatTime12(r.endTime)}`
        : (r.startTime ? formatTime12(r.startTime) : "—");
      let label;
      if (r.kind === "thrift") {
        label = `<span class="myschedule-thrift-chip">Thrift store shift</span>${r.role ? ` — ${escapeHtml(r.role)}` : ""}`;
      } else {
        const typeLabel = EVENT_TYPE_LABELS[r.type] || r.type || "Event";
        const titlePart = r.title ? ` — ${escapeHtml(r.title)}` : "";
        const locPart = r.location ? ` <span class="meta">(${escapeHtml(r.location)})</span>` : "";
        label = `${escapeHtml(typeLabel)}${titlePart}${locPart}`;
      }
      html += `<div class="client-myschedule-row"><span class="meta">${escapeHtml(time)}</span><span>${label}</span></div>`;
    }
    html += `</div>`;
  }
  return html;
}

function formatClientWeekRange(weekStart) {
  if (!weekStart) return "";
  const end = addDays(weekStart, 6);
  const fmt = (s) => {
    const [y, m, d] = s.split("-").map(Number);
    return new Date(y, m - 1, d).toLocaleDateString(undefined, { month: "short", day: "numeric" });
  };
  return `${fmt(weekStart)} – ${fmt(end)}`;
}

function startClientSubmissionsListener(clientId) {
  if (clientSubmissionsUnsub) { clientSubmissionsUnsub(); clientSubmissionsUnsub = null; }
  const q = query(
    collection(db, "pendingClientSubmissions"),
    where("clientId", "==", clientId),
    orderBy("submittedAt", "desc"),
    limit(10),
  );
  clientSubmissionsUnsub = onSnapshot(q, (snap) => {
    renderClientSubmissionsList(snap.docs.map((d) => ({ id: d.id, data: d.data() })));
  }, (err) => {
    console.warn("[client-app] submissions listener error", err);
    const el = document.getElementById("client-submissions-list");
    const isIndex = (err?.code || "").includes("failed-precondition")
      || /requires an index/i.test(err?.message || "");
    if (el) {
      el.innerHTML = isIndex
        ? `<p class="error">Database index still building (a few minutes after a deploy). Try again shortly.</p>`
        : `<p class="error">Couldn't load submissions: ${escapeHtml(err?.message || String(err))}</p>`;
    }
  });
  clientAppListeners.push(() => {
    if (clientSubmissionsUnsub) { clientSubmissionsUnsub(); clientSubmissionsUnsub = null; }
  });
}

// One-line description of a pending submission, used in the client app's
// "My recent submissions" feed and the staff Inbox header line.
function describeSubmission(data) {
  if (data.submissionType === "weeklySchedule") {
    const n = data.events?.length || 0;
    return `Week of ${escapeHtml(data.weekStart || "—")} · ${n} event${n === 1 ? "" : "s"}`;
  }
  if (data.submissionType === "infoUpdate") {
    const label = STATUS_UPDATE_TYPE_LABELS[data.updateType] || data.updateType || "(unknown)";
    const when = fmtDate(data.occurredOn) || "—";
    return `${escapeHtml(label)} · ${escapeHtml(when)}`;
  }
  if (data.submissionType === "staffRequest") {
    const subj = REQUEST_SUBJECT_LABELS[data.subject] || data.subject || "(no subject)";
    const preview = (data.description || "").replace(/\s+/g, " ").slice(0, 80);
    return `${escapeHtml(subj)}${preview ? ` — ${escapeHtml(preview)}` : ""}`;
  }
  return "";
}

function renderClientSubmissionsList(rows) {
  const el = document.getElementById("client-submissions-list");
  if (!el) return;
  if (!rows.length) {
    el.innerHTML = `<p class="note">No submissions yet.</p>`;
    return;
  }
  el.innerHTML = rows.map(({ id, data }) => {
    const submittedAt = data.submittedAt?.toDate ? data.submittedAt.toDate().toLocaleDateString() : "—";
    const kindLabel = CLIENT_SUB_TYPES[data.submissionType] || data.submissionType;
    const detail = describeSubmission(data);
    const statusBg = data.status === "approved" ? "is-approved"
      : data.status === "rejected" ? "is-rejected" : "is-pending";
    const noteHtml = data.reviewNote
      ? `<p class="note" style="margin: 0.3rem 0 0;">Staff note: ${escapeHtml(data.reviewNote)}</p>` : "";
    return `
      <div class="client-feed-row" style="display:block;" data-status="${escapeHtml(data.status)}">
        <div style="display:flex;justify-content:space-between;gap:0.5rem;flex-wrap:wrap;">
          <strong>${escapeHtml(kindLabel)}</strong>
          <span class="meta">${escapeHtml(submittedAt)} · ${escapeHtml(data.status)}</span>
        </div>
        <div class="meta">${detail}</div>
        ${noteHtml}
      </div>`;
  }).join("");
}

// ============================================================
// Staff Inbox — pending client submissions (§13.11 deferred → 2026-05-08)
// ============================================================
//
// Live listener on pendingClientSubmissions. Pending shown by default;
// a toggle switches to the last 30 of any status so staff can revisit
// recent decisions. Approve → runTransaction copies the events array
// into clientWeeklySchedule/{cid}-{weekStart} (set+merge so existing
// staff edits survive) and flips status="approved". Reject → updateDoc
// sets status="rejected" + reviewNote. Both write audit entries.

let inboxUnsub = null;
let inboxRows = [];
let inboxFilter = "pending";

function stopInboxListener() {
  if (inboxUnsub) { inboxUnsub(); inboxUnsub = null; }
}

function startInboxListener() {
  stopInboxListener();
  // Subscribe to pending OR last-30; we re-subscribe when the filter toggles.
  const q = inboxFilter === "pending"
    ? query(
        collection(db, "pendingClientSubmissions"),
        where("status", "==", "pending"),
        orderBy("submittedAt", "desc"),
        limit(50),
      )
    : query(
        collection(db, "pendingClientSubmissions"),
        orderBy("submittedAt", "desc"),
        limit(30),
      );
  inboxUnsub = onSnapshot(q, async (snap) => {
    inboxRows = snap.docs.map((d) => ({ id: d.id, data: d.data() }));
    renderInbox();
    refreshInboxBadge();
    // Background: fetch the current canonical schedule for each pending
    // weekly-schedule row so we can show staff a diff of what will change on
    // approve. Re-renders when done. One-shot reads — Inbox is small.
    await hydrateInboxCanonicalEvents();
    renderInbox();
  }, (err) => {
    console.warn("[inbox] listener error", err);
    const el = document.getElementById("inbox-status");
    if (el) {
      el.textContent = `Could not load inbox: ${err.message}`;
      el.classList.add("error");
    }
  });
}

function refreshInboxBadge() {
  // Badge only counts pending. When filter is "all", we re-derive from rows.
  const badge = document.getElementById("inbox-pending-badge");
  if (!badge) return;
  let pendingCount;
  if (inboxFilter === "pending") {
    pendingCount = inboxRows.length;
  } else {
    pendingCount = inboxRows.filter((r) => r.data.status === "pending").length;
  }
  if (pendingCount > 0) {
    badge.textContent = String(pendingCount);
    badge.hidden = false;
  } else {
    badge.hidden = true;
  }
}

function renderInbox() {
  const list = document.getElementById("inbox-list");
  const status = document.getElementById("inbox-status");
  if (!list) return;
  if (!inboxRows.length) {
    if (status) {
      status.textContent = inboxFilter === "pending"
        ? "Inbox clear — no pending submissions."
        : "No recent submissions.";
      status.classList.remove("error");
    }
    list.innerHTML = "";
    return;
  }
  if (status) status.textContent = "";

  list.innerHTML = inboxRows.map(({ id, data }) => {
    const submittedAt = data.submittedAt?.toDate
      ? data.submittedAt.toDate().toLocaleString()
      : "—";
    const reviewedAt = data.reviewedAt?.toDate
      ? data.reviewedAt.toDate().toLocaleString()
      : null;
    const kindLabel = CLIENT_SUB_TYPES[data.submissionType] || data.submissionType;
    const bodyHtml = data.submissionType === "infoUpdate"
      ? renderInfoUpdateBody(data)
      : data.submissionType === "staffRequest"
        ? renderStaffRequestBody(data)
        : renderWeeklyScheduleBody(data);

    const conflicts = computeSubmissionConflicts(data);
    const conflictsHtml = conflicts.length
      ? `<div class="inbox-row-conflicts">${
          conflicts.map((c) => escapeHtml(c)).join("<br>")
        }</div>`
      : "";

    const reviewNoteHtml = data.reviewNote
      ? `<p class="note" style="margin-top:0.3rem;">Note: ${escapeHtml(data.reviewNote)}</p>`
      : "";

    const approveLabel = data.submissionType === "infoUpdate"
      ? "Approve &amp; record"
      : data.submissionType === "staffRequest"
        ? "Approve"
        : "Approve &amp; copy to schedule";
    const printBtnHtml = data.submissionType === "staffRequest" && data.status === "approved"
      ? ` <button class="ghost" data-act="print" data-id="${escapeHtml(id)}" type="button">Print request</button>`
      : "";
    const actionsHtml = data.status === "pending"
      ? `<div class="inbox-row-actions">
           <button class="approve" data-act="approve" data-id="${escapeHtml(id)}" type="button">${approveLabel}</button>
           <button class="reject"  data-act="reject"  data-id="${escapeHtml(id)}" type="button">Reject…</button>
         </div>`
      : `<div class="inbox-row-actions"><span class="meta">${escapeHtml(data.status)}${reviewedAt ? ` · ${escapeHtml(reviewedAt)} · ${escapeHtml(data.reviewedBy || "")}` : ""}</span>${printBtnHtml}</div>`;

    const headerSuffix = data.submissionType === "weeklySchedule"
      ? ` · week of ${escapeHtml(data.weekStart || "—")}`
      : data.submissionType === "infoUpdate"
        ? ` · ${escapeHtml(STATUS_UPDATE_TYPE_LABELS[data.updateType] || data.updateType || "info update")}`
        : data.submissionType === "staffRequest"
          ? ` · ${escapeHtml(REQUEST_SUBJECT_LABELS[data.subject] || data.subject || "request")}`
          : "";

    return `
      <div class="inbox-row is-${escapeHtml(data.status)}">
        <div class="inbox-row-head">
          <strong>${escapeHtml(data.clientName || data.clientId)}</strong>
          <span class="meta">${escapeHtml(kindLabel)}${headerSuffix} · submitted ${escapeHtml(submittedAt)}</span>
        </div>
        <div class="meta">Client ID: <code>${escapeHtml(data.clientId)}</code></div>
        ${bodyHtml}
        ${conflictsHtml}
        ${reviewNoteHtml}
        ${actionsHtml}
      </div>`;
  }).join("");

  list.querySelectorAll("[data-act]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const act = btn.dataset.act;
      const id = btn.dataset.id;
      if (act === "approve") {
        const row = inboxRows.find((r) => r.id === id);
        const isWeekly = row?.data.submissionType === "weeklySchedule";
        const msg = isWeekly
          ? "Approve this submission? The submitted events replace the canonical schedule wholesale — review the diff above before confirming."
          : "Approve this submission?";
        if (!confirm(msg)) return;
        await approveSubmission(id, btn);
      } else if (act === "reject") {
        const note = (window.prompt("Optional note for the client (why rejected). Leave blank to skip.") || "").trim();
        await rejectSubmission(id, note, btn);
      } else if (act === "print") {
        const row = inboxRows.find((r) => r.id === id);
        if (row) printStaffRequest(row.id, row.data);
      }
    });
  });
}

// Conflict checks for a pending submission. For "weeklySchedule":
//   1. Intra-submission overlaps (two submitted events on the same day).
//   2. Cross-canonical: submitted events that overlap a thrift shift this
//      client is already on the canonical thrift schedule for that week
//      (hydrated by hydrateInboxCanonicalEvents). Staff still has the
//      override — approve will replace the weekly schedule but won't touch
//      the thrift shift, so the conflict stays after approve unless staff
//      also edits the thrift schedule.
function computeSubmissionConflicts(data) {
  if (data.submissionType !== "weeklySchedule") return [];
  const out = [];
  const events = data.events || [];
  // (1) intra-submission
  for (let i = 0; i < events.length; i++) {
    for (let j = i + 1; j < events.length; j++) {
      if (eventsOverlap(events[i], events[j])) {
        out.push(`Overlap: ${DAY_LABELS[events[i].day] || events[i].day} ${formatTime12(events[i].startTime)}–${formatTime12(events[i].endTime)} vs ${formatTime12(events[j].startTime)}–${formatTime12(events[j].endTime)}`);
      }
    }
  }
  // (2) cross-canonical vs canonical thrift shifts for this client+week
  const thriftShifts = Array.isArray(data.__canonicalThriftShifts) ? data.__canonicalThriftShifts : [];
  for (const shift of thriftShifts) {
    for (const ev of events) {
      if (eventsOverlap(shift, ev)) {
        const day = DAY_LABELS[shift.day] || shift.day || "—";
        const evDesc = ev.title || EVENT_TYPE_LABELS[ev.type] || ev.type || "event";
        const role = shift.role ? ` (${shift.role})` : "";
        out.push(`Thrift conflict: ${day} ${formatTime12(shift.startTime)}–${formatTime12(shift.endTime)} thrift shift${role} vs ${formatTime12(ev.startTime)}–${formatTime12(ev.endTime)} ${evDesc}`);
      }
    }
  }
  return out;
}

function renderWeeklyScheduleBody(data) {
  const submitted = data.events || [];
  const submittedHtml = submitted.length
    ? `<ul>${submitted.map(formatEventLi).join("")}</ul>`
    : `<p class="note">No events.</p>`;

  // If we've loaded the current canonical schedule (status=pending only),
  // surface a diff so staff sees exactly what approving will change. Approve
  // is still a wholesale events-array replace — the diff is *informational*,
  // not a per-event merge. Plan §11 / BUILD_LOG §13.12.
  const canonical = data.__canonicalEvents;
  let diffHtml = "";
  if (Array.isArray(canonical) && data.status === "pending") {
    const diff = diffEventLists(canonical, submitted);
    const counts = `${diff.added.length} new · ${diff.removed.length} removed · ${diff.kept.length} unchanged`;
    if (canonical.length === 0 && submitted.length > 0) {
      diffHtml = `
        <div class="inbox-diff note" style="margin-top:0.5rem;">
          No existing schedule for this week — approve will create it (${counts}).
        </div>`;
    } else if (diff.added.length + diff.removed.length === 0) {
      diffHtml = `
        <div class="inbox-diff note" style="margin-top:0.5rem;">
          No changes vs. current schedule (${counts}).
        </div>`;
    } else {
      const addedHtml = diff.added.length
        ? `<p class="meta" style="margin:0.2rem 0;color:#0a7a2a;"><strong>+ Adding ${diff.added.length}</strong></p><ul style="margin:0;">${diff.added.map(formatEventLi).join("")}</ul>`
        : "";
      const removedHtml = diff.removed.length
        ? `<p class="meta" style="margin:0.2rem 0;color:#b22222;"><strong>− Removing ${diff.removed.length}</strong> <span class="muted">(currently on the canonical schedule; approve will drop)</span></p><ul style="margin:0;">${diff.removed.map(formatEventLi).join("")}</ul>`
        : "";
      diffHtml = `
        <details class="inbox-diff" style="margin-top:0.5rem;" open>
          <summary><strong>Changes vs. current schedule</strong> — ${counts}</summary>
          ${addedHtml}
          ${removedHtml}
        </details>`;
    }
  }

  return `<div class="inbox-events">${submittedHtml}${diffHtml}</div>`;
}

// formatEventLi now lives in shared/schedule-helpers.js

// Two events match if day + startTime + endTime + type + title agree.
// (Location/notes are display-only and don't change "is this the same event".)
function eventKey(e) {
  return [e.day || "", e.startTime || "", e.endTime || "", e.type || "", (e.title || "").trim()].join("|");
}

function diffEventLists(current, submitted) {
  const curKeys = new Set(current.map(eventKey));
  const subKeys = new Set(submitted.map(eventKey));
  const added = submitted.filter((e) => !curKeys.has(eventKey(e)));
  const removed = current.filter((e) => !subKeys.has(eventKey(e)));
  const kept = submitted.filter((e) => curKeys.has(eventKey(e)));
  return { added, removed, kept };
}

// Caches so repeated re-renders don't re-fetch. clientWeeklySchedule is keyed
// by docId (clientId-weekStart); thriftStoreSchedule is keyed by weekStart and
// shared across all pending submissions for the same week.
const inboxCanonicalCache = new Map(); // docId -> events array
const inboxThriftCache = new Map();    // weekStart -> all shifts array
async function hydrateInboxCanonicalEvents() {
  const pending = inboxRows.filter((r) =>
    r.data.status === "pending"
    && r.data.submissionType === "weeklySchedule"
    && r.data.clientId
    && r.data.weekStart);

  // Fan out canonical-schedule reads + thrift-schedule reads in parallel.
  await Promise.all(pending.flatMap((row) => [
    hydrateInboxRowCanonical(row),
    hydrateInboxRowThrift(row),
  ]));
}

async function hydrateInboxRowCanonical(row) {
  const docId = `${row.data.clientId}-${row.data.weekStart}`;
  if (inboxCanonicalCache.has(docId)) {
    row.data.__canonicalEvents = inboxCanonicalCache.get(docId);
    return;
  }
  try {
    const snap = await getDoc(doc(db, "clientWeeklySchedule", docId));
    const events = snap.exists() && Array.isArray(snap.data().events)
      ? snap.data().events.map((e) => ({ ...e }))
      : [];
    inboxCanonicalCache.set(docId, events);
    row.data.__canonicalEvents = events;
  } catch (err) {
    console.warn("[inbox] could not load canonical schedule", docId, err);
    row.data.__canonicalEvents = []; // best-effort: hide the diff if unreadable
  }
}

async function hydrateInboxRowThrift(row) {
  const weekStart = row.data.weekStart;
  const clientId = row.data.clientId;
  let allShifts;
  if (inboxThriftCache.has(weekStart)) {
    allShifts = inboxThriftCache.get(weekStart);
  } else {
    try {
      const snap = await getDoc(doc(db, "thriftStoreSchedule", weekStart));
      allShifts = snap.exists() && Array.isArray(snap.data().shifts)
        ? snap.data().shifts.map((s) => ({ ...s }))
        : [];
      inboxThriftCache.set(weekStart, allShifts);
    } catch (err) {
      console.warn("[inbox] could not load thrift schedule for", weekStart, err);
      allShifts = [];
    }
  }
  // Filter to this client's shifts. Each shift can have two assigned clients
  // (clientId / clientId2); match either slot. Empty-client template rows are
  // ignored.
  row.data.__canonicalThriftShifts = allShifts.filter((s) =>
    s.clientId === clientId || s.clientId2 === clientId
  );
}

function renderInfoUpdateBody(data) {
  const label = STATUS_UPDATE_TYPE_LABELS[data.updateType] || data.updateType || "(unknown)";
  const cat = statusUpdateCategory(data.updateType);
  const when = fmtDate(data.occurredOn) || "—";
  const notesHtml = data.notes
    ? `<p class="note" style="margin-top:0.3rem;">Client notes: ${escapeHtml(data.notes)}</p>`
    : "";
  return `
    <div class="inbox-events">
      <p style="margin:0.2rem 0;"><strong>${escapeHtml(label)}</strong> <span class="muted">(${escapeHtml(cat)})</span></p>
      <p class="meta" style="margin:0.1rem 0;">Occurred: ${escapeHtml(when)}</p>
      ${notesHtml}
    </div>`;
}

function renderStaffRequestBody(data) {
  const subj = REQUEST_SUBJECT_LABELS[data.subject] || data.subject || "(no subject)";
  const desc = (data.description || "").trim();
  const descHtml = desc
    ? `<p style="margin:0.3rem 0; white-space: pre-wrap;">${escapeHtml(desc)}</p>`
    : `<p class="note" style="margin:0.3rem 0;">(no description)</p>`;
  return `
    <div class="inbox-events">
      <p style="margin:0.2rem 0;"><strong>Subject:</strong> ${escapeHtml(subj)}</p>
      ${descHtml}
    </div>`;
}

async function approveSubmission(submissionId, btn) {
  const subRef = doc(db, "pendingClientSubmissions", submissionId);
  if (btn) btn.disabled = true;
  try {
    const subSnap = await getDoc(subRef);
    if (!subSnap.exists()) throw new Error("Submission no longer exists");
    const sub = subSnap.data();
    if (sub.status !== "pending") {
      throw new Error(`Submission is already ${sub.status}.`);
    }
    if (sub.submissionType === "weeklySchedule") {
      await approveWeeklyScheduleSubmission(submissionId, subRef);
    } else if (sub.submissionType === "infoUpdate") {
      await approveInfoUpdateSubmission(submissionId, subRef);
    } else if (sub.submissionType === "staffRequest") {
      await approveStaffRequestSubmission(submissionId, subRef);
    } else {
      throw new Error(`Unsupported submissionType: ${sub.submissionType}`);
    }
  } catch (err) {
    alert(`Approve failed: ${err.message || err}`);
    if (btn) btn.disabled = false;
  }
}

async function approveWeeklyScheduleSubmission(submissionId, subRef) {
  let scheduleDocId = null;
  let approvedClientId = null;
  let approvedWeekStart = null;
  let approvedEventCount = 0;
  await runTransaction(db, async (txn) => {
    const subSnap = await txn.get(subRef);
    if (!subSnap.exists()) throw new Error("Submission no longer exists");
    const sub = subSnap.data();
    if (sub.status !== "pending") {
      throw new Error(`Submission is already ${sub.status}.`);
    }
    const cid = sub.clientId;
    const weekStart = sub.weekStart;
    if (!cid || !weekStart) throw new Error("Submission missing clientId or weekStart");
    const docId = `${cid}-${weekStart}`;
    scheduleDocId = docId;
    approvedClientId = cid;
    approvedWeekStart = weekStart;
    approvedEventCount = (sub.events || []).length;
    // Resolve display name from the canonical client record so the
    // consolidated/thrift views show "First Last" instead of falling back
    // to the GSO-NNNNN clientId. Pending submission may carry clientName,
    // but cachedClients is current; submission name is a snapshot.
    const cachedClient = cachedClients.find((c) => c.id === cid);
    const clientName = cachedClient
      ? clientDisplayName(cachedClient.data)
      : (sub.clientName || cid);
    const schedRef = doc(db, "clientWeeklySchedule", docId);
    const schedSnap = await txn.get(schedRef); // must precede writes
    const base = {
      clientId: cid,
      clientName,
      weekStart,
      weekStartTimestamp: Timestamp.fromDate(new Date(weekStart + "T00:00:00")),
      events: sub.events || [],
      updatedAt: serverTimestamp(),
      updatedBy: auth.currentUser.email,
      lastApprovedSubmissionId: submissionId,
      expiresAt: scheduleExpiresAt(weekStart),
    };
    if (!schedSnap.exists()) {
      base.createdAt = serverTimestamp();
      base.createdBy = auth.currentUser.email;
    }
    txn.set(schedRef, base, { merge: true });
    txn.update(subRef, {
      status: "approved",
      reviewedAt: serverTimestamp(),
      reviewedBy: auth.currentUser.email,
    });
  });
  // Invalidate the canonical-events cache for this docId so a follow-up
  // submission's diff reflects the just-approved state.
  inboxCanonicalCache.delete(scheduleDocId);
  await logAccess(AUDIT_ACTIONS.APPROVE, "pendingClientSubmission", submissionId, {
    clientId: approvedClientId, weekStart: approvedWeekStart,
    eventCount: approvedEventCount,
  });
  await logAccess(AUDIT_ACTIONS.UPDATE, "clientWeeklySchedule", scheduleDocId, {
    clientId: approvedClientId, weekStart: approvedWeekStart,
    surface: "inbox-approve", eventCount: approvedEventCount,
  });
}

// Approve an "infoUpdate" submission. Mirrors the staff status-update save
// path (clientStatusUpdates addDoc + dot-path mirror onto clients/{cid}).
// Not a single transaction because addDoc on a new collection needs the
// generated ID before we can write the master mirror — same pattern as the
// staff form's two-step (write history → update master).
async function approveInfoUpdateSubmission(submissionId, subRef) {
  const subSnap = await getDoc(subRef);
  const sub = subSnap.data();
  const cid = sub.clientId;
  const updateType = sub.updateType;
  const occurredOn = sub.occurredOn; // already a Timestamp on the submission
  if (!cid || !updateType || !occurredOn) {
    throw new Error("Submission missing clientId, updateType, or occurredOn.");
  }
  if (!STATUS_UPDATE_TYPE_LABELS[updateType]) {
    throw new Error(`Unknown updateType: ${updateType}`);
  }
  const category = statusUpdateCategory(updateType);
  const userEmail = auth.currentUser.email;

  // Write the history doc first so the audit trail exists even if the master
  // mirror update fails afterward (matches staff status-update flow).
  const histRef = await addDoc(collection(db, "clientStatusUpdates"), {
    clientId: cid,
    updateType,
    category,
    occurredOn,
    notes: sub.notes || null,
    recordedBy: userEmail,
    createdAt: serverTimestamp(),
    createdBy: userEmail,
    sourceSubmissionId: submissionId,
  });

  const masterPatch = {};
  masterPatch[`${category}s.${updateType}`] = {
    obtained: true,
    obtainedOn: occurredOn,
    lastUpdateId: histRef.id,
    lastUpdateAt: serverTimestamp(),
    lastUpdateBy: userEmail,
  };
  await updateDoc(doc(db, "clients", cid), masterPatch);

  await updateDoc(subRef, {
    status: "approved",
    reviewedAt: serverTimestamp(),
    reviewedBy: userEmail,
    approvedStatusUpdateId: histRef.id,
  });

  await logAccess(AUDIT_ACTIONS.APPROVE, "pendingClientSubmission", submissionId, {
    clientId: cid, submissionType: "infoUpdate", updateType, category,
    surface: "inbox-approve",
  });
  await logAccess(AUDIT_ACTIONS.CREATE, "clientStatusUpdate", histRef.id, {
    clientId: cid, updateType, category,
    surface: "inbox-approve-infoUpdate",
  });
}

// Approve a "staffRequest" submission. Only flips status — help requests
// aren't facts about the client, they're a one-off ask, so nothing mirrors
// to the canonical record. After approval, staff can print the request
// via the Print button rendered on approved staffRequest inbox rows.
async function approveStaffRequestSubmission(submissionId, subRef) {
  const subSnap = await getDoc(subRef);
  const sub = subSnap.data();
  const userEmail = auth.currentUser.email;
  await updateDoc(subRef, {
    status: "approved",
    reviewedAt: serverTimestamp(),
    reviewedBy: userEmail,
  });
  await logAccess(AUDIT_ACTIONS.APPROVE, "pendingClientSubmission", submissionId, {
    clientId: sub.clientId, submissionType: "staffRequest",
    subject: sub.subject, surface: "inbox-approve",
  });
}

// Open a printable view of an approved help request in a new window and
// trigger the browser's print dialog. Includes client identifiers, subject,
// full description, submitted/approved timestamps, and an approving-staff
// signature line.
function printStaffRequest(submissionId, data) {
  const orgName = (typeof TENANT !== "undefined" && TENANT?.orgName) || "Organization";
  const subj = REQUEST_SUBJECT_LABELS[data.subject] || data.subject || "(no subject)";
  const desc = (data.description || "").trim();
  const submittedAt = data.submittedAt?.toDate
    ? data.submittedAt.toDate().toLocaleString()
    : "—";
  const reviewedAt = data.reviewedAt?.toDate
    ? data.reviewedAt.toDate().toLocaleString()
    : "—";
  const clientLine = `${data.clientName || data.clientId || ""}${data.clientId && data.clientName ? ` (${data.clientId})` : ""}`;
  const html = `<!doctype html>
<html><head><meta charset="utf-8"><title>Help Request — ${escapeHtml(subj)}</title>
<style>
  body { font-family: Arial, Helvetica, sans-serif; color: #111; max-width: 7in; margin: 0.6in auto; padding: 0 0.5in; }
  h1 { font-size: 18pt; margin: 0 0 0.2rem; }
  h2 { font-size: 13pt; margin: 1rem 0 0.25rem; border-bottom: 1px solid #999; padding-bottom: 0.1rem; }
  .meta { color: #555; font-size: 10pt; margin: 0.1rem 0; }
  dl { display: grid; grid-template-columns: max-content 1fr; column-gap: 0.6rem; row-gap: 0.25rem; margin: 0.5rem 0; }
  dt { font-weight: bold; color: #333; }
  dd { margin: 0; }
  .desc { white-space: pre-wrap; margin: 0.4rem 0; }
  .sig-line { display: inline-block; border-bottom: 1px solid #333; min-width: 3in; height: 0.4in; vertical-align: bottom; }
  .sig-row { margin-top: 1rem; }
  .footer { color: #666; font-size: 9pt; margin-top: 1.5rem; }
  @media print { @page { margin: 0.5in; } }
</style>
</head><body>
  <h1>${escapeHtml(orgName)} — Help Request</h1>
  <p class="meta">Submission ID: ${escapeHtml(submissionId)}</p>

  <h2>Client</h2>
  <dl>
    <dt>Name:</dt><dd>${escapeHtml(clientLine)}</dd>
    <dt>Submitted:</dt><dd>${escapeHtml(submittedAt)}</dd>
    <dt>Approved:</dt><dd>${escapeHtml(reviewedAt)} by ${escapeHtml(data.reviewedBy || "—")}</dd>
  </dl>

  <h2>Subject</h2>
  <p>${escapeHtml(subj)}</p>

  <h2>Description</h2>
  <p class="desc">${escapeHtml(desc) || "(no description)"}</p>

  <div class="sig-row">
    <p><strong>Staff handling:</strong> <span class="sig-line"></span></p>
    <p><strong>Date:</strong> <span class="sig-line" style="min-width: 1.5in;"></span></p>
  </div>

  <p class="footer">Printed ${escapeHtml(new Date().toLocaleString())}</p>
<script>window.addEventListener("load", function(){ window.print(); });<\/script>
</body></html>`;
  const win = window.open("", "_blank", "width=900,height=1100");
  if (!win) {
    alert("Print blocked. Allow popups for this site, then click Print again.");
    return;
  }
  win.document.open();
  win.document.write(html);
  win.document.close();
}

async function rejectSubmission(submissionId, note, btn) {
  const subRef = doc(db, "pendingClientSubmissions", submissionId);
  if (btn) btn.disabled = true;
  try {
    await updateDoc(subRef, {
      status: "rejected",
      reviewedAt: serverTimestamp(),
      reviewedBy: auth.currentUser.email,
      reviewNote: note || null,
    });
    await logAccess(AUDIT_ACTIONS.REJECT, "pendingClientSubmission", submissionId, {
      surface: "inbox-reject", hasNote: !!note,
    });
  } catch (err) {
    alert(`Reject failed: ${err.message || err}`);
    if (btn) btn.disabled = false;
  }
}

// Filter toggle — re-subscribe with the new query.
(function bindInboxFilter() {
  const radios = document.querySelectorAll('input[name="inbox-filter"]');
  if (!radios.length) return;
  radios.forEach((r) => {
    r.addEventListener("change", () => {
      if (!r.checked) return;
      inboxFilter = r.value;
      // Resubscribe; the listener will repopulate inboxRows.
      if (currentUserRole === "admin" || currentUserRole === "staff" ||
          (auth.currentUser && (auth.currentUser.email || "").endsWith(`@${ALLOWED_DOMAIN}`))) {
        startInboxListener();
      }
    });
  });
})();

// Visible "sign out of app" button inside the client greeting — clients
// don't see the staff user-bar, so they need an obvious way to leave.
(function addClientSessionSignOut() {
  const greet = document.querySelector(".client-greeting");
  if (!greet) return;
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "ghost client-session-signout";
  btn.textContent = "Sign out of app";
  btn.style.marginTop = "0.4rem";
  btn.addEventListener("click", async () => {
    stopClientAppListeners();
    await logAccess(AUDIT_ACTIONS.SIGN_OUT, "session");
    await signOut(auth);
  });
  greet.appendChild(btn);
})();

// ----- Client detail: update/take photo modal -----
//
// Lets staff capture or upload a replacement / first-time photo from the
// client detail page. Self-contained: separate DOM, blob state, and camera
// stream from the intake-form photo flow (which reuses the original
// photoBlob / #photo-* IDs).

(() => {
  const modal = document.getElementById("client-photo-modal");
  if (!modal) return;

  const editBtn = document.getElementById("client-detail-photo-edit");
  const startBtn = document.getElementById("client-photo-start-btn");
  const captureBtn = document.getElementById("client-photo-capture-btn");
  const cameraCancelBtn = document.getElementById("client-photo-camera-cancel-btn");
  const retakeBtn = document.getElementById("client-photo-retake-btn");
  const fileInput = document.getElementById("client-photo-file");
  const videoEl = document.getElementById("client-photo-video");
  const previewEl = document.getElementById("client-photo-preview");
  const videoSection = document.getElementById("client-photo-video-section");
  const previewSection = document.getElementById("client-photo-preview-section");
  const controls = document.getElementById("client-photo-controls");
  const statusEl = document.getElementById("client-photo-status");
  const saveBtn = document.getElementById("client-photo-save");
  const cancelBtn = document.getElementById("client-photo-cancel");
  const backdrop = document.getElementById("client-photo-modal-backdrop");

  let stream = null;
  let blob = null;

  function setStatus(msg, isError = false) {
    if (!statusEl) return;
    statusEl.textContent = msg || "";
    statusEl.classList.toggle("error", isError);
  }

  function stopCamera() {
    if (stream) {
      stream.getTracks().forEach((t) => t.stop());
      stream = null;
    }
    if (videoEl) videoEl.srcObject = null;
  }

  function resetState() {
    stopCamera();
    blob = null;
    if (fileInput) fileInput.value = "";
    if (previewEl) previewEl.src = "";
    videoSection.hidden = true;
    previewSection.hidden = true;
    controls.hidden = false;
    saveBtn.disabled = true;
    saveBtn.textContent = "Save photo";
    setStatus("");
  }

  function openModal() {
    resetState();
    modal.hidden = false;
  }

  function closeModal() {
    stopCamera();
    modal.hidden = true;
  }

  async function startCamera() {
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: "user", width: { ideal: 640 }, height: { ideal: 480 } },
        audio: false,
      });
      videoEl.srcObject = stream;
      await videoEl.play();
      videoSection.hidden = false;
      controls.hidden = true;
      previewSection.hidden = true;
      setStatus("");
    } catch (err) {
      setStatus(`Camera unavailable (${err.message}). Use "upload from device" instead.`, true);
    }
  }

  function capturePhoto() {
    if (!stream) return;
    const canvas = document.createElement("canvas");
    canvas.width = videoEl.videoWidth || 640;
    canvas.height = videoEl.videoHeight || 480;
    canvas.getContext("2d").drawImage(videoEl, 0, 0, canvas.width, canvas.height);
    canvas.toBlob((b) => {
      if (!b) {
        setStatus("Capture failed. Try again or use file upload.", true);
        return;
      }
      blob = b;
      previewEl.src = URL.createObjectURL(b);
      previewSection.hidden = false;
      videoSection.hidden = true;
      stopCamera();
      saveBtn.disabled = false;
      setStatus(`Photo captured (${Math.round(b.size / 1024)} KB).`);
    }, "image/jpeg", 0.85);
  }

  function handleFile(file) {
    if (!file) return;
    if (!file.type.startsWith("image/")) {
      setStatus("Please choose an image file.", true);
      return;
    }
    if (file.size > 5 * 1024 * 1024) {
      setStatus("Image is over 5 MB. Please pick a smaller one or retake.", true);
      return;
    }
    blob = file;
    previewEl.src = URL.createObjectURL(file);
    previewSection.hidden = false;
    videoSection.hidden = true;
    controls.hidden = true;
    saveBtn.disabled = false;
    setStatus(`Photo loaded (${Math.round(file.size / 1024)} KB).`);
  }

  async function savePhoto() {
    const cid = currentDetailClientId;
    if (!cid || !blob) return;
    saveBtn.disabled = true;
    saveBtn.textContent = "Saving…";
    try {
      const path = `clients/${cid}/photos/manual-${Date.now()}.jpg`;
      await uploadBlobToStorage(path, blob, blob.type || "image/jpeg");
      await updateDoc(doc(db, "clients", cid), { photoPath: path });
      await logAccess(AUDIT_ACTIONS.UPDATE, "photo", cid, { path, surface: "clients-detail" });
      await loadClientPhoto(path);
      if (editBtn) editBtn.textContent = "Update photo";
      closeModal();
    } catch (err) {
      setStatus(`Could not save photo: ${err.message}`, true);
      saveBtn.disabled = false;
      saveBtn.textContent = "Save photo";
    }
  }

  if (editBtn) editBtn.addEventListener("click", openModal);
  startBtn?.addEventListener("click", startCamera);
  captureBtn?.addEventListener("click", capturePhoto);
  cameraCancelBtn?.addEventListener("click", () => {
    stopCamera();
    videoSection.hidden = true;
    controls.hidden = false;
  });
  retakeBtn?.addEventListener("click", () => {
    blob = null;
    if (previewEl) previewEl.src = "";
    previewSection.hidden = true;
    controls.hidden = false;
    if (fileInput) fileInput.value = "";
    saveBtn.disabled = true;
    setStatus("");
  });
  fileInput?.addEventListener("change", (e) => handleFile(e.target.files?.[0]));
  saveBtn?.addEventListener("click", savePhoto);
  cancelBtn?.addEventListener("click", closeModal);
  backdrop?.addEventListener("click", closeModal);
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !modal.hidden) closeModal();
  });
})();
