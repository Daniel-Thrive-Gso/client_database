// One-shot seed: imports the medication catalog from
//   admin_automation/intake_forms/Medications.csv
// into Firestore at medicationCatalog/{docId}.
//
// Usage (from client_database/admin/):
//   $env:GOOGLE_APPLICATION_CREDENTIALS = "C:\path\to\service-account-key.json"
//   node seed-medication-catalog.mjs [--dry-run]
//
// Re-runs are idempotent — each row is set() with merge by sanitized name.

import { initializeApp, applicationDefault } from "firebase-admin/app";
import { getFirestore, FieldValue } from "firebase-admin/firestore";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CSV_PATH = resolve(
  __dirname,
  "../../admin_automation/intake_forms/Medications.csv"
);

const dryRun = process.argv.includes("--dry-run");

if (!process.env.GOOGLE_APPLICATION_CREDENTIALS && !dryRun) {
  console.error(
    "ERROR: set GOOGLE_APPLICATION_CREDENTIALS to the service account key path, or pass --dry-run."
  );
  process.exit(1);
}

// Minimal CSV line parser: supports quoted fields with embedded commas and
// escaped quotes (""). The source file has no multi-line cells.
function parseCsvLine(line) {
  const out = [];
  let cur = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inQuotes) {
      if (c === '"') {
        if (line[i + 1] === '"') { cur += '"'; i++; }
        else inQuotes = false;
      } else cur += c;
    } else {
      if (c === '"') inQuotes = true;
      else if (c === ",") { out.push(cur); cur = ""; }
      else cur += c;
    }
  }
  out.push(cur);
  return out;
}

// The source CSV came out of Excel with non-breaking spaces (U+00A0) and
// occasional replacement chars between words; collapse all of that to single
// ASCII spaces.
function normalizeText(s) {
  return s
    .replace(/[   ]/g, " ")
    .replace(/�/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// Firestore doc IDs may not contain '/' and may not exceed 1500 bytes.
function toDocId(name) {
  return name.replace(/\//g, "-").replace(/[\x00-\x1f]/g, "").slice(0, 1000);
}

const raw = readFileSync(CSV_PATH, "utf8");
const lines = raw.split(/\r?\n/);

// Catalog occupies columns G/H/I (indexes 6/7/8). Row 1 is the header.
const records = [];
const seenIds = new Map();
for (let i = 1; i < lines.length; i++) {
  const cells = parseCsvLine(lines[i]);
  const name = normalizeText(cells[6] || "");
  if (!name || name.toLowerCase() === "medications") continue;
  const reasonsForMedication = normalizeText(cells[7] || "");
  const sideEffects = normalizeText(cells[8] || "");
  const docId = toDocId(name);
  if (seenIds.has(docId)) {
    console.warn(
      `skip duplicate id "${docId}" from "${name}" at line ${i + 1} (kept "${seenIds.get(docId)}")`
    );
    continue;
  }
  seenIds.set(docId, name);
  records.push({ docId, name, reasonsForMedication, sideEffects });
}

console.log(`Parsed ${records.length} medications from ${CSV_PATH}`);

if (dryRun) {
  console.log("\nFirst 5 records:");
  for (const r of records.slice(0, 5)) console.log("  ", r);
  console.log("\nLast 3 records:");
  for (const r of records.slice(-3)) console.log("  ", r);
  console.log("\n--dry-run: not writing to Firestore.");
  process.exit(0);
}

initializeApp({ credential: applicationDefault() });
const db = getFirestore();

const colRef = db.collection("medicationCatalog");
let written = 0;
const CHUNK = 400;
for (let i = 0; i < records.length; i += CHUNK) {
  const chunk = records.slice(i, i + CHUNK);
  const batch = db.batch();
  for (const r of chunk) {
    batch.set(
      colRef.doc(r.docId),
      {
        name: r.name,
        reasonsForMedication: r.reasonsForMedication,
        sideEffects: r.sideEffects,
        updatedAt: FieldValue.serverTimestamp(),
      },
      { merge: true }
    );
  }
  await batch.commit();
  written += chunk.length;
  console.log(`  wrote ${written}/${records.length}`);
}
console.log(`Done. ${written} medicationCatalog entries upserted.`);
