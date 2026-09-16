#!/usr/bin/env node
// Two questions left: what does the grid put in its params object, and what
// filter values can we slice the lot by?
import { fetchHtml, sleep } from './lib/fetcher.mjs';
import { loadConfig } from './scrape.mjs';

const listingUrl = process.argv[2] || loadConfig().listingUrl;
const { html } = await fetchHtml(listingUrl, { timeoutMs: 30000 });

const gvStart = html.indexOf('{', /globalVars\s*=\s*\{/.exec(html).index);
let depth = 0;
let gvEnd = gvStart;
for (let i = gvStart; i < html.length; i += 1) {
  if (html[i] === '{') depth += 1;
  else if (html[i] === '}') { depth -= 1; if (depth === 0) { gvEnd = i + 1; break; } }
}
const gv = JSON.parse(html.slice(gvStart, gvEnd));
const proxy = gv.pluginsUrl + '/convertus-vms/include/php/ajax-vehicles.php';
const tags = '&hzpv=true&tg=' + gv.inventoryTags + '&tgm=' + gv.inventoryTagsMethod + '&tgsc=' + gv.inventoryTagsSaleClass;
const filtering = (query) => `${gv.vmsApiUrl}filtering/?cp=${gv.inventoryId}&ln=en&${query}${tags}`;

async function call(endpoint) {
  const response = await fetch(proxy + '?endpoint=' + encodeURIComponent(endpoint) + '&action=vms_data', {
    signal: AbortSignal.timeout(30000),
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      Accept: 'application/json', Referer: listingUrl, 'X-Requested-With': 'XMLHttpRequest'
    }
  });
  const text = await response.text();
  try { return JSON.parse(text); } catch { return { raw: text.slice(0, 200) }; }
}

const base = await call(filtering('sc=used'));
const baseStocks = new Set((base.results || []).map((v) => v.stock_number));
console.log('baseline: ' + baseStocks.size + ' of ' + (base.summary || {}).total_vehicles);

console.log('\n=== all_filters ===');
const all = base.all_filters || {};
console.log('  keys: ' + Object.keys(all).join(', '));
for (const key of ['yr', 'mk', 'md', 'bs', 'sc']) {
  if (all[key]) console.log('  ' + key + ': ' + JSON.stringify(all[key]).slice(0, 400));
}

console.log('\n=== how the page talks about paging ===');
for (const term of ['pagination', 'paging', 'loadMore', 'load-more', 'itemsPerPage', 'perPage', 'currentPage', '"pn"', 'pn:', '"pg"', 'pg:']) {
  const index = html.indexOf(term);
  if (index !== -1) console.log(`  ${term}: ...${html.slice(Math.max(0, index - 200), index + 200).replace(/\s+/g, ' ')}...`);
}

const bundleUrl = gv.pluginsUrl + '/convertus-vms/include/srp/convertus-v4/main.convertus.min.js';
const { html: bundle } = await fetchHtml(bundleUrl, { timeoutMs: 30000 });
console.log('\n=== where the bundle builds vehicle-request params ===');
let shown = 0;
for (const match of bundle.matchAll(/["']sc["']\s*:/g)) {
  if (shown >= 5) break;
  console.log('  >>> ' + bundle.slice(Math.max(0, match.index - 400), match.index + 400).replace(/\s+/g, ' '));
  console.log('');
  shown += 1;
}

// Slice by make: the fallback that reaches every vehicle.
console.log('\n=== make slices ===');
const makes = (all.mk || []).map((entry) => entry.name || entry.value || entry).filter(Boolean);
console.log('  makes: ' + makes.join(', '));
const collected = new Set(baseStocks);
for (const make of makes.slice(0, 20)) {
  const payload = await call(filtering('sc=used&mk=' + encodeURIComponent(make)));
  const stocks = (payload.results || []).map((v) => v.stock_number);
  const fresh = stocks.filter((stock) => !collected.has(stock));
  fresh.forEach((stock) => collected.add(stock));
  console.log(`  mk=${make}: ${stocks.length} returned (total ${(payload.summary || {}).total_vehicles}), ${fresh.length} new`);
  await sleep(120);
}
console.log('\n  distinct stock numbers gathered: ' + collected.size + ' of ' + (base.summary || {}).total_vehicles);
