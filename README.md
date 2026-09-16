# Crosby VW Label Studio

Finds newly listed pre-owned vehicles on crosbyvw.com, builds a 2.5" × 3.5" QR window
label for each one, and prints them — one label per page — without typing a thing.

The QR code on each label opens that vehicle's page on the website, with a tracking tag
attached so QR scans show up in your website analytics.

---

## Install once

1. **Install Node.js** — the LTS build from <https://nodejs.org>. Click through the installer
   with the defaults. (This is the only prerequisite; nothing else to install.)
2. **Download this folder** to the computer that has the printer (Code → Download ZIP on
   GitHub, then unzip it somewhere permanent like `Documents\Crosby-QR-Generator`).
3. **Double-click `run.cmd`** (`run.sh` on Mac/Linux). A black window opens and your browser
   opens the Label Studio.
4. **Upload your two logos** the first time it runs:
   - the wide *Crosby Volkswagen* wordmark (top of the label)
   - the square VW roundel (centre of the QR code)

   They are saved into the `assets` folder, so you only do this once.

> **First run is deliberately quiet.** Everything already listed on the website is recorded as
> "already on the lot" so you don't accidentally print 60 labels. From then on, anything new
> that appears on the site shows up under **New arrivals**. Need a label for a vehicle that was
> already in stock? It's in the **All used inventory** tab.

**Handy:** right-click `run.cmd` → *Send to* → *Desktop (create shortcut)* for one-click access.

---

## Everyday use

1. Double-click `run.cmd`. It checks the website automatically as it starts.
2. The **New arrivals** tab lists every pre-owned vehicle that has appeared since the last time
   you printed. They're all ticked by default.
3. Click **Print selected labels** → your normal print dialog opens → print.
4. Answer **Yes, mark as printed** on the bar at the bottom. Those vehicles stop appearing as new.
   If the print didn't come out right, choose **Not yet** and they stay queued.
5. Close the black window when you're done.

Other things you can do:

| Want to… | Where |
|---|---|
| Reprint a label for any vehicle in stock | **All used inventory** tab (search by stock #, model or VIN) |
| Label a vehicle the website doesn't show yet | **Manual label** tab |
| Drop a vehicle out of the queue without printing | Tick it → **Skip selected** |
| Change QR colours/shape, paper size, cut guide | **Label & printing options** on the right |
| Check for new stock without restarting | **Check for new vehicles** button, top right |

### Printer settings that matter

In the print dialog, set **Margins: Default** and **Scale: 100%** (not "Fit to page"), and turn
**Background graphics** on so the QR prints solid black. Chrome and Edge both remember this.

---

## How "new" is decided

The tool keeps a record in `data/state.json` of every vehicle it has already produced a label
for, keyed by stock number (VIN or page link as a backstop). A vehicle counts as new until you
print or skip it — so a paper jam, a crash, or closing the tab never loses a label.

If a vehicle sells before you print it, it quietly drops off the queue and the tool tells you.

**Keep the `data` folder.** If you move the tool to another computer, copy `data/state.json`
across too, otherwise the new copy treats the whole lot as fresh stock.

---

## Settings — `config.json`

```json
{
  "listingUrl": "https://www.crosbyvw.com/vehicles/?sc=used&in_transit=true&in_stock=true&on_order=true&view=grid",
  "qrTracking": { "utm_source": "window_sticker", "utm_medium": "qr", "utm_campaign": "used_inventory" }
}
```

- `listingUrl` — the inventory page it reads. Change the filters here (for example drop
  `in_transit=true` if you only want vehicles physically on the lot), or paste any other
  filtered inventory URL from the website.
- `qrTracking` — parameters added to each QR link. Set it to `{}` for clean links.
- `requestDelayMs` / `maxPages` — how gently it walks the site. The defaults are polite.
- `port` — change only if something else on the PC uses 4321.

---

## If something goes wrong

**"No vehicles could be read from the listing page."**
The website's layout changed, or the listing is rendered by JavaScript the tool can't see. The
tool saves a copy of the page it received to `data/debug/listing-page-1.html` — send that file
to whoever maintains this tool and the reader can be re-pointed in minutes.

**"Could not reach crosbyvw.com."**
Usually the dealership network or the site being down. The last successful inventory stays on
screen; hit **Check for new vehicles** to retry.

**A vehicle is missing a stock number.**
It gets listed as "skipped — incomplete" rather than printed with a blank field. Use the
**Manual label** tab for that one.

**Nothing opens / the black window closes instantly.**
Node.js isn't installed or isn't on the PATH. Reinstall from <https://nodejs.org> and reboot.

**Check the plumbing at any time:**

```
node tools/selftest.mjs
```

That stands up a pretend dealer website, scrapes it, and walks the whole
new-vehicle → print → marked-printed cycle. All ten checks should pass.

---

## What's in the folder

| File | Purpose |
|---|---|
| `run.cmd` / `run.sh` | What you double-click |
| `labels.html` | The Label Studio screen (review, preview, print) |
| `config.json` | Settings |
| `tools/scrape.mjs` | Reads the inventory listing, decides what's new |
| `tools/serve.mjs` | Runs the local app, remembers what was printed |
| `tools/lib/` | Page reading, vehicle matching, print history |
| `tools/selftest.mjs` | End-to-end check |
| `vendor/` | QR + image libraries, kept local so nothing depends on the internet |
| `assets/` | Your logos |
| `data/` | Inventory snapshot and print history (don't delete) |

Nothing is uploaded anywhere: the app runs on `127.0.0.1`, reachable only from that computer.
The only outbound traffic is reading crosbyvw.com's public inventory pages.
