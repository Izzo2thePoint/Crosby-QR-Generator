#!/usr/bin/env node
// Nails down pagination: the filtering endpoint returns 30 vehicles per call.
import { fetchHtml } from './lib/fetcher.mjs';
import { loadConfig } from './scrape.mjs';

const listingUrl = process.argv[2] || loadConfig().listingUrl;
const show = (label, value) => console.log(String(label).padEnd(20) + ': ' + value);
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
const base = gv.vmsApiUrl + 'filtering/?cp=' + gv.inventoryId + '&ln=' + (gv.language || 'en') + '&';
const tags = '&hzpv=true&tg=' + gv.inventoryTags + '&tgm=' + gv.inventoryTagsMethod + '&tgsc=' + gv.inventoryTagsSaleClass;

async function call(query) {
  const response = await fetch(proxy + '?endpoint=' + encodeURIComponent(base + query + tags) + '&action=vms_data', {
    signal: AbortSignal.timeout(30000),
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      Accept: 'application/json', Referer: listingUrl, 'X-Requested-With': 'XMLHttpRequest'
    }
  });
  return JSON.parse(await response.text());
}

const first = await call('sc=used');
console.log('=== summary block ===');
console.log(JSON.stringify(first.summary).slice(0, 1200));
console.log('\n=== filters block keys ===');
console.log(Object.keys(first.filters || {}).join(', '));
console.log('\n=== what page 1 contains ===');
show('results', first.results.length);
show('stock numbers', first.results.map((v) => v.stock_number).join(', '));
show('sale classes', [...new Set(first.results.map((v) => v.sale_class))].join(', '));

console.log('\n=== how the bundle asks for later pages ===');
const { html: bundle } = await fetchHtml(gv.pluginsUrl + '/convertus-vms/include/srp/convertus-v4/main.convertus.min.js', { timeoutMs: 30000 });
let shown = 0;
for (const match of bundle.matchAll(/ajaxVehicles\s*\(/g)) {
  if (shown >= 5) break;
  console.log('  >>> ' + bundle.slice(Math.max(0, match.index - 260), match.index + 260).replace(/\s+/g, ' '));
  shown += 1;
}
const pageKeys = [...new Set([...bundle.matchAll(/["'`](p|pg|pn|page|pageNumber|offset|start|ipp|rpp|limit|per_page)["'`]\s*[:=]/g)].map((m) => m[1]))];
show('\npage-ish keys', pageKeys.join(', '));

console.log('\n=== trying page parameters ===');
const firstStock = first.results[0].stock_number;
for (const query of ['sc=used&pg=2', 'sc=used&p=2', 'sc=used&page=2', 'sc=used&offset=30', 'sc=used&start=30', 'sc=used&rpp=90', 'sc=used&limit=90']) {
  try {
    const payload = await call(query);
    const results = payload.results || [];
    console.log('  ' + query.padEnd(20) + ' -> ' + results.length + ' vehicles, first=' + (results[0] ? results[0].stock_number : 'none') +
      (results[0] && results[0].stock_number !== firstStock ? '  <-- DIFFERENT PAGE' : ''));
  } catch (error) {
    console.log('  ' + query.padEnd(20) + ' -> failed: ' + error.message);
  }
}
