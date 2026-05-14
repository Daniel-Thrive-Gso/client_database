// Batch-provision Firebase Auth accounts + PIN docs for active clients that
// never got one. Closes the gap left by BUILD_LOG §13.13: every pre-2026-05-09
// intake silently failed at provisionClientPin, so any client created before
// the production-blocker fixes can't sign into the client app until staff
// hits "Reset PIN" once per client. This script does the same `Reset PIN`
// for every active client missing a PIN doc, in one shot.
//
// What "missing" means here: `clients/{cid}/auth/pin` doesn't exist. The
// Cloud Function writes the Auth account + the pin doc atomically per call,
// so the pin doc is the canonical "is this client provisioned?" signal. The
// Auth account is also ensured (re-created if missing — idempotent).
//
// Idempotent: clients with an existing pin doc are skipped, unless `--force`.
//
// Usage (from client_database/admin/):
//   $env:GOOGLE_APPLICATION_CREDENTIALS = "C:\path\to\service-account-key.json"
//
//   node provision-missing-pins.mjs
//       Dry-run report. Lists every active client and whether they'd be
//       provisioned, skipped, or re-provisioned. Writes nothing.
//
//   node provision-missing-pins.mjs --apply
//       Provision every active client that's missing a pin doc. Prints each
//       client's PIN once at the end so staff can hand them out. **Capture
//       this output** — the script does not store PINs in plaintext anywhere.
//
//   node provision-missing-pins.mjs --apply --force
//       Re-provision every active client even if they already have a pin doc
//       (rotates their PIN). Use this for a from-scratch reset of the entire
//       active list — rare.
//
//   node provision-missing-pins.mjs --apply --include-exited
//       Also touches exited clients. By default this is off; exited clients
//       have their Auth disabled on exit (§13.0) and don't need a working PIN.
//
// Output format on apply:
//   ┌─────────────┬────────────────────────┬────────┐
//   │ Client ID   │ Name                   │ PIN    │
//   ├─────────────┼────────────────────────┼────────┤
//   │ GSO-12345   │ Jane Doe               │ 482917 │
//   │ ...         │                        │        │
//   └─────────────┴────────────────────────┴────────┘
//
// Audit: one accessLog entry per provisioned client (action=create,
// entityType=clientAuth, surface=batch-provision) plus one summary entry.

import { initializeApp, applicationDefault } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import { getFirestore, Timestamp } from "firebase-admin/firestore";
import {
  scrypt as _scrypt,
  randomInt,
  randomBytes,
} from "crypto";
import { promisify } from "util";

const scrypt = promisify(_scrypt);

const APPLY = process.argv.includes("--apply");
const FORCE = process.argv.includes("--force");
const INCLUDE_EXITED = process.argv.includes("--include-exited");

if (!process.env.GOOGLE_APPLICATION_CREDENTIALS) {
  console.error(
    "ERROR: set GOOGLE_APPLICATION_CREDENTIALS to the service account key path."
  );
  process.exit(1);
}

initializeApp({ credential: applicationDefault() });
const auth = getAuth();
const db = getFirestore();

const SCRYPT_N = 16384;
const SCRYPT_KEYLEN = 64;
const SCRYPT_SALTLEN = 16;
const PIN_LENGTH = 6;
const ACTOR = "system:batch-provision";

function generatePin() {
  return randomInt(0, 1_000_000).toString().padStart(PIN_LENGTH, "0");
}

async function hashPin(pin) {
  const salt = randomBytes(SCRYPT_SALTLEN);
  const hash = await scrypt(pin, salt, SCRYPT_KEYLEN, { N: SCRYPT_N });
  return {
    algo: "scrypt",
    n: SCRYPT_N,
    keylen: SCRYPT_KEYLEN,
    salt: salt.toString("base64"),
    hash: hash.toString("base64"),
  };
}

function displayName(d) {
  return (
    [d.firstName, d.middleName, d.lastName].filter(Boolean).join(" ") ||
    d.alias ||
    ""
  );
}

async function ensureAuthUser(clientId, name) {
  try {
    return await auth.getUser(clientId);
  } catch (err) {
    if (err.code !== "auth/user-not-found") throw err;
    return await auth.createUser({
      uid: clientId,
      displayName: name || clientId,
      disabled: false,
    });
  }
}

async function provisionOne(clientId, name) {
  const pin = generatePin();
  const stored = await hashPin(pin);
  await ensureAuthUser(clientId, name);
  await auth.updateUser(clientId, { disabled: false });
  await auth.setCustomUserClaims(clientId, { role: "client", clientId });
  await db.doc(`clients/${clientId}/auth/pin`).set({
    ...stored,
    pinCreatedAt: Timestamp.now(),
    pinCreatedBy: ACTOR,
    failedAttempts: 0,
    firstFailedAt: null,
    lockedUntil: null,
  });
  return pin;
}

// ----- Plan phase: walk all clients, decide who needs provisioning -----

console.log(`[1/3] Reading clients (active only${INCLUDE_EXITED ? " + exited" : ""})…`);
const snap = await db.collection("clients").get();
const allClients = snap.docs.map((d) => ({ id: d.id, data: d.data() }));
const candidates = allClients.filter((c) => {
  if (INCLUDE_EXITED) return true;
  return c.data.status !== "exited";
});
console.log(`    ${allClients.length} total, ${candidates.length} in scope.`);

console.log(`[2/3] Checking each client for existing PIN doc…`);
const plan = []; // { id, name, status, hasPin, action }
let checked = 0;
for (const c of candidates) {
  const pinSnap = await db.doc(`clients/${c.id}/auth/pin`).get();
  const hasPin = pinSnap.exists;
  let action;
  if (FORCE) action = hasPin ? "re-provision" : "provision";
  else if (hasPin) action = "skip";
  else action = "provision";
  plan.push({
    id: c.id,
    name: displayName(c.data) || "(no name)",
    status: c.data.status || "(no status)",
    hasPin,
    action,
  });
  checked++;
  if (checked % 25 === 0) console.log(`    …${checked}/${candidates.length}`);
}

const toProvision = plan.filter((p) => p.action !== "skip");
const toSkip = plan.filter((p) => p.action === "skip");

console.log("");
console.log(`Plan:`);
console.log(`  ${toProvision.length} to provision`);
console.log(`  ${toSkip.length} to skip (already have a PIN doc)`);
if (toProvision.length === 0) {
  console.log(`\nNothing to do.`);
  process.exit(0);
}

console.log("");
console.log(`Clients that would be provisioned:`);
for (const p of toProvision) {
  console.log(`  ${p.action.padEnd(13)}  ${p.id}  ${p.name}  (status=${p.status})`);
}

if (!APPLY) {
  console.log("");
  console.log(`Dry-run only. Re-run with --apply to provision.`);
  process.exit(0);
}

// ----- Apply phase -----

console.log("");
console.log(`[3/3] Provisioning ${toProvision.length} client${toProvision.length === 1 ? "" : "s"}…`);
const results = []; // { id, name, pin, error }
for (const p of toProvision) {
  try {
    const pin = await provisionOne(p.id, p.name);
    results.push({ id: p.id, name: p.name, pin });
    await db.collection("accessLog").add({
      userId: ACTOR,
      userEmail: ACTOR,
      action: "create",
      entityType: "clientAuth",
      entityId: p.id,
      timestamp: Timestamp.now(),
      metadata: { surface: "batch-provision", forced: FORCE, prior: p.action },
    });
    console.log(`  OK   ${p.id}`);
  } catch (err) {
    results.push({ id: p.id, name: p.name, error: err.message || String(err) });
    console.log(`  FAIL ${p.id}  ${err.message || err}`);
  }
}

await db.collection("accessLog").add({
  userId: ACTOR,
  userEmail: ACTOR,
  action: "create",
  entityType: "clientAuth",
  entityId: "batch",
  timestamp: Timestamp.now(),
  metadata: {
    surface: "batch-provision-summary",
    provisioned: results.filter((r) => !r.error).length,
    failed: results.filter((r) => r.error).length,
    forced: FORCE,
    includeExited: INCLUDE_EXITED,
  },
});

// ----- Print PINs (final output) -----

const ok = results.filter((r) => !r.error);
const failed = results.filter((r) => r.error);

console.log("");
console.log(`PROVISIONED ${ok.length} CLIENT${ok.length === 1 ? "" : "S"}.`);
if (failed.length) {
  console.log(`FAILED ${failed.length}:`);
  for (const r of failed) console.log(`  ${r.id}  ${r.name}  — ${r.error}`);
}
console.log("");

if (!ok.length) process.exit(failed.length ? 1 : 0);

const idW = Math.max("Client ID".length, ...ok.map((r) => r.id.length));
const nameW = Math.max("Name".length, ...ok.map((r) => r.name.length));
const pinW = "PIN".length;
const sep = `+-${"-".repeat(idW)}-+-${"-".repeat(nameW)}-+-${"-".repeat(pinW)}-+`;
console.log(`Capture the PINs below — they are NOT stored anywhere in plaintext.`);
console.log(sep);
console.log(`| ${"Client ID".padEnd(idW)} | ${"Name".padEnd(nameW)} | ${"PIN".padEnd(pinW)} |`);
console.log(sep);
for (const r of ok) {
  console.log(`| ${r.id.padEnd(idW)} | ${r.name.padEnd(nameW)} | ${r.pin.padEnd(pinW)} |`);
}
console.log(sep);

process.exit(failed.length ? 1 : 0);
