# Auto-prefix GSO- on the client sign-in field

**Source:** "On the client log in for client ID all of them start with GSO-. I would like to hav that already in the client id sign in or infered so clients only need to type in the 5 digit numerical portion."
**Created:** 2026-05-20
**Status:** done
**Completed:** 2026-05-20

## Goal
On the client sign-in screen at `clients.thrivegso.com`, a client should be able to type just the 5-digit numeric portion of their client ID (e.g. `12345`) and have `GSO-` visibly baked into the input box on the left. The prefix should be obvious at a glance — not hidden behind on-type auto-completion — so the client immediately understands "I only need to type the number my staff member gave me." Mobile keyboards should open as a number pad. Pasting a full `GSO-12345` should still work.

## Context

The login form lives in `client_database/public/index.html` lines 45–58, with the form-handler JS in `client_database/public/app.js` lines 9890–9946. The relevant CSS is in `client_database/public/styles.css` lines 1913–1919 (rules under `.signin-client`).

Today the single text input `#client-signin-id` accepts the full ID (`GSO-NNNNN`) but also has an on-input shim (`app.js:9906-9910`) that prepends `GSO-` if the user types only digits. This means typing `12345` already produces `GSO-12345` *functionally* — but the UX doesn't telegraph this. The placeholder reads `GSO-NNNNN` and the label says "Client ID", so most clients assume they must type the whole string.

The tenant prefix is already in config: `TENANT.clientIdPrefix === "GSO"` (`config.js:44`), and `TENANT.clientIdDigits === 5` (`config.js:45`). The validation regex `CLIENT_ID_RE` (`config.js:126`) is also derived from these. No tenant work is needed — we just consume the existing values.

The change is a self-contained UX rework of one form: split the single input into a visible static prefix + a digits-only input, dropping the now-unnecessary auto-prefix shim. The Cloud Function `clientAuthSignIn` and downstream auth flow are untouched — they still receive the full `GSO-12345` string.

## Out of scope
- Cloud Function changes (`clientAuthSignIn` payload format stays the same).
- The PIN field — no change to length, validation, or styling.
- The staff Google sign-in side of the form.
- Forgotten-PIN / password-reset flow (separate idea, not this task).
- Other tenant-prose extraction (that's task #1 in `todo.txt`, refined separately).

## Phases

### Phase 1: Restructure the input + style the prefix
- [x] In `index.html` (around line 49–51), replace the single `<input id="client-signin-id">` with a wrapper element that contains:
  - a visible non-editable `<span>` showing the prefix (e.g. `GSO-`), populated from `TENANT.clientIdPrefix` via a new `data-tenant-text="clientIdPrefixDisplay"` attribute
  - an `<input id="client-signin-id-digits">` styled to sit flush against the prefix span, with `inputmode="numeric"`, `pattern="[0-9]{5}"`, `maxlength="5"`, `autocomplete="username"`, `required`, and a placeholder like `12345`
- [x] In `config.js` (`applyTenantBranding`, around line 154), add the new key — when an element has `data-tenant-text="clientIdPrefixDisplay"`, set its text to `${TENANT.clientIdPrefix}-` (with the dash baked in). Also added a `clientIdDigitsExample` placeholder handler so the digit-only input's `NNNNN` placeholder adapts when `TENANT.clientIdDigits` changes.
- [x] In `styles.css` (extend the block at line 1913–1919), add a `.signin-client .client-id-input` rule that:
  - puts the wrapper in `display: flex; align-items: stretch`
  - puts a single border + radius on the wrapper (not on the children)
  - styles the prefix span with a muted background (`var(--panel)` against the darker `--input-bg`), padding matching the digit input, and `user-select: none`
  - removes the border from the inner digit `<input>` so the wrapper looks like one continuous field
  - added a `:focus-within` rule so the gold accent ring lights up the whole field when the digit input is focused
- [x] Update the form label to read "Client ID" and keep the helper text near it short. (Final wording: "Sign in with the **5-digit number** from your client ID, plus your **6-digit PIN** from staff.")

### Phase 2: Update the submit handler and drop the auto-prefix shim
- [x] In `app.js` `bindClientSignInForm` (line 9891), point `idInput` at the new `#client-signin-id-digits` element. (Renamed local to `digitsInput` for clarity.)
- [x] Remove the on-`input` listener (lines 9906–9910) that auto-prepended `GSO-`. The new field can only contain digits, so the shim has no work to do.
- [x] In the submit handler (lines 9912–9945), replace the existing parsing with:
  - read the raw value of the digits input
  - if it's exactly N digits (where N = `TENANT.clientIdDigits`), build `clientId = `${TENANT.clientIdPrefix}-${digits}``
  - if it isn't, show the existing inline error ("Client ID must be a 5-digit number") and abort
  - downstream call to `clientAuthSignIn({ clientId, pin })` stays unchanged
- [x] Handle a graceful paste case: on `paste` into the digits input, strip non-digits and keep only the last `TENANT.clientIdDigits` characters — so a client who pastes `GSO-12345` or `12345` from a text message both work.
- [x] Remove unused locals (`partialDigitsRe`, `fullDigitsRe`, `exampleId`) — all gone.

## Risks / open questions
- **Visual seam between prefix and input.** Getting the prefix span and the input to look like one continuous field on both desktop and mobile (Safari, Chrome) takes a careful CSS pass. If it looks off after Phase 1, fix it before moving on — half-baked prefix styling is worse than the current state.
- **Autofill behavior.** Browsers may try to autofill the digits field as a username (`autocomplete="username"`). This is fine but worth checking once on a fresh browser profile.
- **Returning clients with muscle memory.** Anyone who currently types `gso-12345` letter by letter will hit a wall — the digit field rejects letters. Acceptable: it's still faster than today, and the visible prefix makes it obvious. No migration needed.

## Verification
1. Run `firebase deploy --only hosting` from `client_database/`, or push a preview to a Firebase hosting preview channel.
2. Open `clients.thrivegso.com` (or the preview URL) in a desktop browser, scroll to the Client side of the sign-in card.
3. Confirm `GSO-` is visible inside the input box, sitting flush to the left of the digit field; the digit field is empty and shows placeholder `12345`.
4. Click the digit field and try typing `abc` — it should be rejected. Type `12345` — appears in the field.
5. Use a real test client (ID + PIN known) and submit — should sign in successfully and land on the client home screen.
6. Try `4`-digit submit — inline error "Client ID must be a 5-digit number".
7. Paste `GSO-12345` into the digit field — paste handler strips non-digits, field shows `12345`, submit works.
8. Open on iPhone Safari (or Chrome DevTools device mode → iPhone) — focus the digit field and confirm the numeric keypad appears, not the alphanumeric keyboard.
9. Grep for `partialDigitsRe`, `fullDigitsRe`, and the old `#client-signin-id` ID — confirm no stale references remain.

## Outcome

Shipped on 2026-05-20. Daniel deployed via `firebase deploy --only hosting` from `client_database/` and confirmed it works on the live `clients.thrivegso.com` sign-in screen.

**What changed:**
- `client_database/public/index.html` — the Client ID input is now a flex wrapper containing a visible `GSO-` prefix span (data-bound via `data-tenant-text="clientIdPrefixDisplay"`) and a 5-digit numeric-only input (`inputmode="numeric"`, `pattern="[0-9]{5}"`, `maxlength="5"`). Helper text updated to "Sign in with the **5-digit number** from your client ID, plus your **6-digit PIN** from staff."
- `client_database/public/config.js` — `applyTenantBranding` now recognizes two new keys: `clientIdPrefixDisplay` (renders `${TENANT.clientIdPrefix}-`) and `clientIdDigitsExample` (renders `NNNNN` placeholder, scales with `TENANT.clientIdDigits`).
- `client_database/public/styles.css` — new `.client-id-input` wrapper rule with single border on the wrapper, muted `var(--panel)` background on the prefix span, transparent borderless inner input, and a `:focus-within` gold accent ring covering the whole field.
- `client_database/public/app.js` — `bindClientSignInForm` rewritten: reads only the digit input, composes `clientId = `${TENANT.clientIdPrefix}-${digits}`` at submit, and adds a paste handler that strips non-digits and keeps the last `TENANT.clientIdDigits` characters so pasting `GSO-12345` or `12345` both land cleanly. Removed the on-input auto-prefix shim and its unused locals (`partialDigitsRe`, `fullDigitsRe`, `exampleId`).

**Notes for a future fork:** the change stayed inside the existing multi-tenant pattern — every tenant-specific string is still driven by `TENANT.clientIdPrefix` and `TENANT.clientIdDigits` in `config.js`, so a fork that uses a different prefix or digit length needs zero HTML/JS edits.

