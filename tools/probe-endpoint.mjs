#!/usr/bin/env node
// The grid has a <pagination> component wired to updatePage(). Find what that
// sends, and confirm facet slicing reaches all 40 vehicles either way.
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
  try { return JSON.parse(text); } catch { return { raw: text.slice(0, 160) }; }
}

const { html: bundle } = await fetchHtml(gv.pluginsUrl + '/convertus-vms/include/srp/convertus-v4/main.convertus.min.js', { timeoutMs: 30000 });
console.log('=== paging code in the bundle ===');
for (const term of ['updatePage', 'availablePages', 'currentPage']) {
  let shown = 0;
  for (const match of bundle.matchAll(new RegExp(term, 'g'))) {
    if (shown >= 3) break;
    console.log(`  [${term}] ...` + bundle.slice(Math.max(0, match.index - 450), match.index + 450).replace(/\s+/g, ' ') + '...');
    console.log('');
    shown += 1;
  }
}

const base = await call(filtering('sc=used'));
const total = (base.summary || {}).total_vehicles;
const baseStocks = (base.results || []).map((v) => v.stock_number);
console.log(`\n=== baseline: ${baseStocks.length} of ${total} ===`);

console.log('\n=== summary facets available for slicing ===');
for (const [key, value] of Object.entries(base.summary || {})) {
  if (Array.isArray(value) && value.length && value[0] && value[0].name !== undefined) {
    console.log('  ' + key + ': ' + value.map((entry) => `${entry.name}(${entry.amount})`).join(', ').slice(0, 300));
  }
}

console.log('\n=== page + size combinations ===');
for (const query of ['sc=used&pn=2&ipp=30', 'sc=used&pg=2&ipp=30', 'sc=used&pn=2&ipp=24', 'sc=used&page=2&per_page=30', 'sc=used&ipp=30&pn=2&sb=price']) {
  const payload = await call(filtering(query));
  const stocks = (payload.results || []).map((v) => v.stock_number);
  console.log(`  ${query.padEnd(34)} -> ${stocks.length}, first=${stocks[0]}${stocks[0] && stocks[0] !== baseStocks[0] ? '  <-- DIFFERENT' : ''}`);
  await sleep(120);
}

console.log('\n=== slicing by body style ===');
const collected = new Set(baseStocks);
for (const entry of (base.summary || {}).bs || []) {
  const payload = await call(filtering('sc=used&bs=' + encodeURIComponent(entry.name)));
  const stocks = (payload.results || []).map((v) => v.stock_number);
  const fresh = stocks.filter((stock) => !collected.has(stock));
  fresh.forEach((stock) => collected.add(stock));
  console.log(`  bs=${entry.name}: expected ${entry.amount}, got ${stocks.length}, ${fresh.length} new`);
  await sleep(120);
}
console.log(`\n  gathered ${collected.size} of ${total} distinct vehicles`);
