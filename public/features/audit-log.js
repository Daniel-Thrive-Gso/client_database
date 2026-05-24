// Audit log tab (admin-only) — go_live_checklist.md A5.
//
// Reads the most recent N accessLog entries (rules: admin-only read) once,
// then filters client-side — no composite index needed (single-field orderBy
// on `timestamp`). The tab button is unhidden for admin in the auth router
// (app.js's onAuthStateChanged). Module load self-registers all event
// handlers; the auth router only needs to call resetAuditState() on sign-out.

import {
  collection, getDocs, query, orderBy, limit,
} from "https://www.gstatic.com/firebasejs/10.14.0/firebase-firestore.js";
import { db } from "../shared/firebase.js";
import { escapeHtml, isCurrentUserAdmin } from "../shared/helpers.js";

let auditEntries = [];   // [{ id, data }]
let auditLoaded = false;
let auditLoading = false;

const $audit = (id) => document.getElementById(id);

function metaToStr(m) {
  if (m == null) return "";
  if (typeof m === "string") return m;
  try {
    return Object.entries(m)
      .map(([k, v]) => `${k}=${v != null && typeof v === "object" ? JSON.stringify(v) : v}`)
      .join(", ");
  } catch { return ""; }
}

async function loadAuditLog() {
  if (auditLoading) return;
  const body = $audit("audit-body");
  if (!isCurrentUserAdmin()) {
    if (body) body.innerHTML = `<tr class="empty"><td colspan="6">Admin only.</td></tr>`;
    return;
  }
  auditLoading = true;
  if (body) body.innerHTML = `<tr class="empty"><td colspan="6">Loading…</td></tr>`;
  try {
    const n = parseInt($audit("audit-limit")?.value || "500", 10) || 500;
    const snap = await getDocs(query(collection(db, "accessLog"), orderBy("timestamp", "desc"), limit(n)));
    auditEntries = snap.docs.map((d) => ({ id: d.id, data: d.data() }));
    auditLoaded = true;
    populateAuditFilterOptions();
    renderAuditLog();
  } catch (err) {
    if (body) body.innerHTML = `<tr class="empty"><td colspan="6">Could not load: ${escapeHtml(err.message)}</td></tr>`;
  } finally {
    auditLoading = false;
  }
}

function populateAuditFilterOptions() {
  const fill = (sel, values, label) => {
    if (!sel) return;
    const cur = sel.value;
    sel.innerHTML = [`<option value="">${label}</option>`]
      .concat([...values].sort((a, b) => a.localeCompare(b))
        .map((v) => `<option value="${escapeHtml(v)}">${escapeHtml(v)}</option>`))
      .join("");
    if (values.has(cur)) sel.value = cur;
  };
  fill($audit("audit-filter-action"), new Set(auditEntries.map((e) => e.data.action).filter(Boolean)), "All actions");
  fill($audit("audit-filter-entity"), new Set(auditEntries.map((e) => e.data.entityType).filter(Boolean)), "All entity types");
  fill($audit("audit-filter-user"), new Set(auditEntries.map((e) => e.data.userEmail).filter(Boolean)), "All users");
}

function renderAuditLog() {
  const body = $audit("audit-body");
  if (!body) return;
  const q = ($audit("audit-search")?.value || "").trim().toLowerCase();
  const fa = $audit("audit-filter-action")?.value || "";
  const fe = $audit("audit-filter-entity")?.value || "";
  const fu = $audit("audit-filter-user")?.value || "";
  const rows = auditEntries.filter((e) => {
    const d = e.data;
    if (fa && d.action !== fa) return false;
    if (fe && d.entityType !== fe) return false;
    if (fu && d.userEmail !== fu) return false;
    if (q) {
      const hay = [d.userEmail, d.action, d.entityType, d.entityId, d.userId, metaToStr(d.metadata)]
        .map((x) => String(x ?? "")).join(" ").toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });
  const cnt = $audit("audit-count");
  if (cnt) cnt.textContent = `${rows.length} of ${auditEntries.length} loaded entries shown.`;
  if (rows.length === 0) {
    body.innerHTML = `<tr class="empty"><td colspan="6">No entries match.</td></tr>`;
    return;
  }
  body.innerHTML = rows.map((e) => {
    const d = e.data;
    const ts = d.timestamp?.toDate ? d.timestamp.toDate() : null;
    const when = ts ? ts.toLocaleString() : "(pending)";
    return `<tr>
      <td>${escapeHtml(when)}</td>
      <td>${escapeHtml(d.userEmail || d.userId || "")}</td>
      <td>${escapeHtml(d.action || "")}</td>
      <td>${escapeHtml(d.entityType || "")}</td>
      <td>${d.entityId ? `<code>${escapeHtml(d.entityId)}</code>` : ""}</td>
      <td class="muted" style="word-break:break-word;">${escapeHtml(metaToStr(d.metadata))}</td>
    </tr>`;
  }).join("");
}

// Called by the auth router on sign-out so the next admin signing in starts
// from a blank tab.
export function resetAuditState() {
  auditEntries = [];
  auditLoaded = false;
  auditLoading = false;
  const body = $audit("audit-body");
  if (body) body.innerHTML = `<tr class="empty"><td colspan="6">Open this tab to load.</td></tr>`;
  const cnt = $audit("audit-count");
  if (cnt) cnt.textContent = "";
}

// Self-register handlers at module load. The entry <script> sits at end of
// <body> so these elements exist by the time this runs.
(function wireAuditTab() {
  const rerender = () => { if (auditLoaded) renderAuditLog(); };
  $audit("audit-search")?.addEventListener("input", rerender);
  ["audit-filter-action", "audit-filter-entity", "audit-filter-user"].forEach((id) =>
    $audit(id)?.addEventListener("change", rerender));
  $audit("audit-limit")?.addEventListener("change", () => { if (auditLoaded) loadAuditLog(); });
  $audit("audit-refresh")?.addEventListener("click", () => loadAuditLog());
  document.querySelector('.tab-btn[data-tab="audit"]')?.addEventListener("click", () => {
    if (!auditLoaded) loadAuditLog();
  });
})();
