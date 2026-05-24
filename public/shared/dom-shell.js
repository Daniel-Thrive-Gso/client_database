// App-shell DOM references — the elements the auth router toggles when
// switching between sign-in screen, staff app, and client app. Feature-local
// elements (intakeForm, reportBody, etc.) stay inside their owning feature
// module after Phase 2+.
//
// Importing this module is safe before DOMContentLoaded — getElementById
// returns null for not-yet-rendered elements, but in practice the entry
// <script type="module"> tag sits at the end of <body> so the shell elements
// exist by the time this evaluates.

export const signinSection   = document.getElementById("signin-section");
export const appSection      = document.getElementById("app-section");
export const clientAppSection = document.getElementById("client-app-section");
export const userBar         = document.getElementById("user-bar");
export const userEmail       = document.getElementById("user-email");
export const signinBtn       = document.getElementById("signin-btn");
export const signoutBtn      = document.getElementById("signout-btn");
export const signinError     = document.getElementById("signin-error");
