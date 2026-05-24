// Schedule formatters + constants used both by the Schedule tab itself
// (will move to features/schedule.js in Phase 2.6) and by Inbox (which
// displays weekly-schedule submissions with conflict diffs). Pure — no
// state.

import { Timestamp } from "https://www.gstatic.com/firebasejs/10.14.0/firebase-firestore.js";
import { escapeHtml } from "./helpers.js";

// clientWeeklySchedule / thriftStoreSchedule docs are TTL'd this many days
// after the week ends (= weekStart + 7). Used by Schedule writes + Inbox
// weekly-schedule approval.
export const SCHEDULE_TTL_DAYS_AFTER_WEEK = 21;

// expiresAt for weekly-schedule docs (per-client schedule + master thrift
// schedule). The week itself ends 7 days after weekStart (Monday); the doc
// lives for SCHEDULE_TTL_DAYS_AFTER_WEEK additional days for review.
export function scheduleExpiresAt(weekStartStr) {
  const d = new Date(weekStartStr + "T00:00:00");
  d.setDate(d.getDate() + 7 + SCHEDULE_TTL_DAYS_AFTER_WEEK);
  return Timestamp.fromDate(d);
}

export const DAY_LABELS = {
  monday: "Monday", tuesday: "Tuesday", wednesday: "Wednesday",
  thursday: "Thursday", friday: "Friday", saturday: "Saturday", sunday: "Sunday",
};

export const EVENT_TYPES = [
  "appointment", "class", "personal", "meal",
  "work", "counseling", "doctor", "court", "aa_na", "other",
];

export const EVENT_TYPE_LABELS = {
  appointment: "Appointment", class: "Class", personal: "Personal",
  meal: "Meal", work: "Work", counseling: "Counseling",
  doctor: "Doctor", court: "Court", aa_na: "AA/NA Meeting",
  other: "Other",
};

export function timeToMinutes(hhmm) {
  if (!hhmm || typeof hhmm !== "string") return null;
  const m = hhmm.match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  const h = Number(m[1]);
  const mins = Number(m[2]);
  if (isNaN(h) || isNaN(mins)) return null;
  return h * 60 + mins;
}

export function formatTime12(hhmm) {
  const total = timeToMinutes(hhmm);
  if (total === null) return hhmm || "";
  const hours = Math.floor(total / 60);
  const mins = total % 60;
  const period = hours >= 12 ? "pm" : "am";
  const h12 = hours % 12 || 12;
  return `${h12}:${String(mins).padStart(2, "0")}${period}`;
}

export function eventsOverlap(a, b) {
  if (!a.day || a.day !== b.day) return false;
  const aS = timeToMinutes(a.startTime);
  const aE = timeToMinutes(a.endTime);
  const bS = timeToMinutes(b.startTime);
  const bE = timeToMinutes(b.endTime);
  if (aS === null || aE === null || bS === null || bE === null) return false;
  return aS < bE && bS < aE;
}

// One-line bullet for a weekly-schedule event, used by Inbox's
// renderWeeklyScheduleBody and any other consumer that needs a
// human-readable summary of one event.
export function formatEventLi(e) {
  const day = DAY_LABELS[e.day] || e.day || "—";
  const t = `${formatTime12(e.startTime)}–${formatTime12(e.endTime)}`;
  return `<li>${escapeHtml(day)} ${escapeHtml(t)} · ${escapeHtml(EVENT_TYPE_LABELS[e.type] || e.type || "")} · ${escapeHtml(e.title || "")}</li>`;
}
