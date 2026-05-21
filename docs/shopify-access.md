# Giving Claude access to the Thrive Coffee Shopify store

How to generate a Shopify **Admin API access token** and hand it to Claude so it can run the Shopify admin work on the todo stack (bulk-tag products, update PDP copy, set policies, swap hero images, etc.) without you clicking through the admin UI yourself.

Audience: the GSO director. ~15 minutes, one-time setup.

---

## What this unlocks

With the token, Claude can do these directly (instead of writing instructions for you to follow):

- Bulk-tag the 44 untagged coffee SKUs with `thrive-impact`
- Rewrite PDP descriptions across all 47 coffees
- Paste refund + shipping policy into Settings → Policies
- Update Contact page copy
- Replace stock hero / about images
- Fix "Shop All Collection" → "Shop Apparel" and similar copy fixes
- Set the homepage SEO title + meta description
- Set up the WELCOME10 discount + newsletter automation

What it **does NOT** do:

- Take payment, refund customers, or move money
- Delete products or orders (Claude will always confirm destructive actions)
- See or export customer PII beyond what's needed for the task

---

## Step 1 — Enable custom apps (one-time, if not already done)

1. Open Shopify admin → **Settings** → **Apps and sales channels**
2. Click **Develop apps** (top-right)
3. If prompted, click **Allow custom app development** and confirm

You only do this once per store.

---

## Step 2 — Create the app

1. Still on the **Develop apps** page, click **Create an app**
2. App name: `Claude Code`
3. App developer: your own Shopify staff account
4. Click **Create app**

---

## Step 3 — Configure scopes

Click **Configure Admin API scopes**. Enable the following (search box at the top of the page makes this fast):

### Products & inventory
- `read_products`, `write_products`
- `read_product_listings`
- `read_inventory`, `write_inventory`

### Content (PDP copy, policies, contact page)
- `read_content`, `write_content`
- `read_themes`, `write_themes`
- `read_files`, `write_files`
- `read_online_store_pages`, `write_online_store_pages`
- `read_online_store_navigation`, `write_online_store_navigation`

### Marketing
- `read_discounts`, `write_discounts`
- `read_marketing_events`, `write_marketing_events`
- `read_price_rules`, `write_price_rules`

### Orders (read-only — for sanity checks, never write)
- `read_orders`

Click **Save** at the top.

> If a scope is missing later, you can come back and add it. Claude will tell you the exact one to enable.

---

## Step 4 — Install the app and reveal the token

1. Click the **API credentials** tab
2. Click **Install app** → confirm
3. Under **Admin API access token**, click **Reveal token once**

**This token is only shown one time.** Copy it immediately. If you lose it you'll need to uninstall + reinstall to generate a new one.

The token looks like: `shpat_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx`

Also note your shop URL — the `*.myshopify.com` one, not the custom domain. You can find it in Settings → Domains. It looks like `thrivegso.myshopify.com`.

---

## Step 5 — Store the token locally

Save the token + shop URL to a file outside the git repo so it never gets committed.

Open a terminal and run:

```sh
mkdir -p ~/.config/gso
cat > ~/.config/gso/shopify.env <<'EOF'
SHOPIFY_SHOP=thrivegso.myshopify.com
SHOPIFY_ADMIN_TOKEN=shpat_paste_your_token_here
SHOPIFY_API_VERSION=2025-01
EOF
chmod 600 ~/.config/gso/shopify.env
```

(Replace `thrivegso.myshopify.com` and the token with your actual values.)

`chmod 600` means only your macOS user can read the file — important since it's effectively a password to the store.

---

## Step 6 — Tell Claude where the token is

In any future Claude session, point Claude at the file:

> "The Shopify admin token is at `~/.config/gso/shopify.env`. Bulk-tag the 44 untagged coffee SKUs with `thrive-impact`."

Claude will source the env file and use the credentials via the Shopify Admin REST or GraphQL API.

You only need to do steps 1–5 once. After that, every session just needs that one sentence.

---

## Quick test

To confirm the token works, in a Claude session:

> "Use `~/.config/gso/shopify.env` to fetch the first 5 products from Shopify and show me their titles and tags."

Claude will run something like:

```sh
source ~/.config/gso/shopify.env
curl -s -H "X-Shopify-Access-Token: $SHOPIFY_ADMIN_TOKEN" \
  "https://$SHOPIFY_SHOP/admin/api/$SHOPIFY_API_VERSION/products.json?limit=5&fields=id,title,tags"
```

If you see 5 product titles, you're done.

---

## Revoking access

If you ever want to cut Claude off:

1. Shopify admin → **Settings** → **Apps and sales channels** → **Develop apps**
2. Click the **Claude Code** app
3. **Uninstall app** (top-right) — token is invalidated immediately
4. Delete `~/.config/gso/shopify.env`

You can re-create the app any time using these same steps.

---

## Reference

- Shopify Admin API docs: https://shopify.dev/docs/api/admin
- API version policy: https://shopify.dev/docs/api/usage/versioning (pin a version in the env file so behavior is stable)
- Scope reference: https://shopify.dev/docs/api/usage/access-scopes
- Store admin: https://admin.shopify.com/store/thrivegso (replace with your store handle if different)
