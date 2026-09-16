#!/usr/bin/env node
// ajax-vehicles.php is a proxy: ?endpoint=<encoded upstream query>&action=vms_data.
// This reconstructs how the SRP builds that endpoint string, then calls it.

import { fetchHtml } from './lib/fetcher.mjs';
import { loadConfig } from './scrape.mjs';

const listingUrl = process.argv[2] || loadConfig().listingUrl;
const origin = new URL(listingUrl).origin;
const SRP_BUNDLE = '/wp-content/plugins/convertus-vms/include/srp/convertus-v4/main.convertus.min.js';
const AJAX = '/wp-content/plugins/convertus-vms/include/php/ajax-vehicles.php';
const show = (label, value) => console.log(String(label).padEnd(22) + ': ' + value);

const { html } = await fetchHtml(listingUrl, { timeoutMs: 30000 });

console.log('=== globalVars in the page ===');
const gvMatch = /globalVars\s*=\s*\{/.exec(html);
if (gvMatch) {
  const start = html.indexOf('{', gvMatch.index);
  let depth = 0;
  let end = start;
  for (let i = start; i < html.length && i < start + 200000; i += 1) {
    if (html[i] === '{') depth += 1;
    else if (html[i] === '}') { depth -= 1; if (depth === 0) { end = i + 1; break; } }
  }
  const blob = html.slice(start, end);
  show('bytes', blob.length);
  try {
    const parsed = JSON.parse(blob);
    for (const [key, value] of Object.entries(parsed)) {
      const printable = typeof value === 'object' ? JSON.stringify(value).slice(0, 120) : String(value).slice(0, 120);
      console.log('  ' + key.padEnd(28) + ' = ' + printable);
    }
  } catch {
    console.log(blob.slice(0, 4000));
  }
} else {
  console.log('  (no globalVars assignment found)');
}

console.log('\n=== how the SRP builds the endpoint string ===');
const { html: bundle } = await fetchHtml(origin + SRP_BUNDLE, { timeoutMs: 30000 });
show('bundle bytes', bundle.length);

const hit = bundle.indexOf('ajax-vehicles');
if (hit !== -1) {
  console.log('\n-- 7000 characters leading up to the request --');
  console.log(bundle.slice(Math.max(0, hit - 7000), hit + 400));
}

console.log('\n-- globalVars keys the bundle reads --');
const gvKeys = [...new Set([...bundle.matchAll(/globalVars\.([A-Za-z0-9_]+)/g)].map((m) => m[1]))];
console.log('  ' + gvKeys.join(', '));

// Try the proxy the way the page calls it, with a few plausible upstream queries.
const search = new URL(listingUrl).search.replace(/^\?/, '');
const candidates = [search, 'sc=used', search + '&pn=1&ipp=24', 'sc=used&pn=1&ipp=24'];

for (const candidate of candidates) {
  const url = `${origin}${AJAX}?endpoint=${encodeURIComponent(candidate)}&action=vms_data`;
  console.log('\n-- endpoint=' + candidate + ' --');
  try {
    const response = await fetch(url, {
      signal: AbortSignal.timeout(30000),
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        Accept: 'application/json, text/plain, */*',
        Referer: listingUrl,
        'X-Requested-With': 'XMLHttpRequest'
      }
    });
    const body = await response.text();
    show('  status', response.status);
    show('  bytes', body.length);
    let parsed = null;
    try { parsed = JSON.parse(body); } catch { /* not JSON */ }
    if (!parsed) { console.log('  body: ' + body.slice(0, 300).replace(/\s+/g, ' ')); continue; }
    show('  top level', Array.isArray(parsed) ? 'array(' + parsed.length + ')' : Object.keys(parsed).join(', '));
    const list = Array.isArray(parsed) ? parsed : parsed.vehicles || parsed.data || parsed.results || parsed.items || parsed.inventory;
    if (Array.isArray(list) && list.length) {
      show('  vehicles', list.length);
      show('  record keys', Object.keys(list[0]).join(', '));
      console.log('  sample: ' + JSON.stringify(list[0]).slice(0, 1500));
    } else {
      console.log('  payload: ' + JSON.stringify(parsed).slice(0, 700));
    }
  } catch (error) {
    show('  failed', error.message);
  }
}
