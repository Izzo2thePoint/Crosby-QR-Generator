# Crosby VW Label Studio

Finds newly listed pre-owned vehicles on crosbyvw.com, builds a 2.5" × 3.5" QR window
label for each one, and prints them — one label per page — with no data entry.

The QR code on each label opens that vehicle's page on the website, with a tracking tag
attached so QR scans show up in your website analytics.

**Nothing to install.** GitHub checks the inventory through the day and republishes a web
page. You open that page in any browser, tick the new vehicles, and print.

---

## Setup — once, all in the browser

1. **Merge this into `main`.** The scheduled inventory check only runs from the main branch.
2. **Turn on GitHub Pages:** repository **Settings → Pages → Build and deployment → Source:
   GitHub Actions**. Save.
3. **Run the first check:** **Actions** tab → *Refresh inventory and publish label page* →
   **Run workflow**. It takes about a minute.
4. **Add your logos** so every computer gets them: **Add file → Upload files** into the
   `assets` folder, named exactly:
   - `logo-header.png` — the wide *Crosby Volkswagen* wordmark (top of the label)
   - `logo-icon.png` — the square VW roundel (centre of the QR code)

   (PNG with a transparent background looks best. SVG/JPG also work — keep the same names.)
   If you'd rather not commit them, the page will ask you to upload them and remember them in
   that browser instead.
5. **Bookmark the page:** `https://izzo2thepoint.github.io/Crosby-QR-Generator/`

> **The first check prints nothing on purpose.** Everything already listed is recorded as
> "already on the lot" so you don't print 60 labels by accident. Anything that appears after
> that shows up under **New arrivals**. Labels for current stock are in **All used inventory**.

---

## Everyday use

1. Open the bookmark.
2. **New arrivals** lists every pre-owned vehicle that has appeared since you last printed,
   already ticked.
3. **Print selected labels** → your normal print dialog → print.
4. Click **Yes, mark as printed** on the bar at the bottom. If it printed badly, choose
   **Not yet** and they stay queued.

| Want to… | Where |
|---|---|
| Reprint a label for anything in stock | **All used inventory** (search by stock #, model, VIN) |
| Label a vehicle not on the website yet | **Manual label** |
| Drop a vehicle without printing | Tick it → **Skip selected** |
| QR colours/shape, paper size, cut guide | **Label & printing options** |
| Pull the newest list right now | **Reload latest inventory**, top right |

### Print dialog settings that matter

**Margins: Default**, **Scale: 100%** (not "Fit to page"), and **Background graphics: on** so the
QR prints solid. Chrome and Edge remember this after the first time.

### Two things to know about the published page

- **Which labels you've printed is remembered in that browser.** Print from the same computer
  and browser each time, or the queue will look different. There's a **Clear print history**
  button under *Label & printing options*.
- **The page is public** (that's how free GitHub Pages works). It shows the same inventory
  your website already shows publicly, but don't add anything private to it.

---

## When the automatic check can't read the site

Websites change and bot filters happen. The page tells you when its list is stale, and the
**Paste from website** tab is the backup:

1. Open the used inventory page in another tab.
2. **Ctrl + U** (view source), then **Ctrl + A**, **Ctrl + C**.
3. Paste into the box → **Read vehicles from this page**.

It reads the pasted page with the same logic as the automatic check, entirely inside your
browser, and the vehicles land in the queue as normal.

If that happens, it means the reader needs adjusting — the failed run saves a copy of what it
received under `data/debug/` in the Actions logs. Send it along with a note and it's usually a
quick fix.

---

## Settings — `config.json`

```json
{
  "listingUrl": "https://www.crosbyvw.com/vehicles/?sc=used&in_transit=true&in_stock=true&on_order=true&view=grid",
  "qrTracking": { "utm_source": "window_sticker", "utm_medium": "qr", "utm_campaign": "used_inventory" }
}
```

- `listingUrl` — the inventory page it reads. Drop `in_transit=true` to only get vehicles
  physically on the lot, or paste any filtered inventory URL from the website.
- `qrTracking` — parameters added to each QR link. `{}` for clean links.
- `requestDelayMs` / `maxPages` — how gently it walks the site. The defaults are polite.

**How often it checks:** every two hours between 8am and 6pm Kitchener time. Change the `cron`
line in `.github/workflows/inventory.yml` (it's in UTC — add 4 hours to Eastern in summer, 5 in
winter).

---

## Optional: run it on a PC instead

If a computer ever does have Node.js (nodejs.org, LTS), you can run the whole thing locally and
skip GitHub entirely — the print history then lives in `data/state.json` on that PC instead of
in a browser:

```
run.cmd        Windows
./run.sh       Mac / Linux
```

It scrapes, opens the same page at `http://127.0.0.1:4321`, and remembers what was printed.
Nothing is uploaded anywhere; the only outbound traffic is reading crosbyvw.com.

---

## How "new" is decided

Every vehicle is keyed by stock number (VIN, then page link, as backstops). A vehicle counts as
new until you print or skip it — so a paper jam, a crash, or a closed tab never loses a label.
If a vehicle sells before you print it, it drops off the queue and the page says so.

---

## Checking the plumbing

```
node tools/selftest.mjs
```

Stands up a pretend dealer website and walks the whole cycle: scrape → new arrival → print →
marked printed → vehicle sold. It also runs automatically on every pull request
(**Actions → Self-test**), so you don't need Node to see the result.

---

## What's in the folder

| File | Purpose |
|---|---|
| `labels.html` | The Label Studio screen — published to Pages as `index.html` |
| `.github/workflows/inventory.yml` | The scheduled check and publish |
| `config.json` | Settings |
| `tools/scrape.mjs` | Reads the listing, decides what's new |
| `tools/serve.mjs` | Local-PC mode only: runs the app, records what was printed |
| `tools/lib/` | Page reading, vehicle matching, print history |
| `tools/selftest.mjs` | End-to-end check |
| `vendor/` | QR + image libraries, kept local so nothing depends on a CDN |
| `assets/` | Your logos |
| `data/` | Published inventory + first-seen history (committed by the scheduled job) |
