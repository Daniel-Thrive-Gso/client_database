// Boot the Firebase SDK for the whole app.
//
// Importing this module triggers initializeApp() exactly once (ES modules are
// cached by URL, so subsequent imports re-use the same singletons). Every
// feature module imports from here for its SDK handles rather than calling
// Firebase init itself.

import { initializeApp } from "https://www.gstatic.com/firebasejs/10.14.0/firebase-app.js";
import { getAuth, GoogleAuthProvider } from "https://www.gstatic.com/firebasejs/10.14.0/firebase-auth.js";
import { getFirestore } from "https://www.gstatic.com/firebasejs/10.14.0/firebase-firestore.js";
import { getStorage } from "https://www.gstatic.com/firebasejs/10.14.0/firebase-storage.js";
import { getFunctions, httpsCallable } from "https://www.gstatic.com/firebasejs/10.14.0/firebase-functions.js";

// authDomain matches the hosting domain so the redirect handler is same-origin.
// The clients.thrivegso.com/__/auth/handler URI was added to the Firebase-
// managed OAuth client (ID prefix 721603594101-ubl0c0nq0o61diurf43bkuri1nkmf95c)
// in Cloud Console on 2026-05-20, alongside the original .web.app handler from
// 2026-05-08. Same-origin auth handler sidesteps the third-party-cookie
// blocking that otherwise breaks the redirect → app session handoff.
export const ALLOWED_DOMAIN = "thrivegso.com";

const app = initializeApp({
  apiKey: "AIzaSyBQj50m9HeEBDZ1b2eklTQEhVD63hzDCBM",
  authDomain: "clients.thrivegso.com",
  projectId: "admin-automation-74110",
  storageBucket: "admin-automation-74110.firebasestorage.app",
  messagingSenderId: "721603594101",
  appId: "1:721603594101:web:bc4c79f1484f11540c753c",
});
const functions = getFunctions(app, "us-central1");
export const auth = getAuth(app);
export const db = getFirestore(app);
export const storage = getStorage(app);

export const provider = new GoogleAuthProvider();
provider.setCustomParameters({ hd: ALLOWED_DOMAIN, prompt: "select_account" });

// Callable wrappers for the clientAuth Cloud Functions (plan §14.1).
export const clientAuthCreate  = httpsCallable(functions, "createForIntake");
export const clientAuthSignIn  = httpsCallable(functions, "signIn");
export const clientAuthReset   = httpsCallable(functions, "resetPin");
export const clientAuthDisable = httpsCallable(functions, "disable");
export const clientAuthEnable  = httpsCallable(functions, "enable");
