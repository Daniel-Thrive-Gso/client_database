// Grants allUsers + roles/run.invoker on each clientAuth Cloud Run service so
// the browser's CORS preflight can reach the onCall function. This is what
// Firebase deploy tries to do automatically; it gets silently blocked when
// the iam.allowedPolicyMemberDomains org policy is on.

import { initializeApp, applicationDefault } from "firebase-admin/app";
import { GoogleAuth } from "google-auth-library";

initializeApp({ credential: applicationDefault() });

const PROJECT = "admin-automation-74110";
const REGION = "us-central1";
// Cloud Run normalizes service names to lowercase, so v2 callable functions
// declared as createForIntake / signIn / resetPin land at createforintake /
// signin / resetpin under the hood.
const FUNCTIONS = ["createforintake", "signin", "resetpin", "disable", "enable"];

const auth = new GoogleAuth({
  scopes: ["https://www.googleapis.com/auth/cloud-platform"],
});
const client = await auth.getClient();

for (const fn of FUNCTIONS) {
  const base = `https://run.googleapis.com/v2/projects/${PROJECT}/locations/${REGION}/services/${fn}`;

  let policy;
  try {
    const res = await client.request({ url: `${base}:getIamPolicy` });
    policy = res.data;
  } catch (err) {
    console.log(`${fn}: getIamPolicy failed — ${err.code} ${err.message}`);
    continue;
  }

  const bindings = policy.bindings || [];
  let invokerBinding = bindings.find((b) => b.role === "roles/run.invoker");
  if (!invokerBinding) {
    invokerBinding = { role: "roles/run.invoker", members: [] };
    bindings.push(invokerBinding);
  }
  if (invokerBinding.members.includes("allUsers")) {
    console.log(`${fn}: already has allUsers — skip`);
    continue;
  }
  invokerBinding.members.push("allUsers");

  try {
    await client.request({
      url: `${base}:setIamPolicy`,
      method: "POST",
      data: { policy: { ...policy, bindings } },
    });
    console.log(`${fn}: granted allUsers + roles/run.invoker`);
  } catch (err) {
    const detail = err?.response?.data?.error?.message || err.message;
    console.log(`${fn}: setIamPolicy FAILED — ${detail}`);
  }
}
