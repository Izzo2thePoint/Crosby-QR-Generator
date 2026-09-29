#!/usr/bin/env node
// Reports whether the site can be reached, and what each page the reader uses
// holds: the search page (the first page of results), the per-make pages, and
// the counts the site publishes. If the reader comes up empty or short, this
// shows which piece changed.

import { loadConfig } from './scrape.mjs';
import { isD2cListing, readBrandCounts, readD2cCards } from './lib/d2c.mjs';
import { isPrintable } from './lib/vehicles.mjs';

const listingUrl = process.argv[2] || loadConfig().listingUrl;
const origin = new URL(listingUrl).origin;

const CHROME = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36';
const browserHeaders = {
  'User-Agent': CHROME,
  Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
  'Accept-Language': 'en-CA,en;q=0.9'
};

async function attempt(label, url, expected = null) {
  const started = Date.now();
  try {
    const response = await fetch(url, { headers: browserHeaders, redirect: 'follow', signal: AbortSignal.timeout(25000) });
    const html = await response.text();
    let note = `${html.length} bytes`;
    if (/just a moment|cf-chl|challenge-platform|attention required/i.test(html)) note += ' (bot challenge page)';
    if (isD2cListing(html)) {
      const cards = readD2cCards(html, response.url);
      note = `${cards.length} vehicle card(s)${expected === null ? '' : ` (site says ${expected})`}, ` +
        `${cards.filter(isPrintable).length} complete enough to print`;
    } else if (/globalVars/.test(html)) {
      note += ' (the previous platform\'s page)';
    } else {
      note += ' (no vehicle cards)';
    }
    const moved = response.url !== url ? `  -> ${response.url}` : '';
    console.log(`  ${String(response.status).padEnd(4)} ${label.padEnd(36)} ${note}  [${Date.now() - started}ms]${moved}`);
    return { status: response.status, html, finalUrl: response.url };
  } catch (error) {
    console.log(`  ---  ${label.padEnd(36)} failed: ${error.message}`);
    return null;
  }
}

console.log('=== can we reach the dealership site? ===');
await attempt('site root', origin + '/');
const listing = await attempt('used vehicle search page', listingUrl);

const brands = listing ? readBrandCounts(listing.html, listing.finalUrl) : null;
if (!brands) {
  console.log('\n  The search page no longer lists its stock by brand, so the total cannot be checked.');
} else {
  const total = brands.reduce((sum, entry) => sum + entry.count, 0);
  console.log(`\n=== the site's own counts: ${total} vehicle(s) ===`);
  for (const entry of brands) await attempt(entry.label, entry.url, entry.count);
}
