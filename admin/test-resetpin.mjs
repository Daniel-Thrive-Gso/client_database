// Reproduces the resetPin Cloud Function logic locally to find what fails.
// Usage:
//   $env:GOOGLE_APPLICATION_CREDENTIALS = "<path to SA key>"
//   node test-resetpin.mjs <clientId>

import { initializeApp, applicationDefault } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import { getFirestore, Timestamp } from "firebase-admin/firestore";
import { scrypt as _scrypt, randomInt, randomBytes } from "crypto";
import { promisify } from "util";

const scrypt = promisify(_scrypt);

initializeApp({ credential: applicationDefault() });
const auth = getAuth();
const db = getFirestore();

const clientId = process.argv[2];
if (!clientId) {
  console.error("usage: node test-resetpin.mjs <GSO-NNNNN>");
  process.exit(1);
}

console.log(`[1] master read clients/${clientId}`);
const masterSnap = await db.doc(`clients/${clientId}`).get();
if (!masterSnap.exists) {
  console.error(`master does not exist`);
  process.exit(1);
}
console.log(`    OK firstName=${masterSnap.data()?.firstName}`);

console.log(`[2] generate PIN + hash`);
const pin = randomInt(0, 1_000_000).toString().padStart(6, "0");
const salt = randomBytes(16);
const hash = await scrypt(pin, salt, 64, { N: 16384 });
console.log(`    OK pin=${pin}`);

console.log(`[3] auth.getUser(${clientId})`);
let user;
try {
  user = await auth.getUser(clientId);
  console.log(`    OK existing uid=${user.uid} disabled=${user.disabled}`);
} catch (err) {
  console.log(`    not-found: ${err.code}; will create`);
  user = await auth.createUser({ uid: clientId, displayName: clientId, disabled: false });
  console.log(`    created uid=${user.uid}`);
}

console.log(`[4] auth.updateUser(${clientId}, {disabled:false})`);
await auth.updateUser(clientId, { disabled: false });
console.log(`    OK`);

console.log(`[5] auth.setCustomUserClaims(${clientId}, {role,clientId})`);
await auth.setCustomUserClaims(clientId, { role: "client", clientId });
console.log(`    OK`);

console.log(`[6] write clients/${clientId}/auth/pin`);
await db.doc(`clients/${clientId}/auth/pin`).set({
  algo: "scrypt", n: 16384, keylen: 64,
  salt: salt.toString("base64"),
  hash: hash.toString("base64"),
  pinCreatedAt: Timestamp.now(),
  pinCreatedBy: "test-script",
  failedAttempts: 0,
  firstFailedAt: null,
  lockedUntil: null,
});
console.log(`    OK`);

console.log(`\nALL STEPS PASSED. PIN=${pin}`);
