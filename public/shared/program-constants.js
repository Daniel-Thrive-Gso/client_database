// Program-domain constants shared between multiple feature modules.
// Pure data + one pure function (statusUpdateCategory). No state, no DOM,
// no Firestore — safe to import anywhere.

// ----- Client submission types (Inbox + Client App) -----

export const CLIENT_SUB_TYPES = {
  weeklySchedule: "Weekly schedule",
  infoUpdate: "Info update",
  staffRequest: "Help request",
};

// Subjects clients can pick when filing a "help request" for staff.
// Stored keys are stable; labels can be reworded without breaking history.
export const REQUEST_SUBJECT_LABELS = {
  school:             "School",
  veteransBenefits:   "Veterans Benefits",
  socialSecurity:     "Social Security",
  employment:         "Employment",
  identificationDocs: "Identification Documents",
  housing:            "Housing",
  legal:              "Legal",
  medical:            "Medical",
  counseling:         "Counseling",
  other:              "Other",
};

// ----- Status update taxonomy (Inbox + Client Detail) -----
//
// Categories: document (paperwork on file), benefit (recurring govt income),
// review (longform monthly note), milestone (one-off life event).

export const STATUS_UPDATE_TYPE_LABELS = {
  // Documents
  socialSecurityCard: "Social Security card",
  birthCertificate: "Birth certificate",
  stateId: "State ID / driver's license",
  hsDiploma: "HS diploma / GED",
  hsTranscript: "HS transcript",
  collegeDiploma: "College diploma / certificate",
  collegeTranscript: "College transcript",
  medicalInsurance: "Medical insurance",
  vaCard: "VA card",
  dd214: "DD-214",
  voterRegistration: "Voter registration",
  // Healthcare connections (treated as milestones internally)
  connectedDoctor: "Connected with a doctor",
  connectedCounselor: "Connected with a counselor",
  // Government benefits (own category — ongoing, with monthly amounts)
  foodStamps: "Food stamps (SNAP)",
  ssi: "SSI",
  ssdi: "SSDI",
  rsdi: "RSDI / Social Security retirement",
  vaDisability: "VA disability",
  vaRetirement: "VA retirement",
  retirement: "Retirement (other)",
  workersComp: "Workers' compensation",
  tribalBenefits: "Tribal benefits",
  otherBenefit: "Other benefit",
  // Life milestones
  employment: "Got a job",
  housing: "Got housing",
  bankAccount: "Opened a bank account",
  phone: "Got a phone",
  startedSchool: "Started college / trade school",
  sobrietyMilestone: "Sobriety milestone",
  programCompletion: "Completed a program",
  lostEmployment: "Lost job",
  // Reviews — paragraph-form notes kept as history; latest mirrors to
  // master.reviews.{updateType}. Panel Results is the monthly progress
  // review that drives the client's next steps in the program.
  panelResults: "Panel Results",
};

export const STATUS_UPDATE_DOCUMENT_TYPES = new Set([
  "socialSecurityCard", "birthCertificate", "stateId",
  "hsDiploma", "hsTranscript", "collegeDiploma", "collegeTranscript",
  "medicalInsurance", "vaCard", "dd214", "voterRegistration",
]);

export const STATUS_UPDATE_BENEFIT_TYPES = new Set([
  "foodStamps", "ssi", "ssdi", "rsdi", "vaDisability", "vaRetirement",
  "retirement", "workersComp", "tribalBenefits", "otherBenefit",
]);

export const STATUS_UPDATE_REVIEW_TYPES = new Set([
  "panelResults",
]);

export function statusUpdateCategory(updateType) {
  if (STATUS_UPDATE_DOCUMENT_TYPES.has(updateType)) return "document";
  if (STATUS_UPDATE_BENEFIT_TYPES.has(updateType)) return "benefit";
  if (STATUS_UPDATE_REVIEW_TYPES.has(updateType)) return "review";
  return "milestone";
}
