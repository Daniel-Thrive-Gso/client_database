// Cross-section identity cache. Written by the auth router in app.js (will
// move to features/auth.js in Phase 2); read by anything that needs to branch
// on staff vs. client vs. admin.
//
// Exports are ES-module live bindings — consumers see the current value on
// every read, no polling. The catch: external modules CANNOT reassign these
// imports directly (`currentUserRole = "client"` would throw). All writes go
// through setCurrentIdentity / clearCurrentIdentity, defined here, so the
// `let` mutation happens inside the owning module.

export let currentUserRole = null;
export let currentUserClientId = null;

export function setCurrentIdentity({ role, clientId }) {
  currentUserRole = role || null;
  currentUserClientId = clientId || null;
}

export function clearCurrentIdentity() {
  currentUserRole = null;
  currentUserClientId = null;
}
