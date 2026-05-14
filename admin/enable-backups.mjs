// Enables a Firestore "managed daily backup" schedule (7-day retention) on the
// (default) database — a rolling 7-day window covering the whole datastore.
// Managed backups go to Google-managed storage; no customer bucket, no Cloud
// Scheduler, no Cloud Function. (This is the newer Firestore Backups feature,
// distinct from the older scheduled `exportDocuments` mechanism the plan once
// mentioned.) Restore from the Firebase console → Firestore → Backups, or
// `gcloud firestore backups restore`.
//
// Idempotent: if a daily schedule already exists, the script reports it and
// exits without creating a duplicate.
//
// Usage (from client_database/admin/):
//   $env:GOOGLE_APPLICATION_CREDENTIALS = "C:\path\to\service-account-key.json"
//   node enable-backups.mjs            # create the daily schedule if missing
//   node enable-backups.mjs --list     # just list current schedules
//
// If the deploy service account lacks the permission (you'll see HTTP 403 with
// a "datastore.backupSchedules.create" message), either grant it
// `roles/datastore.owner` and re-run, or run the equivalent gcloud command
// yourself (uses your own credentials):
//   gcloud firestore backups schedules create \
//     --database='(default)' --recurrence=daily --retention=7d

import { GoogleAuth } from "google-auth-library";

const PROJECT_ID = "admin-automation-74110";
const DATABASE_ID = "(default)";
const RETENTION = "604800s"; // 7 days
const LIST_ONLY = process.argv.includes("--list");

if (!process.env.GOOGLE_APPLICATION_CREDENTIALS) {
  console.error("ERROR: set GOOGLE_APPLICATION_CREDENTIALS to the service account key path.");
  process.exit(1);
}

const auth = new GoogleAuth({ scopes: ["https://www.googleapis.com/auth/datastore"] });
const BASE =
  `https://firestore.googleapis.com/v1/projects/${PROJECT_ID}` +
  `/databases/${encodeURIComponent(DATABASE_ID)}/backupSchedules`;

async function token() { return await auth.getAccessToken(); }

async function listSchedules() {
  const res = await fetch(BASE, { headers: { Authorization: `Bearer ${await token()}` } });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`list HTTP ${res.status}: ${JSON.stringify(body).slice(0, 400)}`);
  return body.backupSchedules || [];
}

function describe(s) {
  const kind = s.dailyRecurrence ? "daily"
    : s.weeklyRecurrence ? `weekly(${s.weeklyRecurrence.day})` : "?";
  return `${s.name.split("/").pop()}  ${kind}  retention=${s.retention}`;
}

const existing = await listSchedules();
console.log(`Current backup schedules on ${DATABASE_ID}: ${existing.length}`);
for (const s of existing) console.log(`  ${describe(s)}`);

if (LIST_ONLY) process.exit(0);

if (existing.some((s) => s.dailyRecurrence)) {
  console.log("\nA daily backup schedule already exists — nothing to do.");
  process.exit(0);
}

const res = await fetch(BASE, {
  method: "POST",
  headers: {
    Authorization: `Bearer ${await token()}`,
    "Content-Type": "application/json",
  },
  body: JSON.stringify({ retention: RETENTION, dailyRecurrence: {} }),
});
const body = await res.json().catch(() => ({}));
if (!res.ok) {
  console.error(`\nCreate failed: HTTP ${res.status}\n${JSON.stringify(body, null, 2).slice(0, 700)}`);
  if (res.status === 403) {
    console.error(
      "\nThe service account is missing `datastore.backupSchedules.create`. " +
      "Grant it `roles/datastore.owner` and re-run, or use the gcloud command in this file's header."
    );
  }
  process.exit(1);
}
console.log(`\nCreated daily backup schedule: ${body.name}\n  retention: ${body.retention}`);
console.log(
  "Backups now run automatically once a day. Restore via the Firebase console " +
  "(Firestore → Backups) or `gcloud firestore backups restore`."
);
