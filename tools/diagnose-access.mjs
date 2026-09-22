#!/usr/bin/env node
// The site started answering 403. This tries the routes to the same inventory
// and reports which still work, so the reader can be pointed at one that does.

import { loadConfig } from './scrape.mjs';

const listingUrl = process.argv[2] || loadConfig().listingUrl;
const origin = new URL(listingUrl).origin;

// Settings previously read from the page, kept here so the API can be reached
// even when the page itself is refused.
const KNOWN = { vmsApiUrl: 'https://vms.prod.convertus.rocks/api/', inventoryId: '4211', tags: '&hzpv=true&tg=InventoryTagDemo&tgm=excl&tgsc=new' };

const CHROME = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36';

const browserHeaders = {
  'User-Agent': CHROME,
  Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
  'Accept-Language': 'en-CA,en;q=0.9',
  'Accept-Encoding': 'gzip, deflate, br',
  'Upgrade-Insecure-Requests': '1',
  'sec-ch-ua': '"Chromium";v="140", "Not=A?Brand";v="24", "Google Chrome";v="140"',
  'sec-ch-ua-mobile': '?0',
  'sec-ch-ua-platform': '"Windows"',
  'Sec-Fetch-Dest': 'document',
  'Sec-Fetch-Mode': 'navigate',
  'Sec-Fetch-Site': 'none',
  'Sec-Fetch-User': '?1',
  'Cache-Control': 'max-age=0'
};

async function attempt(label, url, headers) {
  const started = Date.now();
  try {
    const response = await fetch(url, { headers, redirect: 'follow', signal: AbortSignal.timeout(25000) });
    const body = await response.text();
    let note = `${body.length} bytes`;
    try {
      const parsed = JSON.parse(body);
      const list = parsed.results || parsed.vehicles || (Array.isArray(parsed) ? parsed : null);
      if (Array.isArray(list)) note = `${list.length} vehicles, total ${parsed.summary ? parsed.summary.total_vehicles : '?'}`;
      else if (parsed.success === false) note = 'refused: ' + parsed.msg;
    } catch {
      if (/just a moment|cf-chl|challenge-platform|attention required/i.test(body)) note += ' (bot challenge page)';
      else if (/globalVars/.test(body)) note += ' (page config present)';
    }
    console.log(`  ${String(response.status).padEnd(4)} ${label.padEnd(42)} ${note}  [${Date.now() - started}ms]`);
    return response.status === 200;
  } catch (error) {
    console.log(`  ---  ${label.padEnd(42)} failed: ${error.message}`);
    return false;
  }
}

console.log('=== can we still reach the dealership site? ===');
await attempt('listing page, headers we use now', listingUrl, {
  'User-Agent': CHROME + ' CrosbyLabelStudio/1.0',
  Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'en-CA,en;q=0.9'
});
await attempt('listing page, plain browser headers', listingUrl, browserHeaders);
await attempt('site root, plain browser headers', origin + '/', browserHeaders);
await attempt('listing page, no headers at all', listingUrl, {});

console.log('\n=== the proxy on the dealership domain ===');
const proxyEndpoint = `${KNOWN.vmsApiUrl}filtering/?cp=${KNOWN.inventoryId}&ln=en&sc=used${KNOWN.tags}`;
await attempt('ajax-vehicles.php proxy', `${origin}/wp-content/plugins/convertus-vms/include/php/ajax-vehicles.php?endpoint=${encodeURIComponent(proxyEndpoint)}&action=vms_data`, {
  ...browserHeaders, Accept: 'application/json, text/plain, */*', Referer: listingUrl, 'X-Requested-With': 'XMLHttpRequest',
  'Sec-Fetch-Dest': 'empty', 'Sec-Fetch-Mode': 'cors', 'Sec-Fetch-Site': 'same-origin'
});

console.log('\n=== the inventory system directly, no dealership domain involved ===');
await attempt('vms api, browser headers', proxyEndpoint, { ...browserHeaders, Accept: 'application/json, text/plain, */*', Referer: origin + '/', Origin: origin, 'Sec-Fetch-Dest': 'empty', 'Sec-Fetch-Mode': 'cors', 'Sec-Fetch-Site': 'cross-site' });
await attempt('vms api, no referer', proxyEndpoint, { 'User-Agent': CHROME, Accept: 'application/json' });
await attempt('vms api, all filters as configured', `${KNOWN.vmsApiUrl}filtering/?cp=${KNOWN.inventoryId}&ln=en&${new URL(listingUrl).search.replace(/^\?/, '').replace('&view=grid', '')}${KNOWN.tags}`, { 'User-Agent': CHROME, Accept: 'application/json' });
