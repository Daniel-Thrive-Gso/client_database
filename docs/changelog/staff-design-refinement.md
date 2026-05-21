# Staff-side design system refinement

**Source:** `/design-critique` pass on `client_database` (staff app at admin-automation-74110.web.app)
**Created:** 2026-05-20
**Completed:** 2026-05-20
**Status:** done

## Goal
The staff app's design system was a "v2 visual layer" pasted on top of an earlier utility — Cinzel display serif applied to every functional heading, two competing `:root` token blocks, ad-hoc spacing values, five different uppercase label treatments, and gold accent overloaded to mean both "selected" and "branded callout". The critique surfaced five concrete issues. Working through them: dial the staff workspace down from "boutique brand surface" toward "operator tool", while keeping the brand presence intact on entry surfaces (sign-in card, client home, sidebar wordmark).

## Context
Staff app at `client_database/public/` — single `styles.css` (2700+ lines), single `index.html` (2100+ lines). The v2 design pass had wrapped the whole UI in brand chrome: Cinzel headings on every panel, panel/section gradients, radial gold glows on body, gradient gold buttons, gold flood on info callouts. Functional but slow to scan when used 50× a day.

Issues addressed (in order):
1. Cinzel applied to every h1/h2/h3, fieldset legend, tile-value, modal title — mis-fit for a daily-use staff tool.
2. Two `:root` blocks (v1 cool palette + v2 warm override), with literal hex leaks and stale blue fallbacks (`var(--accent, #2563eb)`) and references to tokens that didn't exist (`--accent-error`, `--accent-ok`).
3. No spacing or radius scale — rem values used: 0.2, 0.25, 0.3, 0.35, 0.4, 0.5, 0.55, 0.6, 0.65, 0.7, 0.75, 0.85, 0.9, 1.0, 1.1, 1.25, 1.5, 1.75, 2.0.
4. Five separate uppercase-tracked label treatments doing similar jobs (`.tile-label`, `th`, `.kv-grid dt`, `.subsection-header`, `.nav-label`).
5. Gold accent overloaded — required-field asterisk, conditional-section flood, reentry banner flood, plus all the legitimate selection/state uses.

Out of scope decisions made along the way:
- Sign-in card kept Cinzel headings (brand entry moment, brief exposure).
- Client home greeting kept Cinzel (per Daniel's "client home is fine").
- Sidebar wordmark kept Cinzel (single brand-mark moment per page).
- Did not touch the print stylesheet (~lines 1340–1600) — it has its own typographic logic.
- Did not touch `.level-chip` pastels, `.big-btn-*` colors, `.status-pill` semantic palettes — those are intentional category colors, not token-system leaks.
- Did not migrate sidebar internal spacing (`0.55/0.65/0.9` etc.) — fine-tuned parent/child pairings, not worth churn.
- Daniel chose to stop after #5 rather than push further (body glow scoping, gradient flattening, tile chrome reduction). The "brand surfaces vs operator surfaces" question is parked; revisit if the staff app ever feels heavy in daily use.

## Phases

### Phase 1 — Typography (#1)
- [x] Narrow the v2 Cinzel rule (styles.css:2278) so it only fires on brand wordmarks (`header .brand-mark`, `.sidebar-mark`), the sign-in entry (`#signin-section h2/h3`), and the client greeting (`.client-greeting h2`).
- [x] Add a staff-scoped rule (`body:has(#app-section:not([hidden]))`) routing h1/h2/h3, section legends, modal-card h3 to Inter 600 with `-0.005em` tracking.
- [x] Add a staff tile-value rule (Inter 700, `-0.015em` tracking, `font-variant-numeric: tabular-nums`) so the dashboard numbers feel solid and line up across a row of tiles.

### Phase 2 — Token system (#2)
- [x] Merge the duplicate `:root` blocks. Single source of truth at the top of styles.css: warm-near-black surfaces, full v2 token set (`--panel-2`, `--border-hi`, `--fg-dim`, `--gold-deep`, `--on-gold`, `--alert-soft`, `--ok-soft`, `--rose`), radius scale, shadow-card, font stack.
- [x] Replace stale blue fallbacks (`var(--accent, #2563eb)` → `var(--accent)`) on `.report-mode-toggle .mode-btn.active` and `.gained-row .gained-count`. Also fixed `color: #fff` → `color: var(--accent-text)` on the same two rules (white-on-gold was failing contrast).
- [x] Repoint nonexistent tokens `--accent-error` / `--accent-ok` on the appointment-modal rules to the actual `--alert` / `--ok`. (The fallback was always winning because the tokens never existed.)
- [x] Replace literal hex `#1c1c1c` on `.client-section-divider` with `var(--panel)`; strip cool-grey fallbacks on `consolidated-event`, `appointment-modal`, `myschedule-thrift-chip`.

### Phase 3 — Spacing + radius scale (#3)
- [x] Add `--space-0` through `--space-8` to `:root` on a 4px base (0 / 4 / 8 / 12 / 16 / 20 / 24 / 32 / 48 px) plus `--radius-xs: 4px`.
- [x] Migrate major structural surfaces: `#signin-section`, `.tiles`, `.tile` (base + v2 cascade), `.panel`, `.section` / `fieldset.section`, `.modal-card`, `.main-col` (desktop + mobile).
- [x] Bumped the modal-card box-shadow opacity 0.18 → 0.35 — the old value was invisible against the warm panel.

### Phase 4 — Label consolidation (#4)
- [x] Collapse 5 uppercase-tracked treatments into 2 canonical routes:
  - **Overline** (`.tile-label`, `.sidenav .nav-label`): 0.65rem / 0.14em tracking / `--fg-dim` / weight 500.
  - **Field label** (`th`, `.kv-grid dt`, `.subsection-header`): 0.72rem / 0.06em / `--muted` / weight 600.
- [x] Add a comment block at `.tile-label` describing the two routes so future label-style copy doesn't invent a third.
- [x] Remove the redundant v2 `.tile-label` override at line 2506 (was forcing 0.7rem and winning the cascade).
- [x] Strip the `font-weight: 500` override on v2 `.tile-value` so the staff Inter-700 rule wins cleanly.

### Phase 5a — Required-field marker (#5, part 1)
- [x] Replace the gold ` *` asterisk after required-field labels with a small uppercase "REQUIRED" tag (0.65rem / 0.14em / `--fg-dim` / weight 500, with 0.5rem left margin). Rolls into the overline label route from Phase 4. Side benefit: more accessible — sighted users no longer need to know that `*` means required.

### Phase 5b — Demote decorative gold (#5, part 2)
- [x] `.conditional` form sub-sections (the "if you said yes, then what" blocks) — drop the 4% gold background flood; replace with `var(--panel-2)`. Keep the thin 3px gold left rail since it does signal "this section appeared because of a state choice above."
- [x] `.reentry-banner` (shown on New Intake when staff pick an existing client) — full demotion from gold flood (8% bg, 1px gold border, gold text, gold strong) to neutral info card: `--panel-2` bg, `--border-hi` border, `--text` color. The banner being present is the signal.
- [x] `.reentry-section legend` — drop the `color: var(--accent)` override so it reads with the same weight as other section legends ("Identity", "Demographics", etc.).

### Phase 6 — Deploy + commit
- [x] Bump CSS cache-buster on `public/index.html` for each batch (`?v=20260520-staff-typography-1` → `tokens-1` → `scale-1` → `labels-1` → `required-1` → `gold-1`).
- [x] `firebase deploy --only hosting` after Phases 1–5a (commit `8b52669`).
- [x] `firebase deploy --only hosting` after Phase 5b (commit `a1c2f17`).
- [x] **Daniel to verify** in browser: staff headings in Inter, tile numbers heavier/aligned, table column headers + KV labels + subsection headers same size, sidebar + tile labels at smaller dim treatment, REQUIRED tag in place of gold asterisk, modal shadows more visible, conditional sub-sections quieter, re-entry banner neutral, sign-in + client home unchanged. **Verified by Daniel 2026-05-20.**

## Outcome
Shipped. Staff app reads noticeably quieter — functional headings in Inter instead of ceremonial Cinzel, consistent spacing rhythm on structural surfaces, label soup collapsed to two clear routes, and gold accent narrowed to brand + selection state (instead of also meaning "required" + "callout" + "informational").

Token system is now a single source of truth with no leaks, no stale fallbacks, no references to undefined tokens. Future component work can grab `--space-*` / `--radius-*` / brand tokens directly.

Brand presence preserved on entry surfaces:
- Sign-in card: still Cinzel headings, brief brand moment.
- Client home greeting: still Cinzel, per Daniel's guidance.
- Sidebar wordmark: still Cinzel "GSO THRIVE", persistent brand mark.
- Primary buttons, focus rings, selection states, picker chips, hover tints: still gold.

## Files changed
- `client_database/public/styles.css` — design system rewrites across the file (≈170 insertions / 130 deletions over two commits).
- `client_database/public/index.html` — only the `<link rel="stylesheet">` cache-buster bumps (~6 character changes per commit).

## Commits
- `8b52669` — Phases 1–5a. *"Refine staff-side design system: Inter headings instead of Cinzel, single token block, spacing scale, unified field labels, REQUIRED indicator instead of gold asterisk"*
- `a1c2f17` — Phase 5b. *"Dial back gold accent on decorative info blocks: conditional sub-sections lose the gold tint, re-entry banner switches to neutral info card"*

Both deployed via `firebase deploy --only hosting` from `client_database/`. Live at https://admin-automation-74110.web.app.

## Risks / open questions
- The `body:has(#app-section:not([hidden]))` selector is used to scope staff-side typography. Already used elsewhere in styles.css for the same predicate, so browser support is fine — but worth flagging if the app ever needs to support Safari 15.3 or older.
- The "bigger question" from the critique (whether to push the split further by scoping the body radial glow, flattening panel gradients, reducing tile chrome) was raised and Daniel chose to stop. Revisit if the staff app ever feels heavy in daily use.

## Verification
- Browser walkthrough on https://admin-automation-74110.web.app after each deploy. Daniel confirmed visible changes match intent.
- Grep checks: `Select-String -Path public/styles.css -Pattern "#2563eb"` should return 0 matches (stale blue fallbacks all replaced); `Select-String -Path public/styles.css -Pattern "var\(--accent-(error|ok)"` should return 0 matches (nonexistent token references all repointed).
- No JS changes — `app.js` (7k+ lines) was not touched. The duplicate-top-level-declaration gotcha doesn't apply here.
