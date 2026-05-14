// Grants roles/iam.serviceAccountTokenCreator to the function-runtime SA on
// itself, so firebase-admin's auth.createCustomToken() can sign JWTs via the
// IAM API. Without this, signIn returns 500 at the createCustomToken step.

import { initializeApp, applicationDefault } from "firebase-admin/app";
import { GoogleAuth } from "google-auth-library";

initializeApp({ credential: applicationDefault() });
const auth = new GoogleAuth({ scopes: ["https://www.googleapis.com/auth/cloud-platform"] });
const client = await auth.getClient();

const PROJECT = "admin-automation-74110";
const SA_EMAIL = "721603594101-compute@developer.gserviceaccount.com";
const ROLE = "roles/iam.serviceAccountTokenCreator";

const base = `https://iam.googleapis.com/v1/projects/${PROJECT}/serviceAccounts/${SA_EMAIL}`;

const policyRes = await client.request({ url: `${base}:getIamPolicy`, method: "POST" });
const policy = policyRes.data;
const bindings = policy.bindings || [];
let binding = bindings.find((b) => b.role === ROLE);
if (!binding) {
  binding = { role: ROLE, members: [] };
  bindings.push(binding);
}
const member = `serviceAccount:${SA_EMAIL}`;
if (binding.members.includes(member)) {
  console.log(`already granted; skipping`);
  process.exit(0);
}
binding.members.push(member);

await client.request({
  url: `${base}:setIamPolicy`,
  method: "POST",
  data: { policy: { ...policy, bindings } },
});
console.log(`granted ${ROLE} to ${SA_EMAIL} on itself`);
