#!/usr/bin/env node
// Reports what the inventory page actually serves, so the reader can be pointed
// at the right thing when a scrape comes back empty.
//   node tools/diagnose.mjs [url]

import { fetchHtml } from './lib/fetcher.mjs';
import { scriptBlocks, stripTags, anchors } from './lib/html.mjs';
import { extractVehicles } from './lib/extract.mjs';
import { loadConfig } from './scrape.mjs';

const MARKERS = [
  '__NEXT_DATA__', '__NUXT__', '__INITIAL_STATE__', '__APOLLO_STATE__', 'dataLayer',
  'application/ld+json', 'Vehicle', 'stockNumber', 'vin', 'inventory',
  'Just a moment', 'cf-chl', 'captcha', 'Cloudflare', 'enable JavaScript',
  'edealer', 'dealer.com', 'dealerinspire', 'dealeron', 'convermax', 'algolia'
];

const line = (label, value) => console.log(String(label).padEnd(26) + ': ' + value);

const url = process.argv[2] || loadConfig().listingUrl;
console.log('=== Inventory page diagnosis ===');
line('URL', url);

const { html, finalUrl } = await fetchHtml(url, { timeoutMs: 30000 });
line('Final URL', finalUrl);
line('HTML bytes', html.length);

const title = (/<title[^>]*>([\s\S]*?)<\/title>/i.exec(html) || [])[1];
line('Title', title ? stripTags(title) : '(none)');

const text = stripTags(html);
line('Visible text length', text.length);

const generator = /<meta[^>]+name=["']generator["'][^>]*content=["']([^"']+)/i.exec(html);
line('Meta generator', generator ? generator[1] : '(none)');

const ld = scriptBlocks(html, (type) => type.includes('ld+json'));
line('JSON-LD blocks', ld.length);
ld.slice(0, 12).forEach((block, index) => {
  let types = '(unparseable)';
  try {
    const parsed = JSON.parse(block.trim());
    const walk = (node, out = new Set()) => {
      if (Array.isArray(node)) node.forEach((item) => walk(item, out));
      else if (node && typeof node === 'object') {
        if (node['@type']) out.add(String(node['@type']));
        Object.values(node).forEach((value) => walk(value, out));
      }
      return out;
    };
    types = [...walk(parsed)].join(', ') || '(no @type)';
  } catch { /* leave the marker */ }
  console.log(`  ld[${index}] (${block.length} bytes): ${types}`);
});

console.log('\n-- markers present --');
MARKERS.forEach((marker) => {
  const count = html.split(marker).length - 1;
  if (count) line('  ' + marker, count + 'x');
});

const links = anchors(html, finalUrl);
line('\nAnchors', links.length);
const vehicleish = [...new Set(links.map((l) => l.href).filter((h) => /\/(vehicles?|inventory|vehicle-details)\//i.test(h)))];
line('Vehicle-looking links', vehicleish.length);
vehicleish.slice(0, 15).forEach((href) => console.log('  ' + href));

const srcs = [...html.matchAll(/<script[^>]+src=["']([^"']+)["']/gi)].map((m) => m[1]);
line('\nScript files', srcs.length);
[...new Set(srcs)].slice(0, 25).forEach((src) => console.log('  ' + src));

const apiish = [...new Set([...html.matchAll(/["'](\/[a-z0-9_\-/.]*(?:api|search|inventory|vehicles)[a-z0-9_\-/.]*)["']/gi)].map((m) => m[1]))];
line('\nAPI-looking paths', apiish.length);
apiish.slice(0, 30).forEach((path) => console.log('  ' + path));

const result = extractVehicles(html, finalUrl);
console.log('\n-- what the reader found --');
result.strategies.forEach((strategy) => line('  ' + strategy.name, strategy.count + (strategy.error ? ' (' + strategy.error + ')' : '')));
line('  merged total', result.vehicles.length);
result.vehicles.slice(0, 5).forEach((vehicle) => console.log('  ' + JSON.stringify(vehicle)));

console.log('\n-- first 1500 characters of visible text --');
console.log(text.slice(0, 1500));

console.log('\n-- first 2500 characters of raw HTML --');
console.log(html.slice(0, 2500));
