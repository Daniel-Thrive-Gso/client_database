# Replace hero and about-section imagery

**Source:** "Replace stock hero image lkhlhk.jpg and about-section image dsfdsfds.jpg with curated mission/coffee imagery"
**Created:** 2026-05-21
**Status:** paused mid-Phase-2 (awaiting Daniel's Shopify Files upload)
**Paused:** 2026-05-21

## Resume from here

When ready to continue (run `/do` and pick this slug, or pick up manually):

1. **Daniel uploads two local files to Shopify admin → Settings → Files:**
   - `C:\Users\gsomi\OneDrive\Pictures\Screenshots\thrive-hero-2026-05-21.jpg` (2400 × 1347, 234 KB — the cropped Nathan Dumlao kettle image)
   - `C:\Users\gsomi\OneDrive\Pictures\Screenshots\thrive-about-2026-05-21.jpg` (1330 × 1163, 168 KB — the cropped GSO meeting-room photo)
2. Daniel pastes the **exact filenames Shopify assigned** (may include a hash suffix).
3. Edit `thrive-coffee-theme/templates/index.json`:
   - Line 47: `shopify://shop_images/lkhlhk.jpg` → `shopify://shop_images/<new-hero-filename>`
   - Line 143: `shopify://shop_images/dsfdsfds.jpg` → `shopify://shop_images/<new-about-filename>`
4. `cd thrive-coffee-theme && git add templates/index.json && git commit -m "Swap homepage hero and About-block placeholders for curated imagery (hero: Nathan Dumlao / Unsplash; about: GSO program meeting, internal)" && git push origin main`
5. Run the Verification section below.

**Working files outside the git repo (persistent on Daniel's machine, not tracked):**
- Source GSO photo: `C:\Users\gsomi\OneDrive\Pictures\Screenshots\Untitled design (6).png` (2048 × 1419 PNG)
- Source hero download: previously overwritten by the cropped output at the same path (`thrive-hero-2026-05-21.jpg`); can be re-downloaded from `https://unsplash.com/photos/P7f2tF_0O28/download?force=true` if needed
- Cropped outputs: the two `thrive-*-2026-05-21.jpg` files listed above
- Sharp scripts: `Thrive-Coffee/process-about-image.js`, `Thrive-Coffee/process-hero-image.js` (in this repo, not committed). Both hardcode an absolute `require` path for the globally-installed sharp (`C:/Users/gsomi/AppData/Roaming/npm/node_modules/sharp-cli/node_modules/sharp`). Re-runnable as `node Thrive-Coffee/process-*.js` from `C:\Users\gsomi\gso`.

## Goal
Swap two placeholder images on the Thrive Coffee homepage for curated, on-brand stock photography that actually communicates the mission (and stops looking like a developer left the keyboard on the desk). The hero image needs to feel transformational + hopeful behind the "From Surviving to Thriving." headline; the about-section image needs to communicate the mission tie-in next to the "More Than Coffee. A Mission." block — and crucially, it needs to *stop being another dark-bag close-up* (flagged by design-critique 2026-05-20 task #20).

Per Daniel's refinement call: sourcing path is free-license curated stock (Unsplash / Pexels). People are OK in either image **only if anonymized** — backs of heads, silhouettes, hands at work, partial figures. No identifiable faces (the client-photo consent process is unresolved per the brand-voice doc Open Question #2, so we route around it entirely here).

## Context

- **References live in `thrive-coffee-theme/templates/index.json`** (not in the theme repo — they're Shopify Files references). The two settings to change:
  - Hero (line 47): `"image": "shopify://shop_images/lkhlhk.jpg"` inside the `image_banner_DeFkdK` section (`type: image-banner`). Heading: "From Surviving to Thriving." Subtitle: "Small-batch coffee with a clear purpose. Every bag funds men rebuilding their lives at Good Samaritan Outreach." Content position `middle-left`; image overlay opacity 10%; height `adapt`.
  - About (line 143): `"image": "shopify://shop_images/dsfdsfds.jpg"` inside the `image_with_text_8NGrDb` section (`type: image-with-text`). Heading: "More Than Coffee. A Mission." Layout `image_first`, desktop image width `medium`, content position `middle/center`. Color scheme 1 (cream).
- **Placeholder filenames `lkhlhk.jpg` and `dsfdsfds.jpg`** are obvious keyboard-mash names — these were almost certainly left over from Shopify's theme onboarding flow and never replaced.
- **Image dimensions to aim for:**
  - Hero: 2400 × 1200 (or 2400 × 1350 / 2400 × 1600) — wide, retina-ready, room for the text overlay on the left third. Avoid busy detail in the left third.
  - About: 1200 × 1200 to 1600 × 1200 — squarish or moderate landscape, since `desktop_image_width: "medium"` renders the image at roughly half-column.
- **Brand palette to respect when shortlisting:** cream `#F5EFE0`-ish background, navy `#1B1F3A`, gold `#FFB600`. Photos that are warm-tone (golden hour, amber, cream) will sit better next to the cream `scheme-1` than cool/blue-dominant images.
- **Design-critique constraint (task #20):** the about image must *not* be another dark-bag product close-up. Avoid coffee-bag photography for the about slot specifically. Hero can include a bag if it's clearly aspirational/lifestyle, not pack-shot.
- **Shopify Files upload path:** Shopify admin → Settings → Files → Upload files. Once uploaded, the file appears under `shopify://shop_images/<filename>`. Renaming reference in index.json is a one-line JSON edit per image. Old placeholders can stay in Files (or be deleted from Files later) — removing the reference from index.json is enough to take them off the storefront.
- **Deploy pipeline:** push `templates/index.json` to `Thrive-Coffee/main` → GitHub connector syncs the theme to Shopify within ~1 min. Theme is published. *Caveat from memory:* Shopify schema validation silently drops files on sync if validation fails — index.json is a settings file so risk is low, but if the page goes blank after deploy, the sync was rejected.
- **Adjacent backlog items (do NOT close, do NOT pre-empt):**
  - Design-critique task #20 (about-image swap) — partially handled here; once this ships, that line can move to changelog.
  - Mission-page hero image (todo "Add a hero image to the Mission page") — separate page, separate scope.
  - Hero re-treat / composition critique (next-5 task: "Re-treat the hero composition so the headline is the hero and the bag mockup supports the type") — that's a layout/text-treatment task, not an image swap. Different task.

## Out of scope
- Adding a hero image to the **Mission page** (`/pages/mission`) — separate todo line, handled later.
- Hero composition / layout / typography refinement (design-critique next-5 task).
- ~~Photo of a real GSO client — blocked on consent process per brand-voice Open Question #2; sourcing via stock specifically avoids this.~~ **Reversed mid-task 2026-05-21:** Daniel provided a real meeting-room photo of program clients with consent already signed; this is now the about-image source, hero stays stock. Crop intentionally hides some of the photoshopped white mugs (~3–4 still visible). The brand-voice Open Question #2 (consent process for client photos) remains open as a *policy* item but is not blocking this specific photo.
- Touching any other section settings (announcement bar, footer, partnership strip, featured collection, etc.).
- Deleting the old `lkhlhk.jpg` / `dsfdsfds.jpg` from Shopify Files — left in place for safety; reference removal is enough.

## Phases

### Phase 1: Shortlist + select images
- [x] Search Unsplash for **hero** candidates matching: warm-tone coffee or pour-over scene, anonymized hands or silhouette OK, clean lower-noise left third (for text overlay), wide landscape ratio. Presented 4 candidates (H1–H4).
- [x] ~~Search Unsplash + Pexels for **about** candidates~~ **Reversed:** Daniel provided a real GSO program meeting-room photo (`C:\Users\gsomi\OneDrive\Pictures\Screenshots\Untitled design (6).png`, 2048 × 1419 PNG) and asked for tighter crop to hide some of the visibly photoshopped white coffee mugs. Consent on the men's faces is already signed (confirmed 2026-05-21).
- [x] **About image cleanup:** ran `Thrive-Coffee/process-about-image.js` (sharp) to extract a 1330×1163 region from the source (skips left ~30% so the TV/projector + the speaker's edge + the first fake mug drop out; trims the top 15% so the fluorescent ceiling reads less institutionally). Applied modest desaturation (`saturation: 0.82, brightness: 1.06`) and a mild contrast bump (`linear(1.08, -6)`) to pull the harsh fluorescent edge off and let the foreground silhouettes pop. JPEG q88 mozjpeg, ~168 KB. Output saved to `C:\Users\gsomi\OneDrive\Pictures\Screenshots\thrive-about-2026-05-21.jpg`.
- [x] Daniel picked **H1** (Nathan Dumlao, `https://unsplash.com/photos/P7f2tF_0O28` — hands pouring water into a black ceramic mug) for the hero and signed off on the about crop as-is.
- [x] Hero license: Unsplash License (commercial use allowed, no attribution required). Photographer credit recorded in the commit message for discoverability.

### Phase 2: Upload + swap references
- [x] Downloaded H1 hero (Nathan Dumlao, Unsplash `P7f2tF_0O28`) — turned out to be a **portrait** photo (4187 × 6280). Ran `Thrive-Coffee/process-hero-image.js` (sharp) to extract a horizontal 16:9 band (y=1900 to y=4250, full width), then resized to 2400 × 1347 for retina. JPEG q90 mozjpeg, ~234 KB. Output to `C:\Users\gsomi\OneDrive\Pictures\Screenshots\thrive-hero-2026-05-21.jpg`. Left half is blurry counter (text-overlay friendly), right half is black gooseneck kettle + hand.
- [x] About image already processed and saved to `C:\Users\gsomi\OneDrive\Pictures\Screenshots\thrive-about-2026-05-21.jpg` (1330 × 1163, ~168 KB).
- [ ] Daniel uploads both files to **Shopify admin → Settings → Files**. (I can't upload to Shopify Files via code; this is a manual admin step.)
- [ ] Daniel pastes back the exact filenames Shopify assigned (Shopify sometimes appends a hash if there's a collision).
- [ ] In `thrive-coffee-theme/templates/index.json`, change line 47's value from `shopify://shop_images/lkhlhk.jpg` to `shopify://shop_images/<new-hero-filename>`.
- [ ] In the same file, change line 143's value from `shopify://shop_images/dsfdsfds.jpg` to `shopify://shop_images/<new-about-filename>`.

### Phase 3: Commit, deploy, verify
- [ ] `git diff` should be limited to `templates/index.json`, ~2 lines changed.
- [ ] Commit with a plain-English message naming the swap (e.g., "Swap homepage hero and About-block placeholders for curated stock imagery"). Push to `Thrive-Coffee/main`.
- [ ] Wait ~1 min for Shopify sync. If the homepage goes blank or 500s, the sync was rejected — revert immediately by reverting the commit (this is the schema-validation risk in the memory note).
- [ ] Hard-refresh the live storefront homepage. Hero image should be the new one with the headline still readable over the 10% dark overlay. "More Than Coffee. A Mission." block should show the new about image, no dark-bag pack-shot, no whitespace-collapse.
- [ ] Daniel signs off on look + readability.

## Risks / open questions
- **Hero text legibility.** The image-banner section overlays text at `desktop_content_position: middle-left` with only 10% image overlay opacity. If Daniel's hero pick has busy or bright detail in the left third, the headline will get hard to read. Mitigation: shortlist deliberately favors photos with calm/dark/low-contrast left thirds. If the chosen pick fails legibility, options are: bump overlay opacity from 10% → 30–40%; or pick a different photo. Don't change `desktop_content_position` — that's a layout call, not an image-swap call.
- **About image aspect.** The current `image_with_text` setting `desktop_image_width: medium` means the rendered image is roughly column-half. A very wide landscape will look weak there. Squarish (1:1 or 4:3) reads better.
- **Mobile.** The hero stacks above text on mobile; the about block stacks image-then-text (since `layout: image_first`). Both shortlists need to read well at narrow widths — avoid horizontal-only compositions where the subject sits in the corner.
- **License paperwork.** Unsplash + Pexels both allow commercial use with no attribution required. We'll still record photographer credits in the commit message so they're discoverable if Daniel ever wants to add them on-site.
- **Schema-validation revert.** Per the memory note, Shopify can silently reject sync if a settings file fails validation. The change here is a single string value per image — extremely low risk — but if the live homepage breaks after deploy, the fix is to revert the commit, not to keep debugging.

## Verification
1. Open the live homepage in an incognito window (so no cached assets). Hero loads with the new image; "From Surviving to Thriving." headline + "Small-batch coffee with a clear purpose..." subtitle + "Shop Coffee" button are readable over the 10% overlay.
2. Scroll to the "More Than Coffee. A Mission." block. The new about image renders to the left of (or above, on mobile) the heading + body + "Shop the Collection" button. It is **not** another dark-bag close-up.
3. Resize the browser to mobile width. Hero composition still works; about block stacks cleanly with image above text.
4. Check the page in dark mode? Storefront has its own scheme (cream / navy / gold) and ignores OS dark mode — no test needed.
5. Once look is signed off, close out design-critique 2026-05-20 task #20 (the "swap the dark-bag photo" line in `docs/todo/todo.txt`) — this task handles it.
