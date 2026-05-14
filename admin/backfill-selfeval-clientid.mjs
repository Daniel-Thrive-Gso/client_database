// Backfill `clientId` onto legacy `selfEvaluations` docs that predate the
// client picker (those docs carry only a free-text `clientName` snapshot).
//
// Why: the data-model rule (plan §6a) is that every collection references the
// client by `clientId`; `clientName` is just a denormalized display snapshot.
// Self-evals created from 2026-05-07 onward already carry both. Older ones —
// and the 10 prototype/seed rows — only have `clientName`. This script matches
// those names against the `clients` collection and fills in `clientId`.
//
// Usage (from client_database/admin/):
//   $env:GOOGLE_APPLICATION_CREDENTIALS = "C:\path\to\service-account-key.json"
//
//   node backfill-selfeval-clientid.mjs
//       Report only. Lists every legacy doc and how it would be resolved
//       (matched / ambiguous / no-match). Writes nothing.
//
//   node backfill-selfeval-clientid.mjs --apply
//       Write `clientId` on every unambiguous name match.
//
//   node backfill-selfeval-clientid.mjs --apply --map resolved.json
//       Also apply a hand-written { "<selfEvalDocId>": "<clientId>" } map for
//       the ambiguous / no-match docs. (The report prints a fill-in skeleton.)
//       Empty-string values in the map are ignored, so you can leave a line
//       in place to skip that doc.
//
//   node backfill-selfeval-clientid.mjs --apply --refresh-names
//       Also rewrite `clientName` to the matched client's canonical display
//       name (First [Middle] Last, or alias). Off by default — the existing
//       snapshot is preserved unless you ask for this.
//
//   node backfill-selfeval-clientid.mjs --apply --delete-unmatched
//       DESTRUCTIVE. Also delete the no-match docs — i.e. the
//       prototype/seed rows ("Bob R.", "Alice T.", "fake client", …) that
//       don't correspond to any real client. ALWAYS run the plain report
//       first and eyeball the "no match" list; a real client who was renamed
//       after a self-eval was logged could also land there. Ambiguous docs
//       (which have real candidates) are never deleted — resolve those with
//       --map instead.
//
// Idempotent: docs that already have a non-empty `clientId` are skipped.

import { initializeApp, applicationDefault } from "firebase-admin/app";
import { getFirestore, FieldValue } from "firebase-admin/firestore";
import { readFileSync } from "node:fs";

const APPLY = process.argv.includes("--apply");
const REFRESH_NAMES = process.argv.includes("--refresh-names");
const DELETE_UNMATCHED = process.argv.includes("--delete-unmatched");
const mapFlagIdx = process.argv.indexOf("--map");
const MAP_PATH = mapFlagIdx !== -1 ? process.argv[mapFlagIdx + 1] : null;

if (!process.env.GOOGLE_APPLICATION_CREDENTIALS) {
  console.error(
    "ERROR: set GOOGLE_APPLICATION_CREDENTIALS to the service account key path."
  );
  process.exit(1);
}

initializeApp({ credential: applicationDefault() });
const db = getFirestore();

// Normalize a name for matching: fold non-breaking spaces, lowercase, drop
// periods/commas, collapse whitespace.
function norm(s) {
  return String(s || "")
    .replace(/[   ]/g, " ")
    .toLowerCase()
    .replace(/[.,]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// Mirrors clientDisplayName() in public/app.js — the form used to populate the
// `clientName` snapshot when a self-eval is created via the picker.
function displayName(d) {
  return (
    [d.firstName, d.middleName, d.lastName].filter(Boolean).join(" ") ||
    d.alias ||
    ""
  );
}

function dobStr(c) {
  if (c.dob?.toDate) return c.dob.toDate().toISOString().slice(0, 10);
  if (typeof c.dob === "string") return c.dob;
  if (c.dobString) return c.dobString;
  return "?";
}

// ---- Build name -> Set(clientId) index from the clients collection ----------
const clientsSnap = await db.collection("clients").get();
const nameIndex = new Map(); // normalized name -> Set<clientId>
const clientById = new Map(); // clientId -> data

function addName(name, id) {
  const k = norm(name);
  if (!k) return;
  if (!nameIndex.has(k)) nameIndex.set(k, new Set());
  nameIndex.get(k).add(id);
}

for (const docSnap of clientsSnap.docs) {
  const d = docSnap.data();
  clientById.set(docSnap.id, d);
  const fn = (d.firstName || "").trim();
  const mn = (d.middleName || "").trim();
  const ln = (d.lastName || "").trim();
  addName(displayName(d), docSnap.id); // "First Middle Last" / "First Last" / alias
  addName([fn, ln].filter(Boolean).join(" "), docSnap.id); // "First Last" even when a middle name exists
  if (fn && mn && ln) addName(`${fn} ${mn[0]} ${ln}`, docSnap.id); // "First M Last"
  if (fn && ln) addName(`${ln}, ${fn}`, docSnap.id); // "Last, First"
  if (d.alias) addName(d.alias, docSnap.id);
  if (d.preferredName) {
    addName(d.preferredName, docSnap.id);
    if (ln) addName(`${d.preferredName} ${ln}`, docSnap.id);
  }
}
console.log(
  `Indexed ${clientsSnap.size} clients (${nameIndex.size} distinct name keys).`
);

// ---- Optional manual override map ------------------------------------------
let manualMap = {};
if (MAP_PATH) {
  manualMap = JSON.parse(readFileSync(MAP_PATH, "utf8"));
  for (const [docId, cid] of Object.entries(manualMap)) {
    if (!cid) continue; // empty value = "skip this doc"
    if (!clientById.has(cid)) {
      console.error(
        `--map: clientId "${cid}" (for selfEval ${docId}) is not in the clients collection. Aborting; fix the map.`
      );
      process.exit(1);
    }
  }
  const used = Object.values(manualMap).filter(Boolean).length;
  console.log(`Loaded manual map: ${used} usable entr${used === 1 ? "y" : "ies"}.`);
}

// ---- Walk selfEvaluations ---------------------------------------------------
const seSnap = await db.collection("selfEvaluations").get();
const matched = []; // { docId, clientName, clientId, via }
const ambiguous = []; // { docId, clientName, candidates: [{ id, name, dob }] }
const unmatched = []; // { docId, clientName }
let alreadyHadId = 0;

for (const docSnap of seSnap.docs) {
  const d = docSnap.data();
  if (d.clientId && String(d.clientId).trim()) {
    alreadyHadId++;
    continue;
  }

  if (manualMap[docSnap.id]) {
    matched.push({
      docId: docSnap.id,
      clientName: d.clientName || "",
      clientId: manualMap[docSnap.id],
      via: "manual map",
    });
    continue;
  }

  const key = norm(d.clientName);
  const hits = key ? nameIndex.get(key) : null;
  if (!hits || hits.size === 0) {
    unmatched.push({ docId: docSnap.id, clientName: d.clientName || "(empty)" });
  } else if (hits.size === 1) {
    matched.push({
      docId: docSnap.id,
      clientName: d.clientName || "",
      clientId: [...hits][0],
      via: "name match",
    });
  } else {
    ambiguous.push({
      docId: docSnap.id,
      clientName: d.clientName || "",
      candidates: [...hits].map((id) => {
        const c = clientById.get(id) || {};
        return { id, name: displayName(c), dob: dobStr(c) };
      }),
    });
  }
}

console.log(
  `\nselfEvaluations: ${seSnap.size} total — ${alreadyHadId} already have clientId, ${seSnap.size - alreadyHadId} to resolve.`
);
console.log(`  ${matched.length} matched`);
console.log(`  ${ambiguous.length} ambiguous (multiple clients share that name)`);
console.log(`  ${unmatched.length} no match (prototype/seed data, or a renamed client)`);

if (matched.length) {
  console.log(`\n--- matched ---`);
  for (const m of matched)
    console.log(`  ${m.docId}  "${m.clientName}"  ->  ${m.clientId}  (${m.via})`);
}
if (ambiguous.length) {
  console.log(`\n--- ambiguous (resolve via --map) ---`);
  for (const a of ambiguous) {
    console.log(`  ${a.docId}  "${a.clientName}"`);
    for (const c of a.candidates)
      console.log(`      ${c.id}  ${c.name}  dob=${c.dob}`);
  }
}
if (unmatched.length) {
  console.log(
    `\n--- no match (resolve via --map, leave as-is, or delete with --apply --delete-unmatched) ---`
  );
  for (const u of unmatched) console.log(`  ${u.docId}  "${u.clientName}"`);
}

if (ambiguous.length + unmatched.length > 0) {
  const skeleton = {};
  for (const a of ambiguous) skeleton[a.docId] = ""; // fill with one of the candidate ids
  for (const u of unmatched) skeleton[u.docId] = ""; // fill with a clientId, or leave "" to skip
  console.log(
    `\nMap skeleton for the ${ambiguous.length + unmatched.length} unresolved doc(s) — fill in clientIds, save as JSON, re-run with --apply --map <file>:`
  );
  console.log(JSON.stringify(skeleton, null, 2));
}

// ---- Apply ------------------------------------------------------------------
if (!APPLY) {
  console.log(`\n(report only — re-run with --apply to write. Nothing was changed.)`);
  process.exit(0);
}

const willDelete = DELETE_UNMATCHED ? unmatched : [];
if (matched.length === 0 && willDelete.length === 0) {
  console.log(`\nNothing to write or delete.`);
  process.exit(0);
}

// --- writes (clientId backfill) ---
let written = 0;
const CHUNK = 400;
for (let i = 0; i < matched.length; i += CHUNK) {
  const chunk = matched.slice(i, i + CHUNK);
  const batch = db.batch();
  for (const m of chunk) {
    const update = {
      clientId: m.clientId,
      clientIdBackfilledAt: FieldValue.serverTimestamp(),
      clientIdBackfilledBy: "backfill-selfeval-clientid.mjs",
    };
    if (REFRESH_NAMES) {
      const canon = displayName(clientById.get(m.clientId) || {});
      if (canon) update.clientName = canon;
    }
    batch.update(db.collection("selfEvaluations").doc(m.docId), update);
  }
  await batch.commit();
  written += chunk.length;
  console.log(`  wrote ${written}/${matched.length}`);
}

// --- deletes (prototype/no-match cleanup) ---
let deleted = 0;
if (willDelete.length) {
  console.log(
    `\n!! --delete-unmatched: removing ${willDelete.length} no-match selfEvaluations doc(s). !!`
  );
  for (let i = 0; i < willDelete.length; i += CHUNK) {
    const chunk = willDelete.slice(i, i + CHUNK);
    const batch = db.batch();
    for (const u of chunk) batch.delete(db.collection("selfEvaluations").doc(u.docId));
    await batch.commit();
    deleted += chunk.length;
    console.log(`  deleted ${deleted}/${willDelete.length}`);
  }
}

// One summary audit entry (mirrors the accessLog shape used by the app).
await db.collection("accessLog").add({
  userId: "admin-script",
  userEmail: "backfill-selfeval-clientid.mjs",
  action: deleted > 0 ? "delete" : "update",
  entityType: "selfEvaluation",
  entityId: null,
  timestamp: FieldValue.serverTimestamp(),
  metadata: {
    kind: "backfill-clientid",
    updated: written,
    deleted,
    refreshedNames: REFRESH_NAMES,
    usedManualMap: !!MAP_PATH,
    remainingAmbiguous: ambiguous.length,
    remainingUnmatched: DELETE_UNMATCHED ? 0 : unmatched.length,
  },
});

console.log(
  `\nDone. ${written} doc(s) updated with clientId${deleted ? `; ${deleted} no-match doc(s) deleted` : ""}.`
);
const stillOpen = ambiguous.length + (DELETE_UNMATCHED ? 0 : unmatched.length);
if (stillOpen > 0) {
  console.log(
    `${stillOpen} still unresolved — fill in the map skeleton above and re-run with --map.`
  );
}
