# thehaps.app — Haps marketing + legal site

Plain static site. No build step, no framework. Deploy the contents of this
folder to any static host and point `thehaps.app` at it.

## What's here
```
index.html              Landing page
privacy/index.html      Privacy Policy   → served at /privacy
terms/index.html        Terms of Service → served at /terms
event.html              "Open in Haps" page for shared /event/{id} links
404.html                Not-found (also forwards /event/{id} on hosts w/o rewrites)
styles.css              Shared styles
assets/                 Logo / icons / OG image (from Haps-App/brand)
.well-known/
  assetlinks.json                 Android App Links (real release SHA-256 baked in)
  apple-app-site-association      iOS Universal Links (Team J96KB6MDBD)
_redirects              Netlify/Cloudflare Pages: /event/* → event.html (pretty URL)
_headers                Forces application/json on the .well-known files
robots.txt, sitemap.xml SEO
privacy.md, terms.md    Markdown source of the legal copy (reference)
```
Legal pages are **folder/index.html** so `/privacy` and `/terms` resolve on every
host (the app links to those exact paths — no `.html`). All asset/links are
absolute (`/styles.css`, `/assets/...`).

## Deploy (pick one)

### Cloudflare Pages — recommended (easiest custom domain + correct headers)
1. `npm i -g wrangler` then `wrangler login` (run as `! wrangler login` in Claude Code so the browser opens).
2. From this folder: `wrangler pages deploy . --project-name haps-site`
3. In the Cloudflare dashboard → Pages → your project → **Custom domains** → add `thehaps.app`. Cloudflare walks you through DNS.

### Netlify
1. `npm i -g netlify-cli` then `netlify login`.
2. `netlify deploy --prod --dir .`
3. Site settings → Domain management → add `thehaps.app`.
`_redirects` and `_headers` are honored automatically.

### GitHub Pages
1. Put this folder in a repo, push.
2. Add a file named `CNAME` at the root containing `thehaps.app`.
3. Repo → Settings → Pages → Source = your branch / root.
Notes: GitHub Pages ignores `_redirects`/`_headers`. `/privacy` + `/terms` still
work (folder index). Shared `/event/{id}` links fall back via `404.html`. If iOS
Universal Links misbehave, it's usually the AASA content-type — Cloudflare/Netlify
handle it; GitHub Pages may not.

## DNS — move thehaps.app off Squarespace
`thehaps.app` currently resolves to Squarespace's "Coming Soon" page. Point the
apex domain at your chosen host per its instructions above (Cloudflare Pages /
Netlify give you the exact records). `.app` is HSTS-preloaded so **HTTPS is
required** — all three hosts provision TLS automatically.

## ✅ This clears the App Store / Play blocker the moment it's live
Verify (should print the page title, NOT "Coming Soon"):
```
curl -s -L https://thehaps.app/privacy | grep -i '<title>'
curl -s -L https://thehaps.app/terms   | grep -i '<title>'
```
Then register `https://thehaps.app/privacy` as the Privacy Policy URL in **App
Store Connect** and **Google Play Console**.

## Deep links (optional, non-blocking)
The app already points share/event links at `https://thehaps.app/event/{id}` and
this site serves the association files. To make links **auto-open the installed
app**:

- **Android:** `assetlinks.json` has your **release/upload** cert SHA-256
  (`DB:E6:6A:…:24:C1`). When you enroll in **Google Play App Signing**, also add
  the **app-signing** cert SHA-256 from Play Console → *Test and release → App
  integrity → App signing* to the `sha256_cert_fingerprints` array. The app's
  Android manifest already has `autoVerify="true"` for `thehaps.app`.
- **iOS:** the app needs the **Associated Domains** entitlement
  `applinks:thehaps.app` (currently `iosApp.entitlements` only has Apple Sign-In),
  plus a rebuild/re-provision. Ask Claude to add it when you want Universal Links.

Until then, tapping a shared link just opens this site — fine, and far better
than the old un-owned domain.
