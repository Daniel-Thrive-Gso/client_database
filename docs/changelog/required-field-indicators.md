# Required-field indicators across all forms

**Source:** "Add visual required-field indicators to all forms"
**Created:** 2026-05-19
**Status:** done
**Completed:** 2026-05-19

## Goal
Every required field across every form in the staff app should be visually marked so staff can see "this is required" before hitting Save. Today, required-ness is silent: staff fill out a 600-line intake, click Save, and only then the browser shows a validation popup pointing at the missed field. After this task ships, a small gold asterisk sits next to the label of every required field, and the existing inconsistent `(required)` text on the add-medication modal is removed.

## Context
- Affected file: `client_database/public/index.html`. 21 inputs/selects/textareas already have the HTML `required` attribute, spread across 8 forms:
  - Intake form (lines 787, 817, 819, 825, 830, 844) — 6 fields
  - Exit form (line 1402) — exitDate
  - Drug-test modal (line 1806) — drug-test-date
  - Scanned-doc modal (lines 1863, 1884) — type + file
  - Add-medication modal (lines 1911-1912) — uses an inconsistent inline `<span class="muted">(required)</span>` pattern; remove this
  - PHI record modal (lines 2003, 2014) — auth + file
  - Client sign-in (lines 50, 53) — client ID + PIN
  - Write-up form (lines 123, 126, 129) — reason + dateGiven + givenBy
  - Plus 3 in status-update / level / occurredOn (lines 250, 366, 413)
- CSS file: `client_database/public/styles.css`. No required-state styling exists today. `:has()` is supported in all current browsers.
- Label pattern in this app: `<label>Field name <input ... required /></label>` — the text node sits as the first child of the label, input as the second. Labels in `.section .row` use `flex-direction: column` so input renders BELOW the text.
- Brand gold token: `--accent: #ffb600`.
- Decision: visual treatment will be a small gold asterisk (` *`) immediately following the label text. Chosen over a "thin gold left-border" because the `.section .row` is a CSS grid that auto-flows fields — a left-border would misalign columns.
- Constraint: app.js is 7k+ lines and adding top-level declarations there has caused silent SyntaxErrors twice (per memory). This task does NOT add any JS — pure HTML + CSS.

## Out of scope
- Changing the actual `required` HTML attribute on any field (keep current required/optional decisions as-is).
- Custom validation logic / styling on `:invalid` (browser default validation popup is fine for now).
- Adding required indicators to fields that AREN'T already `required` in the HTML.
- Touching the field-label-typography fix from the design critique (separate task).
- Touching forms outside `public/index.html` (admin/ console is a different app).

## Phases

### Phase 1: CSS — add the asterisk rule
- [x] Add a rule to `public/styles.css` (place it near the other form rules around line 162-200):
  ```css
  label:has(:is(input, select, textarea):required) > .lbl::after {
    content: " *";
    color: var(--accent);
    font-weight: 600;
  }
  ```
- [x] Verify the rule is present by reading the file back.

### Phase 2: Markup — wrap label text in `<span class="lbl">`
- [x] For each of the 21 labels containing a `required` input, wrap the leading text node in `<span class="lbl">…</span>`. Example transformation:
  - Before: `<label>First name <input name="firstName" type="text" required /></label>`
  - After:  `<label><span class="lbl">First name</span> <input name="firstName" type="text" required /></label>`
- [x] Apply to all 21 spots — list (line numbers may drift as edits land):
  - Intake: intakeDate, firstName, lastName, dob, maritalStatus, ssn (6)
  - Exit: exitDate (1)
  - Drug-test: drug-test-date (1)
  - Scanned-doc: scanned-doc-type, scanned-doc-front (2)
  - Add-medication: med-add-name (1)
  - PHI record: phi-record-auth, phi-record-file (2)
  - Sign-in: client-signin-id, client-signin-pin (2)
  - Write-up: reason, dateGiven, givenBy (3)
  - Status / level / occurredOn (3)
- [x] For labels where the text comes from a `data-tenant-text` or `data-tenant-placeholder` binding (sign-in: `data-tenant-placeholder="clientIdExample"`), confirm the wrap doesn't break the boot-time `applyTenantBranding()` walker — it targets `data-tenant-text` on the element itself, so wrapping in a span without that attribute is safe.

### Phase 3: Remove the inconsistent precedent
- [x] On line 1911 in `index.html`, remove the `<span class="muted">(required)</span>` text from the "Medication name" label. The new asterisk rule will cover it automatically.
  - Before: `<label>Medication name <span class="muted">(required)</span>`
  - After:  `<label><span class="lbl">Medication name</span>`

### Phase 4: Smoke test on the live preview
- [x] Run `firebase deploy --only hosting` from `client_database/`. Deploy succeeded — release complete on admin-automation-74110.
- [x] **Verified by Claude via Playwright on the public sign-in form:** Client ID and PIN labels both render `Client ID *` and `PIN *` live — the `:has()` CSS rule fires correctly on the deployed site.
- [x] **Daniel to verify** (requires staff sign-in): walk the New Intake tab, the Exit form, the drug-test modal, scanned-doc modal, add-medication modal, PHI-record modal, write-up form, status-update form. Confirm gold `*` next to required fields, no `*` next to optional fields, no alignment regression, no console errors. **Verified by Daniel 2026-05-19.**

## Outcome
Shipped. Every required field across the 8 forms in `public/index.html` now shows a small gold asterisk after the label text. Staff can see required-ness at a glance instead of discovering it via post-submit validation popups.

Files changed:
- `public/styles.css` — added one `:has()` rule (4 lines) after the existing `.error` block.
- `public/index.html` — wrapped 21 label text strings in `<span class="lbl">`, and removed the one inconsistent `<span class="muted">(required)</span>` on the Add-medication modal.

Verification:
- Claude via Playwright: confirmed the rule fires live on the public sign-in form (Client ID + PIN both render with the asterisk).
- Daniel via browser walkthrough: confirmed all 8 staff forms render correctly with no alignment regressions or console errors.

No JS changes (the 7k-line `app.js` was not touched — important given the duplicate-top-level-declaration gotcha that's bit us twice before).

Deploy: `firebase deploy --only hosting` from `client_database/`. Single release, no Artifact Registry hiccup (only hosting). Live at https://admin-automation-74110.web.app.

## Risks / open questions
- The `:has()` selector — modern browsers only. The app's audience is GSO staff on whatever device they have. If a staffer is on a Safari 15.3 or older device, the asterisks silently won't render (fields still work, just no visual indicator — graceful degradation). Acceptable risk; flag for Daniel before shipping if he has any staff on truly old devices.
- A few labels have inline `style="…"` overrides. Wrapping the text in a span shouldn't affect those, but verify nothing visibly shifts during Phase 4 smoke test.

## Verification
- Grep check: `Select-String -Path public/index.html -Pattern "class=\"lbl\"" | Measure-Object` should return at least 21 matches after Phase 2.
- Grep check: `Select-String -Path public/index.html -Pattern "muted\">\\(required\\)"` should return 0 matches after Phase 3.
- Browser check: load https://admin-automation-74110.web.app, sign in as staff, walk the New Intake tab top to bottom, confirm gold `*` appears next to: Intake date, First name, Last name, Date of birth, Marital status, SSN. Confirm no `*` next to: Middle name, Preferred/alias, Place of birth, Phone, Email, etc.
- The "Save Intake" failure path should still work: submit with First name empty → browser validation popup points at the empty field.
