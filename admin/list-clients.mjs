import { initializeApp, applicationDefault } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";

initializeApp({ credential: applicationDefault() });
const db = getFirestore();

const snap = await db.collection("clients").limit(5).get();
console.log(`${snap.size} clients:`);
for (const d of snap.docs) {
  const data = d.data();
  console.log(`  ${d.id}  ${data.firstName || ""} ${data.lastName || ""}  status=${data.status}`);
}
