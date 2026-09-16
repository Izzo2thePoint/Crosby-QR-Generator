#!/usr/bin/env node
// The grid's page logic lives in webpack chunks, not the main bundle. Find where
// it calls ajaxVehicles and what it passes to reach vehicles 31-40.
import { fetchHtml } from './lib/fetcher.mjs';
import { loadConfig } from './scrape.mjs';

const listingUrl = process.argv[2] || loadConfig().listingUrl;
const origin = new URL(listingUrl).origin;
const { html } = await fetchHtml(listingUrl, { timeoutMs: 30000 });

const gvStart = html.indexOf('{', /globalVars\s*=\s*\{/.exec(html).index);
let depth = 0;
let gvEnd = gvStart;
for (let i = gvStart; i < html.length; i += 1) {
  if (html[i] === '{') depth += 1;
  else if (html[i] === '}') { depth -= 1; if (depth === 0) { gvEnd = i + 1; break; } }
}
const gv = JSON.parse(html.slice(gvStart, gvEnd));

const bundleUrl = gv.pluginsUrl + '/convertus-vms/include/srp/convertus-v4/main.convertus.min.js';
const { html: bundle } = await fetchHtml(bundleUrl, { timeoutMs: 30000 });

const chunkMap = /webpack-chunks\/"\+(\{[^}]+\})/.exec(bundle);
const hashes = chunkMap ? [...chunkMap[1].matchAll(/"([a-f0-9]{16,})"/g)].map((m) => m[1]) : [];
console.log('chunk hashes: ' + hashes.join(', '));

for (const hash of hashes) {
  const url = `${origin}/wp-content/cache/webpack-chunks/${hash}.chunk.js`;
  let code = '';
  try {
    ({ html: code } = await fetchHtml(url, { timeoutMs: 30000, retries: 1 }));
  } catch (error) {
    console.log(`\n${hash}: could not fetch (${error.message})`);
    continue;
  }
  const calls = [...code.matchAll(/ajaxVehicles\s*\(/g)];
  console.log(`\n=== chunk ${hash} (${code.length} bytes, ${calls.length} ajaxVehicles call(s)) ===`);
  calls.slice(0, 4).forEach((match) => {
    console.log('  >>> ' + code.slice(Math.max(0, match.index - 700), match.index + 300).replace(/\s+/g, ' '));
    console.log('');
  });
  if (calls.length) {
    const twoLetter = [...new Set([...code.matchAll(/["'`]([a-z]{1,3})["'`]\s*:/g)].map((m) => m[1]))];
    console.log('  short keys used in this chunk: ' + twoLetter.join(', '));
    for (const term of ['pageSize', 'perPage', 'currentPage', 'itemsPer', 'loadMore', 'paginat', 'infinite']) {
      const hit = code.indexOf(term);
      if (hit !== -1) console.log(`  "${term}": ...` + code.slice(Math.max(0, hit - 220), hit + 220).replace(/\s+/g, ' ') + '...');
    }
  }
}
