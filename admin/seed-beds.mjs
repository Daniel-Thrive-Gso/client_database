// One-shot seed: creates the 24 bed documents at beds/{bedId}.
//
// Usage (from client_database/admin/):
//   $env:GOOGLE_APPLICATION_CREDENTIALS = "C:\path\to\service-account-key.json"
//   node seed-beds.mjs [--dry-run] [--force]
//
// Idempotent: existing beds are NOT overwritten unless --force is passed.
// Without --force, any docs that already exist keep their occupancy data;
// only newly added beds get the empty initial state. This means re-running
// after rooms are reorganized is safe.

import { initializeApp, applicationDefault } from "firebase-admin/app";
import { getFirestore, FieldValue } from "firebase-admin/firestore";

const DORMS = {
  alpha: { label: "Alpha Dorm", beds: ["A-1", "A-2", "A-3", "A-4", "A-5"] },
  bravo: { label: "Bravo Dorm", beds: ["B-1", "B-2", "B-3", "B-4", "B-5", "B-6", "B-7"] },
  charlie: { label: "Charlie Dorm", beds: ["C-1", "C-2", "C-3", "C-4", "C-5", "C-6", "C-7", "C-8", "C-9"] },
  veterans: { label: "Veterans Dorm", beds: ["V-1", "V-2", "V-3"] },
};

const dryRun = process.argv.includes("--dry-run");
const force = process.argv.includes("--force");

if (!process.env.GOOGLE_APPLICATION_CREDENTIALS && !dryRun) {
  console.error(
    "ERROR: set GOOGLE_APPLICATION_CREDENTIALS to the service account key path, or pass --dry-run."
  );
  process.exit(1);
}

const records = [];
for (const [dormKey, dorm] of Object.entries(DORMS)) {
  for (const bedId of dorm.beds) {
    records.push({ docId: bedId, dorm: dormKey, dormLabel: dorm.label, bedId });
  }
}

console.log(`Seeding ${records.length} beds across ${Object.keys(DORMS).length} dorms`);

if (dryRun) {
  for (const r of records) console.log("  ", r.dorm, r.bedId);
  console.log("\n--dry-run: not writing to Firestore.");
  process.exit(0);
}

initializeApp({ credential: applicationDefault() });
const db = getFirestore();
const colRef = db.collection("beds");

let created = 0;
let skipped = 0;
for (const r of records) {
  const ref = colRef.doc(r.docId);
  const snap = await ref.get();
  if (snap.exists && !force) {
    skipped++;
    continue;
  }
  await ref.set({
    dorm: r.dorm,
    dormLabel: r.dormLabel,
    bedId: r.bedId,
    occupiedBy: null,
    occupiedByName: null,
    occupiedSince: null,
    assignedBy: null,
    updatedAt: FieldValue.serverTimestamp(),
    updatedBy: "seed-beds.mjs",
  }, { merge: force });
  created++;
}
console.log(`Done. ${created} bed docs written; ${skipped} already existed and were left alone.`);
if (skipped > 0 && !force) {
  console.log("Pass --force to overwrite existing bed docs (this clears any current occupancy).");
}
