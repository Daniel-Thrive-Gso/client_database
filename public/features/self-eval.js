// Self-Evaluations tab: staff submit a behavior/incident note keyed to a
// client; the report below lists every unresolved entry across all
// clients; click "Mark resolved" to clear one. The auth router calls
// initSelfEval() on staff sign-in to set defaults + start the live
// listener, and stopSelfEval() on sign-out to detach.

import {
  collection, addDoc, doc, query, where, orderBy, onSnapshot,
  updateDoc, serverTimestamp, Timestamp, writeBatch,
} from "https://www.gstatic.com/firebasejs/10.14.0/firebase-firestore.js";
import { auth, db } from "../shared/firebase.js";
import { escapeHtml } from "../shared/helpers.js";
import { AUDIT_ACTIONS, logAccess } from "../shared/audit-log-writer.js";
import { createClientPicker } from "../shared/client-picker.js";

// DOM refs cached at module load. The entry <script> sits at end of <body>
// so these elements exist by the time this evaluates.
const submitForm = document.getElementById("submit-form");
const submitStatus = document.getElementById("submit-status");
const seedBtn = document.getElementById("seed-btn");
const reportBody = document.getElementById("report-body");
const tileUnresolvedValue = document.getElementById("tile-unresolved-value");
const tileAlerts = document.getElementById("tile-alerts");
const tileAlertsValue = document.getElementById("tile-alerts-value");
const tileAlertsList = document.getElementById("tile-alerts-list");

// Picker mounted into the section's host element at module load. Stays
// alive across sign-ins; clears on submit.
const selfEvalPickerRoot = document.getElementById("self-eval-client-picker");
const selfEvalClientPicker = selfEvalPickerRoot
  ? createClientPicker({ root: selfEvalPickerRoot })
  : null;

let unsubscribeSnapshot = null;

export function initSelfEval() {
  setSubmitDefaults();
  startReportListener();
}

export function stopSelfEval() {
  if (unsubscribeSnapshot) { unsubscribeSnapshot(); unsubscribeSnapshot = null; }
}

function setSubmitDefaults() {
  if (!submitForm) return;
  const today = new Date().toISOString().slice(0, 10);
  submitForm.elements.dateGiven.value = today;
  if (!submitForm.elements.givenBy.value) {
    submitForm.elements.givenBy.value = (auth.currentUser?.displayName || "").trim();
  }
}

function showSubmitError(msg) {
  if (!submitStatus) return;
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
    orderBy("dateGiven", "desc"),
  );
  unsubscribeSnapshot = onSnapshot(q, (snap) => {
    renderReport(snap.docs);
  }, (err) => {
    if (reportBody) {
      reportBody.innerHTML = `<tr class="empty"><td colspan="5">Could not load: ${escapeHtml(err.message)}</td></tr>`;
    }
  });
}

function renderReport(docs) {
  if (tileUnresolvedValue) tileUnresolvedValue.textContent = docs.length.toString();

  const counts = new Map();
  for (const d of docs) {
    const name = (d.data().clientName || "").trim();
    if (!name) continue;
    counts.set(name, (counts.get(name) || 0) + 1);
  }
  const flagged = [...counts.entries()].filter(([, n]) => n >= 3);
  if (tileAlerts) {
    if (flagged.length === 0) {
      tileAlerts.hidden = true;
    } else {
      tileAlerts.hidden = false;
      if (tileAlertsValue) tileAlertsValue.textContent = flagged.length.toString();
      if (tileAlertsList) {
        tileAlertsList.innerHTML = flagged
          .sort((a, b) => b[1] - a[1])
          .map(([name, n]) => `<li>${escapeHtml(name)} — ${n} unresolved</li>`)
          .join("");
      }
    }
  }

  if (!reportBody) return;
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

// Wire DOM event handlers once at module load.
submitForm?.addEventListener("submit", async (e) => {
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

reportBody?.addEventListener("click", async (e) => {
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

seedBtn?.addEventListener("click", async () => {
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
