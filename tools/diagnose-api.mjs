#!/usr/bin/env node
// The listing page turned out to be Vue-rendered (WordPress + Convertus), so the
// vehicles arrive from an API after load. This hunts for that endpoint.

import { fetchHtml } from './lib/fetcher.mjs';
import { loadConfig } from './scrape.mjs';

const config = loadConfig();
const listingUrl = process.argv[2] || config.listingUrl;
const origin = new URL(listingUrl).origin;

const show = (label, value) => console.log(String(label).padEnd(24) + ': ' + value);
const uniq = (values) => [...new Set(values)];

console.log('=== Hunting the inventory API ===');
const { html } = await fetchHtml(listingUrl, { timeoutMs: 30000 });

// 1. What sits around the word "vin" - real data, or a Vue template?
console.log('\n-- context around the first "vin" mentions --');
let count = 0;
for (const match of html.matchAll(/vin/gi)) {
  if (count >= 6) break;
  console.log('  ...' + html.slice(Math.max(0, match.index - 110), match.index + 110).replace(/\s+/g, ' ') + '...');
  count += 1;
}

// 2. Anything pushed into the GTM dataLayer (dealer sites often put the SRP list there).
console.log('\n-- dataLayer pushes --');
const pushes = [...html.matchAll(/dataLayer\s*(?:\.push\s*\(|=)\s*([\[{])/g)];
show('  push sites', pushes.length);
pushes.slice(0, 6).forEach((match, index) => {
  console.log(`  push[${index}]: ` + html.slice(match.index, match.index + 320).replace(/\s+/g, ' '));
});

// 3. Endpoint-looking strings in the page itself.
console.log('\n-- endpoint-looking strings in the page --');
const pagePaths = uniq([
  ...[...html.matchAll(/["'`](\/wp-json\/[^"'`\s]{2,90})["'`]/g)].map((m) => m[1]),
  ...[...html.matchAll(/["'`]([^"'`\s]*(?:admin-ajax|\/api\/|graphql|\/srp|inventory\.json|vehicles\.json)[^"'`\s]{0,80})["'`]/gi)].map((m) => m[1])
]);
pagePaths.slice(0, 40).forEach((path) => console.log('  ' + path));

// 4. The SRP bundle almost certainly names the endpoint it calls.
const bundles = uniq([...html.matchAll(/<script[^>]+src=["']([^"']*convertus[^"']*\.js[^"']*)["']/gi)].map((m) => m[1]))
  .map((src) => (src.startsWith('//') ? 'https:' + src : src.startsWith('http') ? src : origin + src))
  .filter((src) => /vms|srp|client|main/i.test(src));

for (const bundle of bundles.slice(0, 4)) {
  console.log(`\n-- endpoints inside ${bundle.split('/').slice(-3).join('/')} --`);
  let code = '';
  try {
    ({ html: code } = await fetchHtml(bundle, { timeoutMs: 30000, retries: 1 }));
  } catch (error) {
    console.log('  could not fetch: ' + error.message);
    continue;
  }
  show('  bytes', code.length);
  const found = uniq([
    ...[...code.matchAll(/["'`](https?:\/\/[^"'`\s]{10,120})["'`]/g)].map((m) => m[1]),
    ...[...code.matchAll(/["'`](\/[a-z0-9\-_/]*(?:wp-json|api|search|srp|vehicle|inventory)[a-z0-9\-_/.]*)["'`]/gi)].map((m) => m[1])
  ]).filter((url) => !/\.(png|jpg|svg|css|woff)/i.test(url));
  found.slice(0, 45).forEach((url) => console.log('  ' + url));
}

// 5. WordPress exposes its REST namespaces; the vehicle API is probably one of them.
console.log('\n-- WordPress REST namespaces --');
try {
  const { html: index } = await fetchHtml(origin + '/wp-json/', { timeoutMs: 25000, retries: 1 });
  const parsed = JSON.parse(index);
  show('  site', parsed.name || '(unnamed)');
  console.log('  namespaces: ' + (parsed.namespaces || []).join(', '));
  const routes = Object.keys(parsed.routes || {}).filter((route) => /vehicle|inventory|vms|srp|search/i.test(route));
  console.log('  vehicle-ish routes: ' + (routes.length ? routes.join(', ') : '(none at the root index)'));
} catch (error) {
  console.log('  could not read /wp-json/: ' + error.message);
}
