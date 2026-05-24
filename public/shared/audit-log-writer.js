// Writer side of the accessLog audit trail. The Audit Log TAB (admin-only,
// read + filter UI) lives in features/audit-log.js — kept separate because
// almost every feature module writes audit entries, but only the audit tab
// reads them.

import { addDoc, collection, serverTimestamp } from "https://www.gstatic.com/firebasejs/10.14.0/firebase-firestore.js";
import { auth, db } from "./firebase.js";

export const AUDIT_ACTIONS = {
  SIGN_IN: "signIn",
  SIGN_OUT: "signOut",
  CREATE: "create",
  UPDATE: "update",
  DELETE: "delete",
  APPROVE: "approve",
  REJECT: "reject",
  VIEW: "view",
  PRINT: "print",
};

// Writes an entry to the accessLog collection. Schema:
//   userId, userEmail, action, entityType, entityId, timestamp, metadata
// Fail-open: if the audit write fails (network blip, etc.) the user action
// still succeeds. Real fail-closed auditing requires writing audit + action
// atomically from a Cloud Function — interim approach until that exists.
export async function logAccess(action, entityType, entityId = null, metadata = null) {
  const user = auth.currentUser;
  if (!user) return;
  try {
    await addDoc(collection(db, "accessLog"), {
      userId: user.uid,
      userEmail: user.email,
      action,
      entityType,
      entityId,
      timestamp: serverTimestamp(),
      metadata,
    });
  } catch (err) {
    console.warn("audit log write failed:", err);
  }
}
