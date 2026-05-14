import { initializeApp, applicationDefault } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import { getFirestore } from "firebase-admin/firestore";

initializeApp({ credential: applicationDefault() });
const auth = getAuth();
const db = getFirestore();

const ids = process.argv.slice(2);
if (!ids.length) {
  const snap = await db.collection("clients").get();
  ids.push(...snap.docs.map((d) => d.id));
}
for (const cid of ids) {
  let authState = "no auth";
  let claims = null;
  try {
    const u = await auth.getUser(cid);
    authState = `disabled=${u.disabled}`;
    claims = u.customClaims || null;
  } catch (err) {
    if (err.code !== "auth/user-not-found") authState = `ERR ${err.code}`;
  }
  let pinExists = "—";
  try {
    const p = await db.doc(`clients/${cid}/auth/pin`).get();
    pinExists = p.exists ? "yes" : "no";
  } catch (err) {
    pinExists = `ERR ${err.message}`;
  }
  console.log(`${cid}  auth=${authState}  claims=${JSON.stringify(claims)}  pinDoc=${pinExists}`);
}
