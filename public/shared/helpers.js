// Cross-section pure helpers + the small set of program constants they
// depend on. No mutable state; safe to import from anywhere.

import { isAdminEmail } from "../config.js";
import { auth } from "./firebase.js";
import { currentUserRole } from "./auth-state.js";

// ----- Program: client levels, probation -----
//
// New intakes default to Alpha + 14-day probation. Probation is encoded as a
// single Timestamp `probationUntil` — if present and in the future, client is
// on probation; if null or in the past, they're not. This lets staff extend
// probation for an incident by setting a new future date without separate
// "isOnProbation" flags drifting out of sync.
export const LEVEL_KEYS = ["alpha", "bravo", "charlie", "delta"];
export const LEVEL_LABELS = {
  alpha:   "Alpha",
  bravo:   "Bravo",
  charlie: "Charlie",
  delta:   "Delta",
};
export const PROBATION_DEFAULT_DAYS = 14;

export function isOnProbation(master) {
  const t = master?.probationUntil;
  if (!t) return false;
  const ms = typeof t.toMillis === "function" ? t.toMillis() : (t.seconds ? t.seconds * 1000 : null);
  if (ms == null) return false;
  return ms > Date.now();
}

// "Alpha-Probation" / "Alpha" / "Bravo" / etc.
export function levelDisplay(master) {
  const level = LEVEL_LABELS[master?.level] || LEVEL_LABELS.alpha;
  return isOnProbation(master) ? `${level}-Probation` : level;
}

// ----- Pure utility helpers -----

export function escapeHtml(s) {
  return String(s)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

export function capitalize(s) {
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : "";
}

export function fmtClientTimeShort(ts) {
  if (!ts?.toDate) return "—";
  const d = ts.toDate();
  return d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

// Locale date string for a Firestore Timestamp (or null when missing/invalid).
export function fmtDate(ts) {
  if (!ts) return null;
  let d = ts;
  if (typeof ts.toDate === "function") d = ts.toDate();
  if (!(d instanceof Date) || isNaN(d)) return null;
  return d.toLocaleDateString();
}

// Locale date+time string for a Firestore Timestamp (or null when missing/invalid).
export function fmtTimestamp(ts) {
  if (!ts) return null;
  let d = ts;
  if (typeof ts.toDate === "function") d = ts.toDate();
  if (!(d instanceof Date) || isNaN(d)) return null;
  return d.toLocaleString();
}

export function clientDisplayName(d) {
  return [d.firstName, d.middleName, d.lastName].filter(Boolean).join(" ")
    || d.alias || "(no name)";
}

// ----- Identity helpers -----

// True if the signed-in user has admin powers — either via the explicit
// `admin` custom claim or by being the configured admin email. The email
// fallback is what lets `set-claim.mjs` provision the first admin before
// the claim exists.
export function isCurrentUserAdmin() {
  return currentUserRole === "admin"
    || isAdminEmail(auth.currentUser?.email);
}
