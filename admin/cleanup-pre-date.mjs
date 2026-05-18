// Cleanup clients created before a cutoff date — modeled on
// cleanup-test-clients.mjs but date-filtered (clients/{cid}.createdAt < CUTOFF)
// instead of name-based.
//
// Default cutoff is 2026-05-13 (per Daniel's request on 2026-05-14 to clear
// pre-go-live test intakes). Override at the command line:
//   node cleanup-pre-date.mjs --before=2026-05-13            # dry run
//   node cleanup-pre-date.mjs --before=2026-05-13 --apply    # delete
//
// Usage (from client_database/admin/):
//   $env:GOOGLE_APPLICATION_CREDENTIALS = "C:\path\to\service-account-key.json"
//   node cleanup-pre-date.mjs                # dry-run, default cutoff
//   node cleanup-pre-date.mjs --apply        # delete with default cutoff
//
// What gets deleted for every client whose createdAt < CUTOFF:
//   * clients/{cid} master doc
//   * clients/{cid} subcollections: sensitive, auth, odh206, consents,
//     scannedDocs, phiRecords
//   * Per-clientId docs in: intakes, exits, drugTests, medications,
//     clientStatusUpdates, selfEvaluations, checkInOuts, mealLog,
//     showerLog, clientWeeklySchedule, pendingClientSubmissions
//   * dailyGuestRoster — removes the client from the embedded `guests`
//     array on every per-day doc that mentioned them
//   * thriftStoreSchedule — blanks shifts where clientId == cid
//   * beds — frees any bed where occupiedBy == cid
//   * Cloud Storage objects under clients/{cid}/
//   * Firebase Auth user(s) carrying a clientId custom claim that matches
//
// accessLog entries are intentionally kept — that's the tamper-evident
// audit trail and we don't delete from it.
//
// Clients with no `createdAt` field are KEPT by default (safer), and a
// warning is printed so they can be inspected manually.

import { initializeApp, applicationDefault } from "firebase-admin/app";
import { getFirestore, FieldValue, Timestamp } from "firebase-admin/firestore";
import { getAuth } from "firebase-admin/auth";
import { getStorage } from "firebase-admin/storage";

const DEFAULT_CUTOFF = "2026-05-13";
const APPLY = process.argv.includes("--apply");

function parseCutoff() {
  const arg = process.argv.find((a) => a.startsWith("--before="));
  const value = arg ? arg.slice("--before=".length) : DEFAULT_CUTOFF;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    console.error(`ERROR: --before must be YYYY-MM-DD (got "${value}").`);
    process.exit(1);
  }
  // Local-midnight on the cutoff date. Everything strictly before this is deleted.
  const d = new Date(`${value}T00:00:00`);
  if (isNaN(d)) {
    console.error(`ERROR: could not parse cutoff date "${value}".`);
    process.exit(1);
  }
  return { iso: value, ts: Timestamp.fromDate(d) };
}

const CUTOFF = parseCutoff();

if (!process.env.GOOGLE_APPLICATION_CREDENTIALS) {
  console.error("ERROR: GOOGLE_APPLICATION_CREDENTIALS env var is not set.");
  console.error("Point it at the admin service account JSON file before running.");
  process.exit(1);
}

initializeApp({
  credential: applicationDefault(),
  storageBucket: "admin-automation-74110.firebasestorage.app",
});
const db = getFirestore();
const auth = getAuth();
const bucket = getStorage().bucket();

// Collections that have a top-level `clientId` field on each doc and
// should be wiped per-client by query.
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

// Subcollections under clients/{cid}.
const CLIENT_SUBCOLLECTIONS = [
  "sensitive",
  "auth",
  "odh206",
  "consents",
  "scannedDocs",
  "phiRecords",
];

function tsMs(ts) {
  if (!ts) return null;
  if (typeof ts.toMillis === "function") return ts.toMillis();
  if (typeof ts.seconds === "number") return ts.seconds * 1000;
  return null;
}

async function listAllClients() {
  const snap = await db.collection("clients").get();
  return snap.docs.map((d) => ({ id: d.id, data: d.data() }));
}

async function countSubcollection(cid, sub) {
  const snap = await db.collection("clients").doc(cid).collection(sub).get();
  return snap.size;
}

async function countPerClient(coll, cid) {
  const snap = await db.collection(coll).where("clientId", "==", cid).get();
  return snap.size;
}

async function deleteSubcollection(cid, sub) {
  const snap = await db.collection("clients").doc(cid).collection(sub).get();
  if (snap.empty) return 0;
  let count = 0;
  let batch = db.batch();
  let n = 0;
  for (const d of snap.docs) {
    batch.delete(d.ref);
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

async function deletePerClient(coll, cid) {
  const snap = await db.collection(coll).where("clientId", "==", cid).get();
  if (snap.empty) return 0;
  let count = 0;
  let batch = db.batch();
  let n = 0;
  for (const d of snap.docs) {
    batch.delete(d.ref);
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

async function deleteStoragePrefix(cid) {
  const prefix = `clients/${cid}/`;
  const [files] = await bucket.getFiles({ prefix });
  if (files.length === 0) return 0;
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

async function countStoragePrefix(cid) {
  const [files] = await bucket.getFiles({ prefix: `clients/${cid}/` });
  return files.length;
}

async function purgeRosterMentions(cidSet) {
  const snap = await db.collection("dailyGuestRoster").get();
  let touched = 0;
  let removed = 0;
  for (const d of snap.docs) {
    const data = d.data();
    const arr = Array.isArray(data.guests) ? data.guests : [];
    const filtered = arr.filter((g) => !cidSet.has(g.clientId));
    if (filtered.length !== arr.length) {
      touched++;
      removed += arr.length - filtered.length;
      if (APPLY) await d.ref.update({ guests: filtered });
    }
  }
  return { touched, removed };
}

async function purgeThriftShifts(cidSet) {
  const snap = await db.collection("thriftStoreSchedule").get();
  let touched = 0;
  let blanked = 0;
  for (const d of snap.docs) {
    const data = d.data();
    const shifts = Array.isArray(data.shifts) ? data.shifts : [];
    let changed = false;
    const next = shifts.map((s) => {
      if (cidSet.has(s.clientId)) {
        changed = true;
        blanked++;
        return { ...s, clientId: "", clientName: "" };
      }
      return s;
    });
    if (changed) {
      touched++;
      if (APPLY) await d.ref.update({ shifts: next });
    }
  }
  return { touched, blanked };
}

async function freeBeds(cidSet) {
  const snap = await db.collection("beds").get();
  let freed = 0;
  for (const d of snap.docs) {
    const occ = d.data().occupiedBy;
    if (occ && cidSet.has(occ)) {
      freed++;
      if (APPLY) {
        await d.ref.update({
          occupiedBy: null,
          occupiedByName: null,
          occupiedSince: null,
          assignedBy: null,
          updatedAt: FieldValue.serverTimestamp(),
          updatedBy: "cleanup-pre-date.mjs",
        });
      }
    }
  }
  return freed;
}

async function findClientAuthUsers(cidSet) {
  const out = [];
  let pageToken;
  do {
    const page = await auth.listUsers(1000, pageToken);
    for (const u of page.users) {
      const claims = u.customClaims || {};
      if (claims.role === "client" && cidSet.has(claims.clientId)) {
        out.push({ uid: u.uid, email: u.email || "(no email)", clientId: claims.clientId });
      }
    }
    pageToken = page.pageToken;
  } while (pageToken);
  return out;
}

async function main() {
  console.log(`Mode: ${APPLY ? "APPLY (writes will happen)" : "DRY RUN (no writes)"}`);
  console.log(`Cutoff: delete clients with createdAt < ${CUTOFF.iso} (local midnight)`);
  console.log("");

  const cutoffMs = CUTOFF.ts.toMillis();
  const allClients = await listAllClients();
  console.log(`Found ${allClients.length} total client(s) in clients/ collection.`);

  const noCreatedAt = [];
  const keepers = [];
  const toDelete = [];

  for (const c of allClients) {
    const ms = tsMs(c.data.createdAt);
    if (ms == null) {
      noCreatedAt.push(c);
    } else if (ms < cutoffMs) {
      toDelete.push(c);
    } else {
      keepers.push(c);
    }
  }

  console.log("");
  console.log(`KEEPING (${keepers.length}) — createdAt on or after ${CUTOFF.iso}:`);
  for (const c of keepers) {
    const created = c.data.createdAt?.toDate
      ? c.data.createdAt.toDate().toISOString().slice(0, 10)
      : "?";
    console.log(`  ${c.id}  ${c.data.firstName || ""} ${c.data.lastName || ""}  createdAt=${created}  status=${c.data.status || "?"}`);
  }

  if (noCreatedAt.length) {
    console.log("");
    console.log(`SKIPPED (${noCreatedAt.length}) — no createdAt field; inspect manually:`);
    for (const c of noCreatedAt) {
      console.log(`  ${c.id}  ${c.data.firstName || ""} ${c.data.lastName || ""}  status=${c.data.status || "?"}`);
    }
  }

  console.log("");
  console.log(`WOULD DELETE (${toDelete.length}) — createdAt before ${CUTOFF.iso}:`);
  for (const c of toDelete) {
    const created = c.data.createdAt?.toDate
      ? c.data.createdAt.toDate().toISOString().slice(0, 10)
      : "?";
    console.log(`  ${c.id}  ${c.data.firstName || ""} ${c.data.lastName || ""}  createdAt=${created}  status=${c.data.status || "?"}`);
  }

  if (toDelete.length === 0) {
    console.log("\nNothing to delete. Done.");
    return;
  }

  const cidSet = new Set(toDelete.map((c) => c.id));

  console.log("\nScanning related data…");
  const summary = [];
  for (const c of toDelete) {
    const cid = c.id;
    const row = { cid, name: `${c.data.firstName || ""} ${c.data.lastName || ""}`.trim() };
    for (const sub of CLIENT_SUBCOLLECTIONS) {
      row[`sub:${sub}`] = await countSubcollection(cid, sub);
    }
    for (const coll of PER_CLIENT_COLLECTIONS) {
      row[`coll:${coll}`] = await countPerClient(coll, cid);
    }
    row["storage:files"] = await countStoragePrefix(cid);
    summary.push(row);
  }

  console.log("\nPer-client plan:");
  for (const r of summary) {
    const parts = [];
    for (const sub of CLIENT_SUBCOLLECTIONS) {
      if (r[`sub:${sub}`] > 0) parts.push(`sub/${sub}=${r[`sub:${sub}`]}`);
    }
    for (const coll of PER_CLIENT_COLLECTIONS) {
      if (r[`coll:${coll}`] > 0) parts.push(`${coll}=${r[`coll:${coll}`]}`);
    }
    if (r["storage:files"] > 0) parts.push(`storage=${r["storage:files"]}`);
    console.log(`  ${r.cid}  ${r.name || "(no name)"} -> ${parts.length ? parts.join(", ") : "(nothing else)"}`);
  }

  if (!APPLY) {
    const rosterStats = await purgeRosterMentions(cidSet);
    const thriftStats = await purgeThriftShifts(cidSet);
    console.log(`\nShared docs that mention deleted clients:`);
    console.log(`  dailyGuestRoster: ${rosterStats.touched} doc(s) touched, ${rosterStats.removed} guest row(s) would be removed`);
    console.log(`  thriftStoreSchedule: ${thriftStats.touched} doc(s) touched, ${thriftStats.blanked} shift(s) would be blanked`);
    const bedsSnap = await db.collection("beds").get();
    let bedsToFree = 0;
    for (const d of bedsSnap.docs) {
      if (cidSet.has(d.data().occupiedBy)) bedsToFree++;
    }
    console.log(`  beds: ${bedsToFree} bed(s) would be freed`);
    const authUsers = await findClientAuthUsers(cidSet);
    console.log(`  firebase auth: ${authUsers.length} client user(s) would be removed`);
    for (const u of authUsers) {
      console.log(`    ${u.uid}  ${u.email}  cid=${u.clientId}`);
    }

    console.log("\nDRY RUN complete — re-run with --apply to perform deletes.");
    return;
  }

  console.log("\nApplying deletes…");
  for (const c of toDelete) {
    const cid = c.id;
    console.log(`  ${cid}  ${c.data.firstName || ""} ${c.data.lastName || ""}`);
    for (const sub of CLIENT_SUBCOLLECTIONS) {
      const n = await deleteSubcollection(cid, sub);
      if (n > 0) console.log(`    deleted ${n} doc(s) from clients/${cid}/${sub}`);
    }
    for (const coll of PER_CLIENT_COLLECTIONS) {
      const n = await deletePerClient(coll, cid);
      if (n > 0) console.log(`    deleted ${n} doc(s) from ${coll} where clientId==${cid}`);
    }
    const sn = await deleteStoragePrefix(cid);
    if (sn > 0) console.log(`    deleted ${sn} storage object(s) under clients/${cid}/`);
    await db.collection("clients").doc(cid).delete();
    console.log(`    deleted master doc clients/${cid}`);
  }

  const roster = await purgeRosterMentions(cidSet);
  console.log(`  dailyGuestRoster: ${roster.touched} doc(s) updated, ${roster.removed} guest row(s) removed`);
  const thrift = await purgeThriftShifts(cidSet);
  console.log(`  thriftStoreSchedule: ${thrift.touched} doc(s) updated, ${thrift.blanked} shift(s) blanked`);
  const freed = await freeBeds(cidSet);
  console.log(`  beds: ${freed} bed(s) freed`);

  const authUsers = await findClientAuthUsers(cidSet);
  for (const u of authUsers) {
    try {
      await auth.deleteUser(u.uid);
      console.log(`  deleted auth user ${u.uid} ${u.email} (cid=${u.clientId})`);
    } catch (err) {
      console.error(`  auth delete failed for ${u.uid}: ${err.message}`);
    }
  }

  console.log("\nAPPLY complete.");
}

main().catch((err) => {
  console.error("FATAL:", err);
  process.exit(1);
});
