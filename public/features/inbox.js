// Inbox tab — staff review of pending client-app submissions.
//
// Three submission types:
//   - weeklySchedule: copies events array into clientWeeklySchedule/{cid-weekStart}
//   - infoUpdate: addDoc to clientStatusUpdates + dot-path mirror onto clients/{cid}
//   - staffRequest: just flips status to approved; staff prints + acts manually
//
// Filter defaults to pending; a toggle switches to last-30 (any status) so
// staff can revisit recent decisions. Both approve + reject write audit
// entries via shared/audit-log-writer.

import {
  collection, doc, getDoc, addDoc, updateDoc, query, where, orderBy, limit,
  onSnapshot, runTransaction, serverTimestamp, Timestamp,
} from "https://www.gstatic.com/firebasejs/10.14.0/firebase-firestore.js";
import { auth, db, ALLOWED_DOMAIN } from "../shared/firebase.js";
import { escapeHtml, clientDisplayName, fmtDate } from "../shared/helpers.js";
import { AUDIT_ACTIONS, logAccess } from "../shared/audit-log-writer.js";
import { currentUserRole } from "../shared/auth-state.js";
import { cachedClients } from "../shared/clients-store.js";
import {
  DAY_LABELS, EVENT_TYPE_LABELS,
  formatTime12, eventsOverlap, formatEventLi, scheduleExpiresAt,
} from "../shared/schedule-helpers.js";
import {
  CLIENT_SUB_TYPES, REQUEST_SUBJECT_LABELS,
  STATUS_UPDATE_TYPE_LABELS, statusUpdateCategory,
} from "../shared/program-constants.js";

let inboxUnsub = null;
let inboxRows = [];
let inboxFilter = "pending";

export function stopInboxListener() {
  if (inboxUnsub) { inboxUnsub(); inboxUnsub = null; }
}

export function startInboxListener() {
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

// Schedule's thrift-save handler calls this after writing a new thrift
// schedule for a given week, so Inbox's next conflict-detection pass
// reads the just-saved data instead of the cached pre-save copy.
export function invalidateInboxThriftCache(weekStart) {
  inboxThriftCache.delete(weekStart);
}
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
  const orgName = "Good Samaritan Outreach";
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

// Filter toggle — re-subscribe with the new query. Wired at module load.
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
