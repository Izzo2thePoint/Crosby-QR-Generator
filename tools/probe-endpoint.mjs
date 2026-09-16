#!/usr/bin/env node
// Builds the vehicles request exactly the way the SRP bundle does:
//   endpoint = vmsApiUrl + "filtering/?cp=<inventoryId>&ln=<lang>&" + filters
//   GET <pluginsUrl>/convertus-vms/include/php/ajax-vehicles.php?endpoint=<encoded>&action=vms_data

import { fetchHtml } from './lib/fetcher.mjs';
import { loadConfig } from './scrape.mjs';

const listingUrl = process.argv[2] || loadConfig().listingUrl;
const show = (label, value) => console.log(String(label).padEnd(22) + ': ' + value);

const { html } = await fetchHtml(listingUrl, { timeoutMs: 30000 });

function readGlobalVars(page) {
  const match = /globalVars\s*=\s*\{/.exec(page);
  if (!match) return null;
  const start = page.indexOf('{', match.index);
  let depth = 0;
  for (let i = start; i < page.length; i += 1) {
    if (page[i] === '{') depth += 1;
    else if (page[i] === '}') {
      depth -= 1;
      if (depth === 0) {
        try { return JSON.parse(page.slice(start, i + 1)); } catch { return null; }
      }
    }
  }
  return null;
}

const gv = readGlobalVars(html);
if (!gv) { console.log('Could not read globalVars'); process.exit(1); }

console.log('=== the settings the request needs ===');
for (const key of ['vmsApiUrl', 'inventoryId', 'language', 'useSearchModel', 'advancedPricing',
  'hideZeroPriceVehicles', 'inventoryTags', 'inventoryTagsMethod', 'inventoryTagsSaleClass',
  'pluginsUrl', 'siteUrl', 'srpThemeVersion']) {
  show('  ' + key, JSON.stringify(gv[key]));
}

function buildEndpoint(params) {
  let endpoint = gv.vmsApiUrl + 'filtering/?cp=' + gv.inventoryId;
  endpoint += gv.useSearchModel ? '&sf=true' : '';
  endpoint += '&ln=' + (gv.language || 'en') + '&';
  endpoint += Object.entries(params)
    .map(([key, value]) => encodeURIComponent(key) + '=' + encodeURIComponent(value).replace(/%25/g, '%'))
    .join('&');
  if (String(gv.hideZeroPriceVehicles) === 'true') endpoint += '&hzpv=true';
  if (gv.inventoryTags && !('tg' in params)) {
    endpoint += '&tg=' + gv.inventoryTags + '&tgm=' + gv.inventoryTagsMethod + '&tgsc=' + gv.inventoryTagsSaleClass;
  }
  return endpoint;
}

const proxy = gv.pluginsUrl + '/convertus-vms/include/php/ajax-vehicles.php';
const listingParams = Object.fromEntries(new URL(listingUrl).searchParams);
delete listingParams.view;

const attempts = [
  { label: 'listing filters as-is', params: listingParams },
  { label: 'used only', params: { sc: 'used' } },
  { label: 'used, page 1, 100 per page', params: { ...listingParams, pn: '1', ipp: '100' } }
];

for (const attempt of attempts) {
  const endpoint = buildEndpoint(attempt.params);
  console.log('\n-- ' + attempt.label + ' --');
  console.log('  endpoint: ' + endpoint);
  try {
    const response = await fetch(proxy + '?endpoint=' + encodeURIComponent(endpoint) + '&action=vms_data', {
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
    if (!parsed) { console.log('  body: ' + body.slice(0, 400).replace(/\s+/g, ' ')); continue; }
    show('  top level', Array.isArray(parsed) ? 'array(' + parsed.length + ')' : Object.keys(parsed).join(', '));

    const list = [parsed.vehicles, parsed.data, parsed.results, parsed.items, parsed.inventory,
      parsed.data && parsed.data.vehicles, Array.isArray(parsed) ? parsed : null].find(Array.isArray);
    if (list && list.length) {
      show('  vehicles returned', list.length);
      show('  record keys', Object.keys(list[0]).join(', '));
      console.log('  sample record: ' + JSON.stringify(list[0]).slice(0, 2000));
    } else {
      console.log('  payload: ' + JSON.stringify(parsed).slice(0, 1200));
    }
  } catch (error) {
    show('  failed', error.message);
  }
}
