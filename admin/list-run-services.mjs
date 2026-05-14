import { initializeApp, applicationDefault } from "firebase-admin/app";
import { GoogleAuth } from "google-auth-library";

initializeApp({ credential: applicationDefault() });
const auth = new GoogleAuth({ scopes: ["https://www.googleapis.com/auth/cloud-platform"] });
const client = await auth.getClient();

const url = `https://run.googleapis.com/v2/projects/admin-automation-74110/locations/us-central1/services`;
const res = await client.request({ url });
for (const s of res.data.services || []) {
  console.log(s.name);
}
