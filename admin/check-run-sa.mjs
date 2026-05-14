import { initializeApp, applicationDefault } from "firebase-admin/app";
import { GoogleAuth } from "google-auth-library";

initializeApp({ credential: applicationDefault() });
const auth = new GoogleAuth({ scopes: ["https://www.googleapis.com/auth/cloud-platform"] });
const client = await auth.getClient();

const services = ["createforintake", "signin", "resetpin", "disable", "enable"];
for (const s of services) {
  const url = `https://run.googleapis.com/v2/projects/admin-automation-74110/locations/us-central1/services/${s}`;
  const res = await client.request({ url });
  const sa = res.data.template?.serviceAccount || "(default Compute SA)";
  console.log(`${s}: runtime SA = ${sa}`);
}
