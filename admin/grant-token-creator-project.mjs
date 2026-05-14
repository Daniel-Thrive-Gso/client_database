// Grants roles/iam.serviceAccountTokenCreator to the Compute SA at the
// project level (instead of on the SA itself). Same effect — lets the
// runtime SA call createCustomToken() — but uses project IAM which the
// deploying SA may have permission to modify.

import { initializeApp, applicationDefault } from "firebase-admin/app";
import { GoogleAuth } from "google-auth-library";

initializeApp({ credential: applicationDefault() });
const auth = new GoogleAuth({ scopes: ["https://www.googleapis.com/auth/cloud-platform"] });
const client = await auth.getClient();

const PROJECT = "admin-automation-74110";
const SA_EMAIL = "721603594101-compute@developer.gserviceaccount.com";
const ROLE = "roles/iam.serviceAccountTokenCreator";

const base = `https://cloudresourcemanager.googleapis.com/v1/projects/${PROJECT}`;

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
  console.log(`already granted at project level; nothing to do`);
  process.exit(0);
}
binding.members.push(member);

await client.request({
  url: `${base}:setIamPolicy`,
  method: "POST",
  data: { policy: { ...policy, bindings } },
});
console.log(`granted ${ROLE} to ${SA_EMAIL} at project level`);
