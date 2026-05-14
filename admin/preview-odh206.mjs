// Local preview for the ODH 206 PDF generator. Uses the AcroForm fields
// already present in the source PDF rather than stamping text at hand-tuned
// coordinates. The source PDF was a fillable form Daniel had previously
// filled in with sample data; this script demonstrates the same approach
// the in-browser generator uses.
//
// Run: node preview-odh206.mjs

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PDFDocument } from "pdf-lib";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TEMPLATE = path.resolve(__dirname, "../public/forms/odh206.pdf");
const OUT = path.resolve(__dirname, "preview-odh206.pdf");

// Field-name map (positional, derived from the AcroForm widget rects in the
// template — the field names in the PDF are mislabeled because the original
// designer reused stale labels as field IDs, but the positions are correct).
const FIELD = {
  patientName:        "OKLAHOMA STANDARD AUTHORIZATION TO USE OR SHARE PROTECTED HEALTH INFORMATION PHI",
  medicalRecord:      "undefined",
  dob:                "Patient Name",
  ssn:                "Medical Record",
  disclosingParty:    "Social Security",
  receivingParty:     "Name of PersonOrganization Disclosing PHI",
  receivingAddress2:  "Name and Address of PersonOrganization Receiving PHI",
  cb_psychotherapy:   "Psychotherapy Notes if checking this box no other boxes may be checked",
  cb_entireMedical:   "Entire Medical Record",
  cb_billing:         "Billing Information for",
  billingFor:         "undefined_2",
  cb_mentalHealth:    "Mental Health Records",
  cb_substanceAbuse:  "Substance Abuse Records",
  cb_medicalBetween:  "Medical information compiled between",
  medicalBetweenStart: "undefined_3",
  medicalBetweenEnd:  "undefined_4",
  cb_otherInfo:       "Other",
  otherInfoText:      "and",
  cb_purpInsurance:   "Insurance",
  cb_purpContinued:   "Continued Treatment",
  cb_purpLegal:       "Legal",
  cb_purpAtRequest:   "At my or my representatives request",
  cb_purpOther:       "Other_2",
  purpOtherText:      "undefined_5",
  expirationEvent:    "Text1",
  expirationEvent2:   "Text2",
  signature:          "Signature of Patient or Legal Representative",
  date:               "Date",
  legalRepAuthority:  "Description of Legal Representatives Authority",
  expirationDate:     "Expiration date if longer than one year from date of",
};

const SAMPLE = {
  patientName: "Sarah Jane Smith",
  dob: "03/14/1985",
  ssn: "123-45-6789",
  disclosingParty: "McAlester Regional Health Center",
  receivingParty: "Good Samaritan Outreach / 20 E. Cherokee Ave; McAlester OK 74501",
  info: { general: true, mentalHealth: true, substanceAbuse: false, psychotherapyNotes: false },
  purposeChoice: "atMyRequest",
  expirationEvent: "Upon leaving Good Samaritan Outreach Program",
  expirationDate: null,
  signatureDate: new Date().toLocaleDateString("en-US"),
};

const tmplBytes = await fs.readFile(TEMPLATE);
const pdf = await PDFDocument.load(tmplBytes);
while (pdf.getPageCount() > 1) pdf.removePage(1);
const form = pdf.getForm();

const setText = (key, val) => {
  try { form.getTextField(FIELD[key]).setText(val || ""); }
  catch (e) { console.warn(`setText ${key} (${FIELD[key]}) failed: ${e.message}`); }
};
const setCheck = (key, on) => {
  try {
    const cb = form.getCheckBox(FIELD[key]);
    if (on) cb.check(); else cb.uncheck();
  } catch (e) { console.warn(`setCheck ${key} (${FIELD[key]}) failed: ${e.message}`); }
};

// Identifiers (top of form)
setText("patientName", SAMPLE.patientName);
setText("medicalRecord", "");
setText("dob", SAMPLE.dob);
setText("ssn", SAMPLE.ssn);
setText("disclosingParty", SAMPLE.disclosingParty);
setText("receivingParty", SAMPLE.receivingParty);
setText("receivingAddress2", "");

// Information shared
setCheck("cb_psychotherapy", SAMPLE.info.psychotherapyNotes);
setCheck("cb_entireMedical", SAMPLE.info.general);
setCheck("cb_billing", false);
setCheck("cb_mentalHealth", SAMPLE.info.mentalHealth);
setCheck("cb_substanceAbuse", SAMPLE.info.substanceAbuse);
setCheck("cb_medicalBetween", false);
setCheck("cb_otherInfo", false);
setText("billingFor", "");
setText("medicalBetweenStart", "");
setText("medicalBetweenEnd", "");
setText("otherInfoText", "");

// Purpose
setCheck("cb_purpInsurance", SAMPLE.purposeChoice === "insurance");
setCheck("cb_purpContinued", SAMPLE.purposeChoice === "continuedTreatment");
setCheck("cb_purpLegal", SAMPLE.purposeChoice === "legal");
setCheck("cb_purpAtRequest", SAMPLE.purposeChoice === "atMyRequest");
setCheck("cb_purpOther", SAMPLE.purposeChoice === "other");
setText("purpOtherText", SAMPLE.purposeChoice === "other" ? SAMPLE.purposeOther : "");

// Expiration + signing
setText("expirationEvent", SAMPLE.expirationEvent);
setText("expirationEvent2", "");
setText("signature", "");
setText("date", SAMPLE.signatureDate);
setText("legalRepAuthority", "");
setText("expirationDate", SAMPLE.expirationDate ? new Date(SAMPLE.expirationDate).toLocaleDateString("en-US") : "");

// Flatten so fields print reliably and can't be re-edited.
form.flatten();

const out = await pdf.save();
await fs.writeFile(OUT, out);
console.log(`Wrote ${OUT}`);
