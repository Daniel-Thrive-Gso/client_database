// Sets a Firebase Auth custom claim on a user account.
//
// Usage (from client_database/admin/):
//   $env:GOOGLE_APPLICATION_CREDENTIALS = "C:\path\to\service-account-key.json"
//   node set-claim.mjs <email> <role> [clientId]
//
// Examples:
//   node set-claim.mjs daniel@thrivegso.com admin
//   node set-claim.mjs alice@thrivegso.com staff
//   node set-claim.mjs jdoe@example.com client GSO-2025-0042
//
// The target user must already exist in Firebase Auth (i.e. has signed in
// at least once, or was created via the Admin SDK separately). The user
// must sign out and sign back in for the new claim to appear in their
// ID token — claims are baked in at token issuance, not refreshed live.

import { initializeApp, applicationDefault } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";

const VALID_ROLES = new Set(["admin", "staff", "client"]);

function fail(msg) {
  console.error(`ERROR: ${msg}`);
  process.exit(1);
}

const [, , email, role, clientId] = process.argv;

if (!email || !role) {
  fail("usage: node set-claim.mjs <email> <role> [clientId]");
}
if (!VALID_ROLES.has(role)) {
  fail(`role must be one of: ${[...VALID_ROLES].join(", ")}`);
}
if (role === "client" && !clientId) {
  fail("clientId is required when role is 'client'");
}
if (role !== "client" && clientId) {
  fail("clientId must only be set when role is 'client'");
}

if (!process.env.GOOGLE_APPLICATION_CREDENTIALS) {
  fail("GOOGLE_APPLICATION_CREDENTIALS env var is not set. Point it at the service account JSON file.");
}

initializeApp({ credential: applicationDefault() });
const auth = getAuth();

const user = await auth.getUserByEmail(email).catch((err) => {
  fail(`could not find user ${email}: ${err.message}`);
});

const claims = role === "client" ? { role, clientId } : { role };
await auth.setCustomUserClaims(user.uid, claims);

const refreshed = await auth.getUser(user.uid);
console.log(`OK. ${email} (uid ${user.uid}) now has claims:`, refreshed.customClaims);
console.log("The user must sign out and sign back in for the new claim to take effect.");
