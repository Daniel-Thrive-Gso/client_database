// Enables Firestore TTL policy on `expiresAt` for mealLog, showerLog,
// clientWeeklySchedule, and thriftStoreSchedule (matching the existing
// checkInOuts TTL). Then backfills `expiresAt` on every existing doc in
// those collections that doesn't already have one, so the policy can
// collect historical data on the same schedule.
//
// Idempotent. Re-runs only patch docs that still lack `expiresAt`.
//
// Usage (from client_database/admin/):
//   $env:GOOGLE_APPLICATION_CREDENTIALS = "C:\path\to\service-account-key.json"
//   node enable-extra-ttl.mjs

import { initializeApp, applicationDefault } from "firebase-admin/app";
import { getFirestore, Timestamp, FieldValue } from "firebase-admin/firestore";
import { GoogleAuth } from "google-auth-library";

const PROJECT_ID = "admin-automation-74110";
const DATABASE_ID = "(default)";
const FIELD_PATH = "expiresAt";

const PER_EVENT_TTL_MS = 21 * 86400 * 1000;
const SCHEDULE_TTL_AFTER_WEEK_MS = (7 + 21) * 86400 * 1000;

const COLLECTIONS = [
  { name: "mealLog",              kind: "perEvent" },
  { name: "showerLog",            kind: "perEvent" },
  { name: "clientWeeklySchedule", kind: "schedule" },
  { name: "thriftStoreSchedule",  kind: "schedule" },
];

if (!process.env.GOOGLE_APPLICATION_CREDENTIALS) {
  console.error("ERROR: GOOGLE_APPLICATION_CREDENTIALS env var is not set.");
  process.exit(1);
}

initializeApp({ credential: applicationDefault() });
const db = getFirestore();

const auth = new GoogleAuth({
  scopes: ["https://www.googleapis.com/auth/datastore"],
});

async function enableTtl(collection) {
  const tokenResponse = await auth.getAccessToken();
  const url =
    `https://firestore.googleapis.com/v1/projects/${PROJECT_ID}` +
    `/databases/${encodeURIComponent(DATABASE_ID)}` +
    `/collectionGroups/${collection}` +
    `/fields/${FIELD_PATH}` +
    `?updateMask=ttlConfig`;

  const res = await fetch(url, {
    method: "PATCH",
    headers: {
      Authorization: `Bearer ${tokenResponse}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ ttlConfig: {} }),
  });
  const body = await res.text();
  console.log(`  TTL policy: HTTP ${res.status}`);
  if (!res.ok) console.log(`  ${body.slice(0, 300)}`);
}

function perEventExpiresFromDoc(data) {
  // Prefer the doc's own eventTime, fall back to submittedAt, else now.
  const baseTs = data.eventTime || data.submittedAt;
  const baseMs = baseTs?.toMillis ? baseTs.toMillis() : Date.now();
  return Timestamp.fromMillis(baseMs + PER_EVENT_TTL_MS);
}

function scheduleExpiresFromDoc(data, fallbackWeekStart) {
  // Prefer weekStart on the doc; fall back to weekStartTimestamp; then doc id.
  const weekStartStr = data.weekStart || fallbackWeekStart;
  if (weekStartStr && /^\d{4}-\d{2}-\d{2}$/.test(weekStartStr)) {
    const ms = new Date(weekStartStr + "T00:00:00").getTime();
    return Timestamp.fromMillis(ms + SCHEDULE_TTL_AFTER_WEEK_MS);
  }
  const baseTs = data.weekStartTimestamp || data.updatedAt || data.createdAt;
  const baseMs = baseTs?.toMillis ? baseTs.toMillis() : Date.now();
  return Timestamp.fromMillis(baseMs + SCHEDULE_TTL_AFTER_WEEK_MS);
}

async function backfill(collection, kind) {
  const snap = await db.collection(collection).get();
  let touched = 0, skipped = 0;
  // writeBatch: 500 ops max. Chunk just in case.
  let batch = db.batch();
  let batchOps = 0;

  for (const d of snap.docs) {
    const data = d.data();
    if (data[FIELD_PATH]) { skipped++; continue; }

    let expires;
    if (kind === "perEvent") {
      expires = perEventExpiresFromDoc(data);
    } else {
      // For thriftStoreSchedule the doc id is the weekStart string.
      // For clientWeeklySchedule the id is "{cid}-{weekStart}" — split it.
      let fallback = null;
      if (collection === "thriftStoreSchedule") fallback = d.id;
      else if (collection === "clientWeeklySchedule") {
        const parts = d.id.split("-");
        if (parts.length >= 4) fallback = parts.slice(-3).join("-"); // YYYY-MM-DD
      }
      expires = scheduleExpiresFromDoc(data, fallback);
    }

    batch.update(d.ref, { [FIELD_PATH]: expires });
    batchOps++;
    touched++;
    if (batchOps >= 400) {
      await batch.commit();
      batch = db.batch();
      batchOps = 0;
    }
  }
  if (batchOps > 0) await batch.commit();
  console.log(`  backfill: ${touched} updated, ${skipped} already had expiresAt`);
}

for (const { name, kind } of COLLECTIONS) {
  console.log(`\n${name} (${kind}):`);
  await enableTtl(name);
  await backfill(name, kind);
}

console.log(
  "\nDone. TTL policies start collecting expired docs within minutes; the " +
  "policy state may briefly show INITIALIZING in the Firebase console."
);
