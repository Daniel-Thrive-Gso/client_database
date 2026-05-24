// Clients store — owns cachedClients + the live "clients" collection
// snapshot listener. Pure data layer; UI rendering and side-effects
// (Client Detail refresh, Roster/Schedule/Reports init) live in their
// owning features and subscribe via subscribe() below.
//
// Subscriber semantics:
//   - subscribe(cb) registers cb to fire on every snapshot, synchronously,
//     in registration order, with the new clients array. Returns an
//     unsubscribe function.
//   - subscribeError(cb) registers cb to fire on listener errors. cb gets
//     (err). Returns an unsubscribe function.
//   - Always subscribe BEFORE calling startClientsListener() — onSnapshot's
//     first fire happens async after start, so subscribers added after
//     start may miss the first snapshot.

import {
  collection, query, orderBy, onSnapshot,
} from "https://www.gstatic.com/firebasejs/10.14.0/firebase-firestore.js";
import { db } from "./firebase.js";

// Exported as a `let` binding so consumers can read `cachedClients`
// directly (live binding — they see updates on every snapshot). Writes
// happen only inside this module via the snapshot callback below.
export let cachedClients = [];
export let clientsSearchText = "";

let _unsubscribe = null;
const _subscribers = new Set();
const _errorSubscribers = new Set();

// Backwards-compatible getter API. Prefer the `cachedClients` live import
// in new code, but getClients() works too.
export function getClients() { return cachedClients; }
export function getSearchText() { return clientsSearchText; }
export function setSearchText(s) { clientsSearchText = String(s || ""); }

export function subscribe(callback) {
  _subscribers.add(callback);
  return () => _subscribers.delete(callback);
}

export function subscribeError(callback) {
  _errorSubscribers.add(callback);
  return () => _errorSubscribers.delete(callback);
}

export function startClientsListener() {
  if (_unsubscribe) _unsubscribe(); // restart-safe
  const q = query(collection(db, "clients"), orderBy("createdAt", "desc"));
  _unsubscribe = onSnapshot(q, (snap) => {
    cachedClients = snap.docs.map((d) => ({ id: d.id, data: d.data() }));
    for (const cb of _subscribers) {
      try { cb(cachedClients); }
      catch (err) { console.warn("[clients-store] subscriber threw:", err); }
    }
  }, (err) => {
    console.warn("[clients-store] listener error:", err);
    for (const cb of _errorSubscribers) {
      try { cb(err); }
      catch (innerErr) { console.warn("[clients-store] error subscriber threw:", innerErr); }
    }
  });
}

export function stopClientsListener() {
  if (_unsubscribe) { _unsubscribe(); _unsubscribe = null; }
}

// Substring match across id + name fields. Used by the Clients tab search
// box AND by createClientPicker. needle is expected pre-lowercased.
export function clientMatchesSearch(c, needle) {
  if (!needle) return true;
  const fields = [
    c.id,
    c.data.firstName, c.data.middleName, c.data.lastName, c.data.alias,
  ].filter(Boolean).map((s) => String(s).toLowerCase());
  return fields.some((f) => f.includes(needle));
}
