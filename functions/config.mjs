// Tenant config for the Cloud Functions side. Mirrors the per-tenant values
// in public/config.js — staff domain and client ID format must match.
//
// To fork: edit STAFF_DOMAIN, CLIENT_ID_PREFIX, CLIENT_ID_DIGITS, REGION below
// and redeploy with `firebase deploy --only functions`.

export const STAFF_DOMAIN = "thrivegso.com";
export const CLIENT_ID_PREFIX = "GSO";
export const CLIENT_ID_DIGITS = 5;
export const REGION = "us-central1";

// Derived — don't edit.
export const CLIENT_ID_RE = new RegExp(
  `^${CLIENT_ID_PREFIX}-\\d{${CLIENT_ID_DIGITS}}$`
);
