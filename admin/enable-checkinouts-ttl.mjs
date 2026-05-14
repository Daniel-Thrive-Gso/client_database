// Enables the native Firestore TTL policy on `checkInOuts.expiresAt`.
// Idempotent — re-running on an already-enabled field is a no-op (the
// API returns the same operation either way). Plan section 14.2.
//
// Usage (from client_database/admin/):
//   $env:GOOGLE_APPLICATION_CREDENTIALS = "C:\path\to\service-account-key.json"
//   node enable-checkinouts-ttl.mjs
//
// Why a custom script: the Firebase CLI does not manage TTL policies, and
// gcloud is not installed on this machine. The Firestore Admin REST API
// exposes the operation directly; this script signs requests with the
// same service-account key used for deploys.

import { initializeApp, applicationDefault } from "firebase-admin/app";
import { GoogleAuth } from "google-auth-library";

const PROJECT_ID = "admin-automation-74110";
const DATABASE_ID = "(default)";
const COLLECTION_GROUP = "checkInOuts";
const FIELD_PATH = "expiresAt";

if (!process.env.GOOGLE_APPLICATION_CREDENTIALS) {
  console.error("ERROR: GOOGLE_APPLICATION_CREDENTIALS env var is not set.");
  process.exit(1);
}

initializeApp({ credential: applicationDefault() });

const auth = new GoogleAuth({
  scopes: ["https://www.googleapis.com/auth/datastore"],
});
const tokenResponse = await auth.getAccessToken();

const url =
  `https://firestore.googleapis.com/v1/projects/${PROJECT_ID}` +
  `/databases/${encodeURIComponent(DATABASE_ID)}` +
  `/collectionGroups/${COLLECTION_GROUP}` +
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
console.log(`HTTP ${res.status}`);
console.log(body);

if (!res.ok) {
  process.exit(1);
}

console.log(
  `\nTTL enable requested for ${COLLECTION_GROUP}.${FIELD_PATH}. ` +
    "It can take a few minutes for the policy to start deleting expired docs."
);
