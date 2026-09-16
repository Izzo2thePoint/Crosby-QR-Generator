#!/usr/bin/env node
// Sweep candidate paging parameters against the filtering endpoint and report
// only the ones that actually change the result. 40 vehicles, 30 per response.
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

const filtering = (query) => `${gv.vmsApiUrl}filtering/?cp=${gv.inventoryId}&ln=en&${query}${tags}`;

const base = await call(filtering('sc=used'));
const baseStocks = (base.results || []).map((v) => v.stock_number);
console.log('baseline: ' + baseStocks.length + ' of ' + (base.summary || {}).total_vehicles + ' vehicles, first=' + baseStocks[0]);

// Does the inventory/ variant hand over everything at once?
console.log('\n=== inventory/ endpoint ===');
const inv = await call(`${gv.vmsApiUrl}inventory/${gv.inventoryId}/?ln=en&sc=used`);
const invList = inv.results || inv.vehicles || (Array.isArray(inv) ? inv : null);
console.log('  ' + (invList ? invList.length + ' vehicles' : JSON.stringify(inv).slice(0, 220)));

console.log('\n=== paging parameter sweep (only differences shown) ===');
const pageNames = ['pg', 'pn', 'pp', 'ps', 'pi', 'pc', 'pgn', 'pge', 'sp', 'st', 'sk', 'of', 'os', 'ix',
  'nr', 'np', 'rp', 'rs', 'li', 'lm', 'mx', 'ct', 'cn', 'vp', 'pa2', 'page_number', 'pageNum', 'pageIndex'];
const sizeNames = ['ipp', 'rpp', 'vpp', 'ps', 'sz', 'nb', 'qt', 'mr', 'max_results', 'results_per_page', 'per_page', 'pageSize'];

let found = [];
for (const name of pageNames) {
  const payload = await call(filtering(`sc=used&${name}=2`));
  const stocks = (payload.results || []).map((v) => v.stock_number);
  if (stocks.length && stocks[0] !== baseStocks[0]) {
    console.log(`  PAGE PARAM: ${name}=2 -> ${stocks.length} vehicles, first=${stocks[0]}`);
    found.push(name);
  }
  await sleep(120);
}
for (const name of sizeNames) {
  const payload = await call(filtering(`sc=used&${name}=100`));
  const stocks = (payload.results || []).map((v) => v.stock_number);
  if (stocks.length > baseStocks.length) {
    console.log(`  SIZE PARAM: ${name}=100 -> ${stocks.length} vehicles`);
    found.push(name);
  }
  await sleep(120);
}
if (!found.length) console.log('  none of the candidates changed the response');

// Slicing by year is the fallback: the summary block tells us which years exist.
console.log('\n=== year slices (fallback route to the whole lot) ===');
const years = (base.filters && base.filters.yr) || [];
console.log('  years offered: ' + JSON.stringify(years).slice(0, 300));
const seen = new Set(baseStocks);
for (const entry of (Array.isArray(years) ? years : []).slice(0, 12)) {
  const year = entry.name || entry.value || entry;
  const payload = await call(filtering(`sc=used&yr=${encodeURIComponent(year)}`));
  const stocks = (payload.results || []).map((v) => v.stock_number);
  const fresh = stocks.filter((stock) => !seen.has(stock));
  fresh.forEach((stock) => seen.add(stock));
  console.log(`  yr=${year}: ${stocks.length} vehicles, ${fresh.length} not in page 1`);
  await sleep(120);
}
console.log('  total distinct stock numbers gathered: ' + seen.size + ' of ' + (base.summary || {}).total_vehicles);
