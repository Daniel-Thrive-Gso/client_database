# Coffee card impact microcopy

**Source:** `Add "funds ~3 program days" microcopy under price on every coffee product card`
**Created:** 2026-05-20
**Status:** done
**Completed:** 2026-05-21

## Goal
Add a single short line of mission microcopy directly under the price on every coffee product card and on every coffee product detail page (PDP), so the impact framing lands the moment a shopper sees the price — not buried elsewhere on the page.

Per Daniel's call during refinement: drop the literal "~3 program days" framing (a $15–25 bag can't honestly fund $81 of program impact on a "100% of profits" promise) and use the brand's already-locked must-use phrase **"Every cup is a hand up."** instead. Scope the microcopy to a per-product tag so apparel, mugs, and tea don't pick it up by accident.

## Context

- **Product card template:** `thrive-coffee-theme/snippets/card-product.liquid`. The card price renders at **line 207** via `{% render 'price', product: card_product, ... %}` inside `.card-information`. The microcopy goes immediately after that line.
- **PDP price block:** `thrive-coffee-theme/sections/main-product.liquid`. Price renders at **lines 108–116** inside the `'price'` case block. The microcopy goes right after line 116, before the existing `volume-pricing-note` block at line 117.
- **Bulk quick-add modal:** `card-product.liquid` also renders the price twice more inside the bulk quick-add modal (lines 515 and 530), only used when `quick_add == 'bulk'`. Mirror the microcopy there for consistency.
- **Opt-in mechanism:** new Shopify product tag `thrive-impact`. Liquid check is `{%- if card_product.tags contains 'thrive-impact' -%}` on cards, `{%- if product.tags contains 'thrive-impact' -%}` on the PDP. Daniel (or whoever runs ops) bulk-tags the 47 coffee SKUs in Shopify admin → Products → bulk-edit → Tags. Future apparel/mug products that should also carry the line just get the same tag.
- **Copy:** `Every cup is a hand up.` This is one of the storefront-specific top phrases from the GSO brand voice doc (see `MEMORY.md` → brand-review backlog). Currently it appears **zero times** on the storefront, so this also partially handles todo item #32 — but #32 also wants it as a section heading, so #32 stays open.
- **Styling:** small italic caption in brand navy `#1B1F3A`, ~4–6px top margin under the price. Matches the existing `.caption-large light` pattern already used inside `.card-information` (see card-product.liquid:169). Add a new class `card__impact-note` so the style is restylable later without touching markup.
- **Deploy pipeline:** push to `Thrive-Coffee/main` → GitHub connector syncs the theme to Shopify within ~1 min (per memory; the theme is now published, so no manual publish step needed).
- **Currently irrelevant but worth knowing:** the Pass 4 microcopy task originally called for "funds ~3 program days" math. That framing is **abandoned** for the reasons in the Goal. If Daniel ever wants per-bag dollar math later, it would need a `profit_per_bag` metafield per product and a different Liquid expression — out of scope here.

## Out of scope
- Bulk-tagging all 47 coffee SKUs with `thrive-impact` in Shopify admin (manual operator step — listed under Verification, not a code phase).
- Calculating per-bag profit or per-cup donation values (Daniel chose narrative framing).
- Surfacing the microcopy in the cart drawer, cart page, or checkout. Separate scope; flag if Daniel wants it later.
- Section-heading or hero placement of "Every cup is a hand up." (covered by todo #32; keep #32 open).
- Touching the PDP description (todo #35 — flavor narrative + brewing recommendation — is a separate refinement).

## Phases

### Phase 1: Card microcopy + opt-in tag check
- [x] In `thrive-coffee-theme/snippets/card-product.liquid`, add a conditional microcopy block immediately after the `{% render 'price' ... %}` at line 207, scoped by `{%- if card_product.tags contains 'thrive-impact' -%}`. Markup: `<p class="card__impact-note">Every cup is a hand up.</p>`.
- [x] Mirror the same conditional microcopy block after the two bulk-quick-add price renders (lines 515 and 530), same tag check.
- [x] Add `.card__impact-note` CSS (small ~12–13px, italic, color `#1B1F3A`, margin-top ~4–6px, no bottom margin). Added at the end of `thrive-coffee-theme/assets/component-card.css`.

### Phase 2: PDP microcopy
- [x] In `thrive-coffee-theme/sections/main-product.liquid`, add the same conditional microcopy block after line 116 (after the price render's closing `</div>`, before the `quantity_price_breaks_configured?` `volume-pricing-note` block at line 117). Use `{%- if product.tags contains 'thrive-impact' -%}`.
- [x] On the PDP the price uses `price_class: 'price--large'`, so the microcopy may look small underneath. Added a sibling `.card__impact-note.product__impact-note` rule that bumps font-size from 1.3rem → 1.5rem and adds a touch more top margin. The PDP markup carries both classes (`class="card__impact-note product__impact-note"`); fine-tune after Daniel's spot-check.

### Phase 3: Test, commit, deploy, verify
- [x] `git diff` should be limited to the two Liquid files plus one CSS file. Confirmed: 3 files, 25 insertions, 0 deletions.
- [x] Commit with a plain-English message. Push to `Thrive-Coffee/main`. Commit `f6b108c` pushed 2026-05-21.
- [x] Wait ~1 min for Shopify sync.
- [x] In Shopify admin, add the `thrive-impact` tag to **2–3 coffee SKUs** by hand for spot-check. Daniel tagged 3 coffees (incl. French Roast 1).
- [x] Walk through the Verification list below. Confirmed by Daniel 2026-05-21: French Roast 1 PDP shows the line under price, the card appears on the homepage Featured Collection, and the line renders on the card.
- [ ] Once spot-check passes, Daniel (or ops) bulk-tags all 47 coffee SKUs with `thrive-impact` from Shopify admin → Products → bulk-edit → Tags. *(Deferred: tracked as a follow-up line in `docs/todo/todo.txt`.)*

## Risks / open questions
- **Exact copy variant.** Plan locks `Every cup is a hand up.` (with the period, no surrounding context). If Daniel wants something longer like `Every cup is a hand up — 100% of profits fund the Thrive Program.`, flag during impl before pushing.
- **Tag name.** `thrive-impact` is the working choice. `mission-bag`, `hand-up`, or `funds-program` would also work. Easy to rename later by find/replace of the Liquid check and re-tagging in admin — but cheaper to pick the right one now. Daniel: confirm or override before Phase 1.
- **PDP visual weight.** The PDP price is rendered at `price--large` scale; the microcopy might feel weedy at 12–13px next to it. Will tune in Phase 2.
- **Overlap with todo #32.** This task lands the phrase in one spot (under price). #32 still wants it as a prominent section heading. Don't close #32 when `do` finishes this one.

## Verification
1. After deploy, in Shopify admin, tag exactly **one** coffee product (e.g., the first 12oz blend) with `thrive-impact`. Leave the other 46 untagged for the moment so the conditional is clearly testable.
2. Load the homepage Featured Collection — the tagged product card should show `Every cup is a hand up.` in italic navy under the price; the other coffee cards should not.
3. Load `/collections/coffee` — same check across the grid.
4. Load `/collections/apparel` — microcopy must NOT appear on any apparel card.
5. Open the tagged coffee PDP — microcopy appears under the price block, above the variant picker / add-to-cart.
6. Open an untagged coffee PDP and an apparel PDP — microcopy must NOT appear.
7. Once verified, bulk-tag the remaining 46 coffee SKUs from admin.

## Outcome

Shipped 2026-05-21 via two commits on `Daniel-Thrive-Gso/Thrive-Coffee` `main`:

- **`f6b108c`** — added the tag-gated `Every cup is a hand up.` microcopy block in three card paths (`snippets/card-product.liquid` after the main `.card-information` price render, and after the two bulk quick-add modal price renders) and on the PDP (`sections/main-product.liquid` directly under the `'price'` block, before `volume-pricing-note`). Added a `.card__impact-note` rule plus a larger `.product__impact-note` sibling in `assets/component-card.css` for the PDP scale.
- **`4492f7e`** — bottom-margin fix on `.card__impact-note` and `.product__impact-note`. Without it, descenders on the PDP version collided with the shipping/tax line directly below the price.

Final files touched: `snippets/card-product.liquid`, `sections/main-product.liquid`, `assets/component-card.css`. 25 + 4 line-changes total, no deletions, no schema changes.

Verification (per Daniel, 2026-05-21):
- French Roast 1 PDP renders the line under the price with the spacing fixed.
- French Roast 1's card appears on the homepage Featured Collection with the line under its price.
- Three coffees were spot-tagged (French Roast 1 plus two others), all confirmed.

**Follow-up still on Daniel:** bulk-tag the remaining 44 coffee SKUs with `thrive-impact` from Shopify admin → Products → bulk-edit → Tags. Tracked as a follow-up line in `docs/todo/todo.txt`. No engineering work needed for it.

**Side note** — the brand-review-backlog item that wants `Every cup is a hand up.` as a section heading (todo #32 at the time of refinement) is still open; this task only lands the phrase under product prices.
