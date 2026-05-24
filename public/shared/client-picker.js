// Reusable type-ahead picker for selecting one client from the cached
// clients list. Used by Self-Eval, Reports, Exit, Schedule, and Intake
// re-entry (each owns its own root <div> element to mount into).
//
// Usage:
//   const picker = createClientPicker({
//     root: document.getElementById('my-picker'),
//     placeholder: 'Search clients…',
//     maxResults: 8,
//     onChange: (selected) => { ... }   // selected = {clientId, name, data} or null
//   });
//   const selection = picker.getSelected();  // null when no client picked
//   picker.clear();
//   picker.focus();

import { escapeHtml, fmtDate } from "./helpers.js";
import { getClients, clientMatchesSearch } from "./clients-store.js";

export function createClientPicker({ root, placeholder = "Search clients by name, alias, or ID…", maxResults = 8, onChange = null } = {}) {
  if (!root) throw new Error("createClientPicker: root element required");
  root.classList.add("client-picker");
  root.innerHTML = `
    <div class="client-picker-input-wrap">
      <input type="text" class="client-picker-input" placeholder="${escapeHtml(placeholder)}" autocomplete="off" />
      <div class="picker-dropdown" hidden></div>
    </div>
    <div class="client-picker-chip" hidden>
      <span class="chip-content"></span>
      <button type="button" class="chip-clear" aria-label="Clear selected client">&times;</button>
    </div>
  `;

  const inputWrap = root.querySelector(".client-picker-input-wrap");
  const input = root.querySelector(".client-picker-input");
  const dropdown = root.querySelector(".picker-dropdown");
  const chip = root.querySelector(".client-picker-chip");
  const chipContent = root.querySelector(".chip-content");
  const chipClear = root.querySelector(".chip-clear");

  let selected = null;
  let activeIdx = -1;
  let currentMatches = [];

  function fullName(data) {
    const n = [data.firstName, data.middleName, data.lastName].filter(Boolean).join(" ");
    return n || "(no name)";
  }

  function getMatches(needleRaw) {
    const needle = needleRaw.trim().toLowerCase();
    const pool = needle
      ? getClients().filter((c) => clientMatchesSearch(c, needle))
      : getClients();
    return pool.slice(0, maxResults);
  }

  function renderDropdown() {
    if (currentMatches.length === 0) {
      dropdown.hidden = true;
      dropdown.innerHTML = "";
      return;
    }
    dropdown.innerHTML = currentMatches.map((c, i) => {
      const data = c.data;
      const aliasSuffix = data.alias ? ` &middot; ${escapeHtml(data.alias)}` : "";
      const dob = fmtDate(data.dob);
      const dobSuffix = dob ? ` &middot; DOB ${escapeHtml(dob)}` : "";
      const cls = "picker-item" + (i === activeIdx ? " active" : "");
      return `
        <div class="${cls}" data-idx="${i}">
          <strong>${escapeHtml(fullName(data))}</strong>
          <div class="picker-item-meta"><code>${escapeHtml(c.id)}</code>${aliasSuffix}${dobSuffix}</div>
        </div>
      `;
    }).join("");
    dropdown.hidden = false;
  }

  function selectMatch(c) {
    selected = c;
    chipContent.innerHTML = `<strong>${escapeHtml(fullName(c.data))}</strong> <code>${escapeHtml(c.id)}</code>`;
    chip.hidden = false;
    inputWrap.hidden = true;
    input.value = "";
    dropdown.hidden = true;
    if (typeof onChange === "function") {
      onChange({ clientId: c.id, name: fullName(c.data), data: c.data });
    }
  }

  function clearSelection() {
    const wasSelected = selected;
    selected = null;
    chip.hidden = true;
    inputWrap.hidden = false;
    input.value = "";
    if (wasSelected && typeof onChange === "function") {
      onChange(null);
    }
  }

  input.addEventListener("focus", () => {
    currentMatches = getMatches(input.value);
    activeIdx = currentMatches.length > 0 ? 0 : -1;
    renderDropdown();
  });

  input.addEventListener("input", () => {
    currentMatches = getMatches(input.value);
    activeIdx = currentMatches.length > 0 ? 0 : -1;
    renderDropdown();
  });

  input.addEventListener("blur", () => {
    setTimeout(() => { dropdown.hidden = true; }, 150);
  });

  input.addEventListener("keydown", (e) => {
    if (currentMatches.length === 0) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      activeIdx = (activeIdx + 1) % currentMatches.length;
      renderDropdown();
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      activeIdx = (activeIdx - 1 + currentMatches.length) % currentMatches.length;
      renderDropdown();
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (activeIdx >= 0 && currentMatches[activeIdx]) selectMatch(currentMatches[activeIdx]);
    } else if (e.key === "Escape") {
      dropdown.hidden = true;
    }
  });

  dropdown.addEventListener("mousedown", (e) => {
    const item = e.target.closest(".picker-item");
    if (!item) return;
    const idx = Number(item.dataset.idx);
    if (Number.isInteger(idx) && currentMatches[idx]) {
      selectMatch(currentMatches[idx]);
    }
  });

  chipClear.addEventListener("click", () => {
    clearSelection();
    input.focus();
  });

  return {
    getSelected() {
      if (!selected) return null;
      return { clientId: selected.id, name: fullName(selected.data), data: selected.data };
    },
    clear: clearSelection,
    focus() {
      if (selected) chipClear.focus();
      else input.focus();
    },
  };
}
