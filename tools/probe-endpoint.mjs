#!/usr/bin/env node
// The SRP grid calls convertus-vms/include/php/ajax-vehicles.php. This works out
// how it is called and what it returns, so the scraper can ask it directly.

import { fetchHtml } from './lib/fetcher.mjs';
import { loadConfig } from './scrape.mjs';

const listingUrl = process.argv[2] || loadConfig().listingUrl;
const origin = new URL(listingUrl).origin;
const SRP_BUNDLE = '/wp-content/plugins/convertus-vms/include/srp/convertus-v4/main.convertus.min.js';
const AJAX = '/wp-content/plugins/convertus-vms/include/php/ajax-vehicles.php';

const show = (label, value) => console.log(String(label).padEnd(22) + ': ' + value);

console.log('=== How the SRP asks for vehicles ===');

let bundle = '';
try {
  ({ html: bundle } = await fetchHtml(origin + SRP_BUNDLE, { timeoutMs: 30000 }));
  show('SRP bundle bytes', bundle.length);
} catch (error) {
  show('SRP bundle', 'could not fetch: ' + error.message);
}

if (bundle) {
  console.log('\n-- every mention of ajax-vehicles, with context --');
  let seen = 0;
  for (const match of bundle.matchAll(/ajax-vehicles/g)) {
    if (seen >= 6) break;
    console.log('  >>> ' + bundle.slice(Math.max(0, match.index - 500), match.index + 500).replace(/\s+/g, ' '));
    console.log('');
    seen += 1;
  }

  console.log('-- parameter-ish keys near the request code --');
  const keys = new Set();
  for (const match of bundle.matchAll(/["']([a-z_][a-z0-9_]{2,28})["']\s*:/gi)) keys.add(match[1]);
  const interesting = [...keys].filter((key) => /page|limit|per|sort|order|type|condition|status|stock|make|model|year|filter|search|lang|dealer|offset|count|view|sc$/i.test(key));
  console.log('  ' + interesting.slice(0, 60).join(', '));
}

// Try the endpoint the way the page would, and see what comes back.
const listingParams = new URL(listingUrl).searchParams;
const attempts = [
  { label: 'GET, same params as the listing', url: origin + AJAX + '?' + listingParams.toString(), init: { method: 'GET' } },
  { label: 'GET, sc=used only', url: origin + AJAX + '?sc=used', init: { method: 'GET' } },
  { label: 'POST, form-encoded listing params', url: origin + AJAX, init: { method: 'POST', body: listingParams.toString(), headers: { 'Content-Type': 'application/x-www-form-urlencoded' } } },
  { label: 'POST, JSON listing params', url: origin + AJAX, init: { method: 'POST', body: JSON.stringify(Object.fromEntries(listingParams)), headers: { 'Content-Type': 'application/json' } } }
];

for (const attempt of attempts) {
  console.log('\n-- ' + attempt.label + ' --');
  console.log('  ' + attempt.url);
  try {
    const response = await fetch(attempt.url, {
      ...attempt.init,
      signal: AbortSignal.timeout(30000),
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        Accept: 'application/json, text/plain, */*',
        Referer: listingUrl,
        'X-Requested-With': 'XMLHttpRequest',
        ...(attempt.init.headers || {})
      }
    });
    const body = await response.text();
    show('  status', response.status + ' ' + response.statusText);
    show('  content-type', response.headers.get('content-type') || '(none)');
    show('  bytes', body.length);
    let parsed = null;
    try { parsed = JSON.parse(body); } catch { /* not JSON */ }
    if (parsed) {
      const top = Array.isArray(parsed) ? '(array of ' + parsed.length + ')' : Object.keys(parsed).join(', ');
      show('  JSON top level', top);
      const list = Array.isArray(parsed) ? parsed
        : parsed.vehicles || parsed.data || parsed.results || parsed.items || null;
      if (Array.isArray(list)) {
        show('  vehicle count', list.length);
        if (list[0]) {
          show('  first record keys', Object.keys(list[0]).slice(0, 40).join(', '));
          console.log('  first record: ' + JSON.stringify(list[0]).slice(0, 1200));
        }
      }
    } else {
      console.log('  body starts: ' + body.slice(0, 400).replace(/\s+/g, ' '));
    }
  } catch (error) {
    show('  failed', error.message);
  }
}
