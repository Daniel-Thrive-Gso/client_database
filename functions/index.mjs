// clientAuth — Cloud Functions for client login (Client ID + 6-digit PIN).
// Plan section 14.1.
//
// Functions:
//   createForIntake({ clientId, displayName? })  — staff: provision a client account
//   signIn({ clientId, pin })                    — public: validate PIN, mint custom token
//   resetPin({ clientId })                       — staff: regenerate PIN
//   disable({ clientId })                        — staff: disable Auth account (called on exit)
//   enable({ clientId })                         — staff: re-enable Auth account
//
// Brute-force protection: 5 wrong attempts within 15 minutes triggers a
// 15-minute lockout. Counter and PIN hash live on clients/{cid}/auth/pin.
// Successful sign-in resets the counter.
//
// PIN storage uses Node's built-in scrypt: 64-byte hash, 16-byte random salt,
// N=16384. No third-party hashing libs (no native bindings, fastest cold start).
// Comparison uses crypto.timingSafeEqual.

import { onCall, HttpsError } from "firebase-functions/v2/https";
import { logger } from "firebase-functions";
import { initializeApp } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import { getFirestore, Timestamp } from "firebase-admin/firestore";
import {
  scrypt as _scrypt,
  randomInt,
  randomBytes,
  timingSafeEqual,
} from "crypto";
import { promisify } from "util";

const scrypt = promisify(_scrypt);

initializeApp();
const auth = getAuth();
const db = getFirestore();

const STAFF_DOMAIN = "thrivegso.com";
const REGION = "us-central1";

const PIN_LENGTH = 6;
const SCRYPT_N = 16384;
const SCRYPT_KEYLEN = 64;
const SCRYPT_SALTLEN = 16;
const LOCKOUT_THRESHOLD = 5;
const LOCKOUT_WINDOW_MS = 15 * 60 * 1000;
const LOCKOUT_DURATION_MS = 15 * 60 * 1000;

const CLIENT_ID_RE = /^GSO-\d{5}$/;
const PIN_RE = new RegExp(`^\\d{${PIN_LENGTH}}$`);

// ------------------------------ helpers ------------------------------

function requireStaff(request) {
  const email = request.auth?.token?.email;
  const verified = request.auth?.token?.email_verified;
  if (!email || !verified) {
    throw new HttpsError("unauthenticated", "Sign in required.");
  }
  if (!email.toLowerCase().endsWith(`@${STAFF_DOMAIN}`)) {
    throw new HttpsError("permission-denied", "Staff access required.");
  }
  return email;
}

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

async function verifyPin(pin, stored) {
  if (!stored?.hash || !stored?.salt) return false;
  const salt = Buffer.from(stored.salt, "base64");
  const expected = Buffer.from(stored.hash, "base64");
  const actual = await scrypt(pin, salt, expected.length, { N: stored.n || SCRYPT_N });
  if (actual.length !== expected.length) return false;
  return timingSafeEqual(actual, expected);
}

function validClientId(cid) {
  return typeof cid === "string" && CLIENT_ID_RE.test(cid);
}

function validPin(pin) {
  return typeof pin === "string" && PIN_RE.test(pin);
}

async function audit(action, entityType, entityId, metadata) {
  try {
    await db.collection("accessLog").add({
      userId: metadata?.userId || metadata?.userEmail || "system",
      userEmail: metadata?.userEmail || "system",
      action,
      entityType,
      entityId,
      timestamp: Timestamp.now(),
      metadata: metadata || null,
    });
  } catch (err) {
    // Audit failures are visible in Cloud Logging. Don't roll back the
    // state-changing op for a transient log write — the operation is
    // still observable via the Auth/Firestore mutations themselves.
    logger.warn("audit write failed", { entityType, entityId, error: err.message });
  }
}

async function ensureAuthUser(clientId, displayName) {
  // Idempotent: if uid=clientId already exists, return it.
  try {
    return await auth.getUser(clientId);
  } catch (err) {
    if (err.code !== "auth/user-not-found") throw err;
    return await auth.createUser({
      uid: clientId,
      displayName: displayName || clientId,
      disabled: false,
    });
  }
}

async function setClientClaims(clientId) {
  await auth.setCustomUserClaims(clientId, { role: "client", clientId });
}

async function stepThrow(label, fn) {
  // Wraps a provisioning step so the surfaced HttpsError tells us which
  // Admin-SDK call blew up. Without this every failure becomes opaque
  // "internal" on the client side.
  try {
    return await fn();
  } catch (err) {
    logger.error(`provision step '${label}' failed`, {
      code: err?.code,
      message: err?.message,
      stack: err?.stack,
    });
    throw new HttpsError(
      "internal",
      `${label} failed: ${err?.code || ""} ${err?.message || String(err)}`.trim()
    );
  }
}

async function provisionClientAccount(clientId, displayName, staffEmail) {
  // Mint a fresh PIN, write the hash + reset the counter, ensure the Auth
  // user exists and is enabled, set client claims. Used by both
  // createForIntake and resetPin.
  const pin = generatePin();
  const stored = await stepThrow("hashPin", () => hashPin(pin));

  await stepThrow("ensureAuthUser", () => ensureAuthUser(clientId, displayName));
  await stepThrow("updateUser.enable", () => auth.updateUser(clientId, { disabled: false }));
  await stepThrow("setCustomClaims", () => setClientClaims(clientId));

  await stepThrow("writePinDoc", () => db.doc(`clients/${clientId}/auth/pin`).set({
    ...stored,
    pinCreatedAt: Timestamp.now(),
    pinCreatedBy: staffEmail,
    failedAttempts: 0,
    firstFailedAt: null,
    lockedUntil: null,
  }));

  return pin;
}

// ------------------------------ functions ------------------------------

export const createForIntake = onCall({ region: REGION }, async (request) => {
  const staffEmail = requireStaff(request);
  const { clientId, displayName } = request.data || {};
  if (!validClientId(clientId)) {
    throw new HttpsError("invalid-argument", "Invalid clientId.");
  }

  const masterSnap = await db.doc(`clients/${clientId}`).get();
  if (!masterSnap.exists) {
    throw new HttpsError("not-found", `Client ${clientId} does not exist.`);
  }

  const pin = await provisionClientAccount(clientId, displayName, staffEmail);
  await audit("create", "clientAuth", clientId, {
    userEmail: staffEmail,
    surface: "createForIntake",
  });
  return { pin };
});

export const signIn = onCall({ region: REGION }, async (request) => {
  const { clientId, pin } = request.data || {};
  if (!validClientId(clientId) || !validPin(pin)) {
    // Generic error — don't reveal which field is wrong.
    throw new HttpsError("invalid-argument", "Invalid clientId or PIN.");
  }

  // Read + verify + counter update in one transaction.
  // Auth.createCustomToken happens after the txn commits (it's an Auth API call,
  // not Firestore, so it can't be inside the runTransaction block).
  const pinRef = db.doc(`clients/${clientId}/auth/pin`);
  const result = await db.runTransaction(async (txn) => {
    const snap = await txn.get(pinRef);
    if (!snap.exists) {
      return { ok: false, code: "invalid-credentials" };
    }
    const data = snap.data();

    const now = Date.now();
    if (data.lockedUntil && data.lockedUntil.toMillis() > now) {
      return {
        ok: false,
        code: "locked",
        retryAfterMs: data.lockedUntil.toMillis() - now,
      };
    }

    const valid = await verifyPin(pin, data);
    if (!valid) {
      const windowExpired = !data.firstFailedAt
        || (now - data.firstFailedAt.toMillis()) > LOCKOUT_WINDOW_MS;
      const newCount = windowExpired ? 1 : (data.failedAttempts || 0) + 1;
      const update = {
        failedAttempts: newCount,
        firstFailedAt: windowExpired ? Timestamp.fromMillis(now) : data.firstFailedAt,
      };
      if (newCount >= LOCKOUT_THRESHOLD) {
        update.lockedUntil = Timestamp.fromMillis(now + LOCKOUT_DURATION_MS);
      }
      txn.update(pinRef, update);
      return { ok: false, code: "invalid-credentials" };
    }

    // Success — reset counter.
    txn.update(pinRef, {
      failedAttempts: 0,
      firstFailedAt: null,
      lockedUntil: null,
      lastSignInAt: Timestamp.fromMillis(now),
    });
    return { ok: true };
  });

  if (!result.ok) {
    if (result.code === "locked") {
      const minutes = Math.ceil(result.retryAfterMs / 60000);
      throw new HttpsError(
        "resource-exhausted",
        `Too many wrong attempts. Try again in ${minutes} minute${minutes === 1 ? "" : "s"}.`
      );
    }
    throw new HttpsError("permission-denied", "Invalid clientId or PIN.");
  }

  // Make sure the Auth account exists, has the right claims, and isn't disabled.
  await stepThrow("signIn.ensureAuthUser", () => ensureAuthUser(clientId));
  await stepThrow("signIn.setCustomClaims", () => setClientClaims(clientId));
  const userRecord = await stepThrow("signIn.getUser", () => auth.getUser(clientId));
  if (userRecord.disabled) {
    throw new HttpsError("permission-denied", "Account is disabled.");
  }

  const token = await stepThrow(
    "signIn.createCustomToken",
    () => auth.createCustomToken(clientId, { role: "client", clientId })
  );

  await audit("signIn", "clientAuth", clientId, {
    userId: clientId,
    userEmail: clientId,
    surface: "client-signIn",
  });

  return { token };
});

export const resetPin = onCall({ region: REGION }, async (request) => {
  const staffEmail = requireStaff(request);
  const { clientId } = request.data || {};
  if (!validClientId(clientId)) {
    throw new HttpsError("invalid-argument", "Invalid clientId.");
  }

  const masterSnap = await db.doc(`clients/${clientId}`).get();
  if (!masterSnap.exists) {
    throw new HttpsError("not-found", `Client ${clientId} does not exist.`);
  }

  const displayName = masterSnap.data()?.firstName || clientId;
  const pin = await provisionClientAccount(clientId, displayName, staffEmail);
  await audit("update", "clientAuth", clientId, {
    userEmail: staffEmail,
    surface: "resetPin",
  });
  return { pin };
});

export const disable = onCall({ region: REGION }, async (request) => {
  const staffEmail = requireStaff(request);
  const { clientId } = request.data || {};
  if (!validClientId(clientId)) {
    throw new HttpsError("invalid-argument", "Invalid clientId.");
  }

  try {
    await auth.updateUser(clientId, { disabled: true });
  } catch (err) {
    if (err.code === "auth/user-not-found") {
      // Disable on a client that never had an Auth account is a no-op.
      return { ok: true, noop: true };
    }
    throw err;
  }

  await audit("update", "clientAuth", clientId, {
    userEmail: staffEmail,
    surface: "disable",
    action: "disable",
  });
  return { ok: true };
});

export const enable = onCall({ region: REGION }, async (request) => {
  const staffEmail = requireStaff(request);
  const { clientId } = request.data || {};
  if (!validClientId(clientId)) {
    throw new HttpsError("invalid-argument", "Invalid clientId.");
  }

  try {
    await auth.updateUser(clientId, { disabled: false });
  } catch (err) {
    if (err.code === "auth/user-not-found") {
      throw new HttpsError(
        "not-found",
        "Auth account does not exist. Use createForIntake or resetPin to provision one."
      );
    }
    throw err;
  }

  await audit("update", "clientAuth", clientId, {
    userEmail: staffEmail,
    surface: "enable",
    action: "enable",
  });
  return { ok: true };
});
