// Tenant config — every value that's specific to one org lives here.
//
// To fork this app for another nonprofit:
//   1. Create a new Firebase project. Copy its config from the Firebase console
//      ("Project settings → Your apps → SDK setup and configuration") into
//      `firebase` below.
//   2. Edit the tenant identity fields (staffDomain, adminEmail, clientIdPrefix,
//      orgName, orgShort, orgTagline, pageTitle, orgNameWithAddress).
//   3. Replace `photoVideoConsentText`, `expirationOnExitEvent`, and the
//      ODH-206 wording with the new org's equivalents. The ODH-206 form is
//      Oklahoma-specific; orgs in other states will use a different
//      release-of-info form and should rewrite that section in app.js.
//   4. Also edit the per-tenant strings in `firestore.rules` and
//      `storage.rules` (those files can't import). The header comment in each
//      lists them.
//   5. Edit the color variables in `styles.css` `:root` if rebranding.
//   6. Re-seed bed list (`admin/seed-beds.mjs`) and medication catalog
//      (`admin/seed-medication-catalog.mjs`) for the new org.

export const TENANT = {
  // Firebase web SDK config — from Firebase console.
  firebase: {
    apiKey: "AIzaSyBQj50m9HeEBDZ1b2eklTQEhVD63hzDCBM",
    authDomain: "admin-automation-74110.web.app",
    projectId: "admin-automation-74110",
    storageBucket: "admin-automation-74110.firebasestorage.app",
    messagingSenderId: "721603594101",
    appId: "1:721603594101:web:bc4c79f1484f11540c753c",
  },

  // Cloud Functions region. Must match `functions/config.mjs` REGION.
  functionsRegion: "us-central1",

  // Staff email domain. Staff sign in with Google; we restrict to this domain.
  staffDomain: "thrivegso.com",

  // Admin email (gets delete privileges + audit-log access). Also used as a
  // fallback in firestore.rules / storage.rules until the user's session
  // refreshes its custom claim.
  adminEmail: "daniel@thrivegso.com",

  // Client ID format. `${prefix}-${digits zero-padded}` e.g. "GSO-12345".
  // Random within range, not sequential — see app.js generateClientId().
  clientIdPrefix: "GSO",
  clientIdDigits: 5,

  // Org branding.
  orgName: "Good Samaritan Outreach",
  orgShort: "GSO",                 // top-left brand mark, larger
  orgTagline: "THRIVE",            // top-left brand mark, smaller, spaced
  pageTitle: "GSO Thrive Program",

  // Full org name with mailing address — used as the default Receiving Party
  // on the ODH 206 form and anywhere a complete legal identifier is needed.
  orgNameWithAddress:
    "Good Samaritan Outreach / 20 E. Cherokee Ave; McAlester OK 74501",

  // Default expiration phrasing when an authorization expires on program exit.
  expirationOnExitEvent: "Upon leaving Good Samaritan Outreach Program",

  // Photo / video release wording. Shown in the consent modal at intake.
  photoVideoConsentText: `Photo / Video Release Form

I hereby authorize Good Samaritan Outreach and those acting pursuant to its authority to:

(i) record my likeness and/or voice on a video, audio, photographic, digital, electronic, or any other medium;

(ii) use my name and biographical material in connection with such recording; and

(iii) use, reproduce, exhibit, and/or distribute my name, biographical material, and recordings in any medium (e.g. print publications, video, internet, etc.) for promotional, advertising, educational, and/or other lawful purposes.

I release and waive any claims or rights of compensation or ownership regarding such uses and understand that all such recordings shall remain the property of Good Samaritan Outreach.

I certify that I am 18 years of age or older or that my parent / guardian has signed below.`,

  // ODH-206 (Oklahoma) authorization wording. Other states have different
  // release-of-info forms; replace this whole block when forking.
  odh206FormText: `OKLAHOMA STANDARD AUTHORIZATION TO USE OR SHARE PROTECTED HEALTH INFORMATION (PHI)

Receiving party:
  Good Samaritan Outreach
  20 E. Cherokee Ave, McAlester, OK 74501

Information that may be shared (selectable on this form):
  • Psychotherapy Notes — if selected, NO other categories may be on the same authorization. A separate authorization is required for any additional information.
  • Entire Medical Record
  • Billing Information
  • Mental Health Records
  • Substance Abuse Records

Disclosure purposes (selectable on this form):
  • Insurance
  • Continued Treatment
  • Legal
  • At my or my representative's request

By voluntarily signing this authorization, I understand that:

  • I authorize the use or disclosure of my PHI as described above for the purpose(s) listed.

  • I have the right to withdraw permission for the release of my information. I can revoke this authorization at any time. Revocation must be made in writing to the person/organization disclosing the information and will not affect information that has already been used or disclosed.

  • I have the right to receive a copy of this authorization.

  • Unless the purpose of this authorization is to determine payment of a claim for benefits, signing this authorization will not affect my eligibility for benefits, treatment, enrollment, or payment of claims.

  • My medical information may indicate that I have a communicable and/or non-communicable disease (including, but not limited to, hepatitis, syphilis, gonorrhea, HIV / AIDS) and/or that I have or have been treated for psychological / psychiatric conditions or substance abuse.

  • I may change this authorization at any time by writing to the person/organization disclosing my PHI.

  • I cannot restrict information that may have already been shared based on this authorization.

  • Information used or disclosed pursuant to this authorization may be subject to redisclosure by the recipient and may no longer be protected by HIPAA.

Unless revoked or otherwise indicated, this authorization expires one year from the date of signature, or upon the occurrence of the event entered on this form.

Oklahoma State Department of Health, Community and Family Health Services / Administration. HIPAA Document — retained for a minimum of 6 years.

ODH 206 (August 2014)`,
};

// Derived constants — don't edit; change the source fields above.

// Regex that matches a valid client ID for this tenant. Used in app.js, must
// match the one in functions/config.mjs.
export const CLIENT_ID_RE = new RegExp(
  `^${TENANT.clientIdPrefix}-\\d{${TENANT.clientIdDigits}}$`
);

// Returns true if `email` belongs to a staff member of this tenant.
export function isStaffEmail(email) {
  if (typeof email !== "string") return false;
  return email.toLowerCase().endsWith(`@${TENANT.staffDomain}`);
}

// Returns true if `email` is the admin for this tenant.
export function isAdminEmail(email) {
  if (typeof email !== "string") return false;
  return email.toLowerCase() === TENANT.adminEmail.toLowerCase();
}

// Generate a fresh random client ID in tenant format.
export function generateClientId() {
  const buf = new Uint32Array(1);
  crypto.getRandomValues(buf);
  const ceil = 10 ** TENANT.clientIdDigits;
  const n = buf[0] % ceil;
  return `${TENANT.clientIdPrefix}-${String(n).padStart(TENANT.clientIdDigits, "0")}`;
}

// Apply tenant branding to the DOM at boot. Looks up every element with a
// `data-tenant-text` attribute and sets its textContent / placeholder /
// title from TENANT. Keeps index.html portable across forks.
export function applyTenantBranding(doc = document) {
  doc.title = TENANT.pageTitle;
  for (const el of doc.querySelectorAll("[data-tenant-text]")) {
    const key = el.getAttribute("data-tenant-text");
    if (TENANT[key] != null) el.textContent = TENANT[key];
  }
  for (const el of doc.querySelectorAll("[data-tenant-placeholder]")) {
    const key = el.getAttribute("data-tenant-placeholder");
    if (key === "clientIdExample") {
      const digits = "N".repeat(TENANT.clientIdDigits);
      el.placeholder = `${TENANT.clientIdPrefix}-${digits}`;
    }
  }
  for (const el of doc.querySelectorAll("[data-tenant-value]")) {
    const key = el.getAttribute("data-tenant-value");
    if (TENANT[key] != null) el.value = TENANT[key];
  }
  for (const el of doc.querySelectorAll("[data-tenant-html]")) {
    const key = el.getAttribute("data-tenant-html");
    if (key === "staffDomainHint") {
      el.innerHTML = `Use your <strong>@${TENANT.staffDomain}</strong> Google account.`;
    }
  }
}
