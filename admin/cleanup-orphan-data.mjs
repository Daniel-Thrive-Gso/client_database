// Cleanup ORPHAN data — every per-client doc whose clientId no longer has
// a matching clients/{cid} master record. Use this after manually deleting
// fake-client master docs from the Firebase console: the master rows are
// gone, but related rows in intakes/exits/drugTests/etc. still exist and
// reference the now-missing client.
//
// Usage (from client_database/admin/):
//   $env:GOOGLE_APPLICATION_CREDENTIALS = "C:\path\to\service-account-key.json"
//   node cleanup-orphan-data.mjs              # dry-run (default — no writes)
//   node cleanup-orphan-data.mjs --apply      # actually delete
//
// Algorithm:
//   1. Read every clientId in `clients/`. These are "valid".
//   2. Scan every per-client collection + embedded references and collect
//      every distinct clientId present.
//   3. Orphans = (everything seen) - (valid set).
//   4. For each orphan: delete all per-client docs across the per-client
//      collections, blank embedded references in dailyGuestRoster and
//      thriftStoreSchedule, free any beds, delete storage objects under
//      clients/{cid}/, and delete the Firebase Auth client user.
//
// accessLog is intentionally NOT touched — that's the audit trail.

import { initializeApp, applicationDefault } from "firebase-admin/app";
import { getFirestore, FieldValue } from "firebase-admin/firestore";
import { getAuth } from "firebase-admin/auth";
import { getStorage } from "firebase-admin/storage";

const APPLY = process.argv.includes("--apply");

if (!process.env.GOOGLE_APPLICATION_CREDENTIALS) {
  console.error("ERROR: GOOGLE_APPLICATION_CREDENTIALS env var is not set.");
  console.error("Point it at the admin service account JSON file before running.");
  process.exit(1);
}

initializeApp({ credential: applicationDefault() });
const db = getFirestore();
const auth = getAuth();
const bucket = getStorage().bucket();

const PER_CLIENT_COLLECTIONS = [
  "intakes",
  "exits",
  "drugTests",
  "medications",
  "clientStatusUpdates",
  "selfEvaluations",
  "checkInOuts",
  "mealLog",
  "showerLog",
  "clientWeeklySchedule",
  "pendingClientSubmissions",
];

async function listValidClientIds() {
  const snap = await db.collection("clients").get();
  return new Set(snap.docs.map((d) => d.id));
}

async function collectOrphansFromCollection(coll, validIds) {
  const snap = await db.collection(coll).get();
  const orphanIds = new Set();
  const docsByCid = new Map(); // cid -> [docRef, ...]
  for (const d of snap.docs) {
    const cid = d.data().clientId;
    if (!cid || typeof cid !== "string") continue;
    if (!validIds.has(cid)) {
      orphanIds.add(cid);
      if (!docsByCid.has(cid)) docsByCid.set(cid, []);
      docsByCid.get(cid).push(d.ref);
    }
  }
  return { orphanIds, docsByCid };
}

async function collectOrphansFromRoster(validIds) {
  // dailyGuestRoster docs have an embedded `guests` array of objects with
  // clientId. Returns orphan ids + the docs they appear in.
  const snap = await db.collection("dailyGuestRoster").get();
  const orphanIds = new Set();
  const docRefsByCid = new Map();
  for (const d of snap.docs) {
    const arr = Array.isArray(d.data().guests) ? d.data().guests : [];
    for (const g of arr) {
      const cid = g?.clientId;
      if (!cid || typeof cid !== "string") continue;
      if (!validIds.has(cid)) {
        orphanIds.add(cid);
        if (!docRefsByCid.has(cid)) docRefsByCid.set(cid, new Set());
        docRefsByCid.get(cid).add(d.id);
      }
    }
  }
  return { orphanIds, docRefsByCid };
}

async function collectOrphansFromThrift(validIds) {
  const snap = await db.collection("thriftStoreSchedule").get();
  const orphanIds = new Set();
  const docRefsByCid = new Map();
  for (const d of snap.docs) {
    const arr = Array.isArray(d.data().shifts) ? d.data().shifts : [];
    for (const s of arr) {
      const cid = s?.clientId;
      if (!cid || typeof cid !== "string") continue;
      if (!validIds.has(cid)) {
        orphanIds.add(cid);
        if (!docRefsByCid.has(cid)) docRefsByCid.set(cid, new Set());
        docRefsByCid.get(cid).add(d.id);
      }
    }
  }
  return { orphanIds, docRefsByCid };
}

async function collectOrphansFromBeds(validIds) {
  const snap = await db.collection("beds").get();
  const orphanIds = new Set();
  const bedIdsByCid = new Map();
  for (const d of snap.docs) {
    const cid = d.data().occupiedBy;
    if (!cid || typeof cid !== "string") continue;
    if (!validIds.has(cid)) {
      orphanIds.add(cid);
      if (!bedIdsByCid.has(cid)) bedIdsByCid.set(cid, []);
      bedIdsByCid.get(cid).push(d.id);
    }
  }
  return { orphanIds, bedIdsByCid };
}

async function collectOrphansFromStorage(validIds) {
  // Storage layout is clients/{cid}/... so list the top-level prefixes.
  // The Admin SDK doesn't expose "list folders" directly; iterate every
  // file and bucket by the 2nd path segment.
  const orphanIds = new Set();
  const filesByCid = new Map();
  const [files] = await bucket.getFiles({ prefix: "clients/" });
  for (const f of files) {
    const parts = f.name.split("/");
    // Expect: clients / {cid} / ...
    if (parts.length < 3) continue;
    const cid = parts[1];
    if (!validIds.has(cid)) {
      orphanIds.add(cid);
      if (!filesByCid.has(cid)) filesByCid.set(cid, []);
      filesByCid.get(cid).push(f);
    }
  }
  return { orphanIds, filesByCid };
}

async function collectOrphansFromAuth(validIds) {
  const orphanIds = new Set();
  const usersByCid = new Map();
  let pageToken;
  do {
    const page = await auth.listUsers(1000, pageToken);
    for (const u of page.users) {
      const claims = u.customClaims || {};
      if (claims.role !== "client") continue;
      const cid = claims.clientId;
      if (!cid || typeof cid !== "string") continue;
      if (!validIds.has(cid)) {
        orphanIds.add(cid);
        if (!usersByCid.has(cid)) usersByCid.set(cid, []);
        usersByCid.get(cid).push({ uid: u.uid, email: u.email || "(no email)" });
      }
    }
    pageToken = page.pageToken;
  } while (pageToken);
  return { orphanIds, usersByCid };
}

async function deleteRefsInBatches(refs) {
  if (!refs || refs.length === 0) return 0;
  let count = 0;
  let batch = db.batch();
  let n = 0;
  for (const ref of refs) {
    batch.delete(ref);
    n++;
    count++;
    if (n >= 400) {
      await batch.commit();
      batch = db.batch();
      n = 0;
    }
  }
  if (n > 0) await batch.commit();
  return count;
}

async function deleteFiles(files) {
  if (!files || files.length === 0) return 0;
  let i = 0;
  const CONCURRENCY = 8;
  let deleted = 0;
  async function worker() {
    while (i < files.length) {
      const my = i++;
      try {
        await files[my].delete({ ignoreNotFound: true });
        deleted++;
      } catch (err) {
        console.error(`  storage delete failed for ${files[my].name}: ${err.message}`);
      }
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  return deleted;
}

async function pruneRosterDocs(orphanSet, docIds) {
  let touched = 0;
  let removed = 0;
  for (const id of docIds) {
    const ref = db.collection("dailyGuestRoster").doc(id);
    const snap = await ref.get();
    if (!snap.exists) continue;
    const arr = Array.isArray(snap.data().guests) ? snap.data().guests : [];
    const filtered = arr.filter((g) => !orphanSet.has(g?.clientId));
    if (filtered.length !== arr.length) {
      touched++;
      removed += arr.length - filtered.length;
      if (APPLY) await ref.update({ guests: filtered });
    }
  }
  return { touched, removed };
}

async function pruneThriftDocs(orphanSet, docIds) {
  let touched = 0;
  let blanked = 0;
  for (const id of docIds) {
    const ref = db.collection("thriftStoreSchedule").doc(id);
    const snap = await ref.get();
    if (!snap.exists) continue;
    const shifts = Array.isArray(snap.data().shifts) ? snap.data().shifts : [];
    let changed = false;
    const next = shifts.map((s) => {
      if (orphanSet.has(s?.clientId)) {
        changed = true;
        blanked++;
        return { ...s, clientId: "", clientName: "" };
      }
      return s;
    });
    if (changed) {
      touched++;
      if (APPLY) {
        await ref.update({
          shifts: next,
          updatedAt: FieldValue.serverTimestamp(),
          updatedBy: "cleanup-orphan-data.mjs",
        });
      }
    }
  }
  return { touched, blanked };
}

async function freeBed(bedId) {
  await db.collection("beds").doc(bedId).update({
    occupiedBy: null,
    occupiedByName: null,
    occupiedSince: null,
    assignedBy: null,
    updatedAt: FieldValue.serverTimestamp(),
    updatedBy: "cleanup-orphan-data.mjs",
  });
}

async function main() {
  console.log(`Mode: ${APPLY ? "APPLY (writes will happen)" : "DRY RUN (no writes)"}`);
  console.log("");

  const validIds = await listValidClientIds();
  console.log(`Valid clientIds in clients/ collection: ${validIds.size}`);
  for (const id of validIds) console.log(`  ${id}`);
  console.log("");

  // Scan every source of clientIds.
  const collectionResults = {};
  const allOrphans = new Set();
  for (const coll of PER_CLIENT_COLLECTIONS) {
    const r = await collectOrphansFromCollection(coll, validIds);
    collectionResults[coll] = r;
    for (const cid of r.orphanIds) allOrphans.add(cid);
  }

  const roster = await collectOrphansFromRoster(validIds);
  for (const cid of roster.orphanIds) allOrphans.add(cid);

  const thrift = await collectOrphansFromThrift(validIds);
  for (const cid of thrift.orphanIds) allOrphans.add(cid);

  const beds = await collectOrphansFromBeds(validIds);
  for (const cid of beds.orphanIds) allOrphans.add(cid);

  const storage = await collectOrphansFromStorage(validIds);
  for (const cid of storage.orphanIds) allOrphans.add(cid);

  const authOrphans = await collectOrphansFromAuth(validIds);
  for (const cid of authOrphans.orphanIds) allOrphans.add(cid);

  if (allOrphans.size === 0) {
    console.log("No orphan clientIds found. Nothing to clean up.");
    return;
  }

  console.log(`Orphan clientIds found (no matching clients/{cid} doc): ${allOrphans.size}`);
  for (const cid of allOrphans) console.log(`  ${cid}`);
  console.log("");

  console.log("Per-orphan plan:");
  for (const cid of allOrphans) {
    const parts = [];
    for (const coll of PER_CLIENT_COLLECTIONS) {
      const refs = collectionResults[coll].docsByCid.get(cid) || [];
      if (refs.length > 0) parts.push(`${coll}=${refs.length}`);
    }
    const rosterDocs = roster.docRefsByCid.get(cid);
    if (rosterDocs?.size) parts.push(`roster-days=${rosterDocs.size}`);
    const thriftDocs = thrift.docRefsByCid.get(cid);
    if (thriftDocs?.size) parts.push(`thrift-weeks=${thriftDocs.size}`);
    const occupiedBeds = beds.bedIdsByCid.get(cid);
    if (occupiedBeds?.length) parts.push(`beds=${occupiedBeds.length}`);
    const files = storage.filesByCid.get(cid);
    if (files?.length) parts.push(`storage=${files.length}`);
    const users = authOrphans.usersByCid.get(cid);
    if (users?.length) parts.push(`auth-users=${users.length}`);
    console.log(`  ${cid} -> ${parts.length ? parts.join(", ") : "(nothing to remove)"}`);
  }

  if (!APPLY) {
    console.log("\nDRY RUN complete — re-run with --apply to perform deletes.");
    return;
  }

  console.log("\nApplying deletes…");
  for (const cid of allOrphans) {
    console.log(`  ${cid}`);
    for (const coll of PER_CLIENT_COLLECTIONS) {
      const refs = collectionResults[coll].docsByCid.get(cid) || [];
      const n = await deleteRefsInBatches(refs);
      if (n > 0) console.log(`    deleted ${n} doc(s) from ${coll}`);
    }
    const files = storage.filesByCid.get(cid) || [];
    const sn = await deleteFiles(files);
    if (sn > 0) console.log(`    deleted ${sn} storage object(s) under clients/${cid}/`);
    const bedIds = beds.bedIdsByCid.get(cid) || [];
    for (const bedId of bedIds) {
      await freeBed(bedId);
      console.log(`    freed bed ${bedId}`);
    }
    const users = authOrphans.usersByCid.get(cid) || [];
    for (const u of users) {
      try {
        await auth.deleteUser(u.uid);
        console.log(`    deleted auth user ${u.uid} ${u.email}`);
      } catch (err) {
        console.error(`    auth delete failed for ${u.uid}: ${err.message}`);
      }
    }
  }

  // Embedded references (roster + thrift) need the full orphan set in one
  // pass so a single doc carrying multiple orphans is only re-saved once.
  const rosterRes = await pruneRosterDocs(allOrphans, Array.from(new Set([...roster.docRefsByCid.values()].flatMap((s) => [...s]))));
  console.log(`  dailyGuestRoster: ${rosterRes.touched} doc(s) updated, ${rosterRes.removed} guest row(s) removed`);
  const thriftRes = await pruneThriftDocs(allOrphans, Array.from(new Set([...thrift.docRefsByCid.values()].flatMap((s) => [...s]))));
  console.log(`  thriftStoreSchedule: ${thriftRes.touched} doc(s) updated, ${thriftRes.blanked} shift(s) blanked`);

  console.log("\nAPPLY complete.");
}

main().catch((err) => {
  console.error("FATAL:", err);
  process.exit(1);
});
