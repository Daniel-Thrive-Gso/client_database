// Inspects the Cloud Run IAM policy for each clientAuth function.
// Confirms whether allUsers has roles/run.invoker (needed for CORS preflight).

import { initializeApp, applicationDefault } from "firebase-admin/app";
import { GoogleAuth } from "google-auth-library";

initializeApp({ credential: applicationDefault() });

const PROJECT = "admin-automation-74110";
const REGION = "us-central1";
const FUNCTIONS = ["createForIntake", "signIn", "resetPin", "disable", "enable"];

const auth = new GoogleAuth({
  scopes: ["https://www.googleapis.com/auth/cloud-platform"],
});
const client = await auth.getClient();

for (const fn of FUNCTIONS) {
  const url = `https://run.googleapis.com/v2/projects/${PROJECT}/locations/${REGION}/services/${fn}:getIamPolicy`;
  try {
    const res = await client.request({ url });
    const bindings = res.data.bindings || [];
    console.log(`\n${fn}:`);
    if (!bindings.length) {
      console.log("  (no bindings — needs allUsers + roles/run.invoker)");
    } else {
      for (const b of bindings) {
        console.log(`  ${b.role} → ${b.members.join(", ")}`);
      }
    }
  } catch (err) {
    console.log(`\n${fn}: ERROR ${err.code} ${err.message}`);
  }
}
