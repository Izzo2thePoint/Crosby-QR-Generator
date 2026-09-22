#!/usr/bin/env node
// Pulls the used-inventory listing, works out which vehicles are new, and
// writes data/inventory.json for the label page to render.
//
//   node tools/scrape.mjs                 normal run
//   node tools/scrape.mjs --dump          also save raw HTML to data/debug/
//   node tools/scrape.mjs --baseline      treat everything found as already handled
//   node tools/scrape.mjs --url="..."     scrape a different listing URL once

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { fetchHtml, sleep } from './lib/fetcher.mjs';
import { extractVehicles, extractFromEmbeddedJson, extractFromJsonLd, findMaxPage } from './lib/extract.mjs';
import { mergeVehicle, isPrintable, vehicleKey } from './lib/vehicles.mjs';
import { loadState, reconcile, saveState } from './lib/state.mjs';
import { fetchInventory } from './lib/convertus.mjs';
import { stripTags } from './lib/html.mjs';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// CROSBY_DATA_DIR lets the self-test run against a scratch folder instead of
// the real print history.
const DATA_DIR = process.env.CROSBY_DATA_DIR
  ? path.resolve(process.env.CROSBY_DATA_DIR)
  : path.join(ROOT, 'data');
export const PATHS = {
  config: process.env.CROSBY_CONFIG ? path.resolve(process.env.CROSBY_CONFIG) : path.join(ROOT, 'config.json'),
  data: DATA_DIR,
  inventory: path.join(DATA_DIR, 'inventory.json'),
  state: path.join(DATA_DIR, 'state.json'),
  vdpCache: path.join(DATA_DIR, 'vdp-cache.json'),
  siteConfig: path.join(DATA_DIR, 'site-config.json'),
  debug: path.join(DATA_DIR, 'debug')
};

const DEFAULT_CONFIG = {
  dealerName: 'Crosby Volkswagen',
  listingUrl: 'https://www.crosbyvw.com/vehicles/?sc=used&in_transit=true&in_stock=true&on_order=true&view=grid',
  maxPages: 25,
  requestDelayMs: 700,
  requestTimeoutMs: 25000,
  enrichFromVdp: true,
  maxVdpFetches: 60,
  port: 4321,
  openBrowser: true,
  qrTracking: { utm_source: 'window_sticker', utm_medium: 'qr', utm_campaign: 'used_inventory' }
};

export function loadConfig() {
  try {
    return { ...DEFAULT_CONFIG, ...JSON.parse(fs.readFileSync(PATHS.config, 'utf8')) };
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}

function pageUrl(listingUrl, page) {
  const url = new URL(listingUrl);
  if (page > 1) url.searchParams.set('page', String(page));
  else url.searchParams.delete('page');
  return url.toString();
}

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2));
}

function saveDebug(name, html) {
  fs.mkdirSync(PATHS.debug, { recursive: true });
  const file = path.join(PATHS.debug, name);
  fs.writeFileSync(file, html);
  return file;
}

/** VDP pages carry the full record even when the listing grid is JS-rendered. */
async function enrichFromVdp(vehicle, config, cache, log) {
  const cached = cache[vehicle.url];
  if (cached && cached.vehicle) return mergeVehicle(vehicle, cached.vehicle);

  let html;
  try {
    ({ html } = await fetchHtml(vehicle.url, { timeoutMs: config.requestTimeoutMs, retries: 1 }));
  } catch (error) {
    log(`  ! could not open ${vehicle.url}: ${error.message}`);
    return vehicle;
  }

  const candidates = [...extractFromJsonLd(html, vehicle.url), ...extractFromEmbeddedJson(html, vehicle.url)];
  const sameUrl = candidates.find((candidate) => candidate.url && candidate.url.split('?')[0] === vehicle.url.split('?')[0]);
  let detail = sameUrl || candidates[0] || {};

  const text = stripTags(html);
  if (!detail.stock) {
    const stockMatch = /stock\s*(?:#|number|no\.?)?\s*[:#]?\s*([A-Z0-9][A-Z0-9-]{2,11})\b/i.exec(text);
    if (stockMatch) detail = { ...detail, stock: stockMatch[1].toUpperCase() };
  }
  if (!detail.vin) {
    const vinMatch = /\bvin\s*[:#]?\s*([A-HJ-NPR-Z0-9]{17})\b/i.exec(text) || /\b([A-HJ-NPR-Z0-9]{17})\b/.exec(text);
    if (vinMatch) detail = { ...detail, vin: vinMatch[1].toUpperCase() };
  }
  if (!detail.title) {
    const titleMatch = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
    if (titleMatch) detail = { ...detail, title: stripTags(titleMatch[1]).split('|')[0].trim() };
  }

  const enriched = mergeVehicle(vehicle, { ...detail, url: vehicle.url });
  cache[vehicle.url] = { fetchedAt: new Date().toISOString(), vehicle: enriched };
  return enriched;
}

export async function runScrape(options = {}) {
  const config = { ...loadConfig(), ...(options.config || {}) };
  const log = options.log || ((message) => console.log(message));
  const listingUrl = options.url || config.listingUrl;
  const dump = Boolean(options.dump);

  const collected = new Map();
  const strategyTally = new Map();
  const pagesFetched = [];
  let firstPageHtml = '';
  let maxPages = Math.max(1, Number(config.maxPages) || 1);
  let source = 'page';
  let apiTotal = null;
  let apiUrl = '';
  let apiWarning = null;

  // Preferred route: ask the system the website's own vehicle grid asks. The
  // listing page itself is rendered in the browser and carries no vehicles.
  if (config.useInventoryApi !== false) {
    try {
      log('Reading the inventory the website\'s vehicle grid uses...');
      const api = await fetchInventory(listingUrl, {
        log,
        delayMs: config.requestDelayMs,
        timeoutMs: config.requestTimeoutMs,
        remembered: readJson(PATHS.siteConfig, null) || config.inventorySystem || null
      });
      // Keep the settings for next time: the site sometimes refuses the page,
      // and these are all the inventory system needs.
      if (api.settings) writeJson(PATHS.siteConfig, { savedAt: new Date().toISOString(), ...api.settings });
      if (api.vehicles.length) {
        source = 'inventory-api';
        apiTotal = api.claimedTotal;
        apiUrl = api.apiUrl;
        for (const vehicle of api.vehicles) collected.set(vehicle.key, vehicle);
        log(`Read ${api.vehicles.length} vehicle(s) in ${api.requests} request(s)` +
          (api.settingsFrom === 'remembered' ? ' using remembered settings' : ''));
        if (!api.complete) {
          apiWarning = `Only ${api.vehicles.length} of the ${api.claimedTotal} vehicles the site reports could be collected`;
          log(`  ! ${apiWarning}`);
        }
      } else {
        log('  the inventory system returned nothing; reading the page instead');
      }
    } catch (error) {
      log(`  inventory system unavailable (${error.message}); reading the page instead`);
    }
  }

  for (let page = 1; source === 'page' && page <= maxPages; page += 1) {
    const url = pageUrl(listingUrl, page);
    log(`Fetching page ${page}: ${url}`);
    const { html, finalUrl } = await fetchHtml(url, { timeoutMs: config.requestTimeoutMs });
    pagesFetched.push(url);
    if (page === 1) firstPageHtml = html;
    if (dump) saveDebug(`listing-page-${page}.html`, html);

    if (page === 1) {
      const linked = findMaxPage(html, finalUrl);
      maxPages = Math.min(maxPages, Math.max(1, linked));
      if (linked > 1) log(`  site links ${linked} page(s) of results`);
    }

    const { vehicles, strategies } = extractVehicles(html, finalUrl);
    for (const strategy of strategies) {
      strategyTally.set(strategy.name, (strategyTally.get(strategy.name) || 0) + strategy.count);
    }

    let fresh = 0;
    for (const vehicle of vehicles) {
      const key = vehicle.key || vehicleKey(vehicle);
      if (!key) continue;
      if (collected.has(key)) {
        collected.set(key, mergeVehicle(collected.get(key), vehicle));
        continue;
      }
      collected.set(key, { ...vehicle, key });
      fresh += 1;
    }
    log(`  found ${vehicles.length} vehicle record(s), ${fresh} not seen on earlier pages`);

    if (fresh === 0 && page > 1) break; // pagination exhausted (or the site ignores ?page=)
    if (page < maxPages) await sleep(config.requestDelayMs);
  }

  let vehicles = [...collected.values()];

  if (source === 'page' && config.enrichFromVdp && vehicles.length) {
    const cache = readJson(PATHS.vdpCache, {});
    const needsDetail = vehicles.filter((vehicle) => vehicle.url && !isPrintable(vehicle));
    const budget = needsDetail.slice(0, Math.max(0, Number(config.maxVdpFetches) || 0));
    if (budget.length) log(`Opening ${budget.length} vehicle page(s) to fill in missing stock #/details...`);
    for (let i = 0; i < budget.length; i += 1) {
      const enriched = await enrichFromVdp(budget[i], config, cache, log);
      collected.set(enriched.key || budget[i].key, enriched);
      if (i < budget.length - 1) await sleep(config.requestDelayMs);
    }
    writeJson(PATHS.vdpCache, cache);
    vehicles = [...collected.values()];
  }

  // Deduplicate once more: VDP enrichment can reveal that two URLs are one car.
  const byKey = new Map();
  for (const vehicle of vehicles) {
    const key = vehicleKey(vehicle) || vehicle.key;
    if (!key) continue;
    byKey.set(key, byKey.has(key) ? mergeVehicle(byKey.get(key), vehicle) : { ...vehicle, key });
  }
  vehicles = [...byKey.values()].sort((a, b) => (b.year || '').localeCompare(a.year || '') || a.title.localeCompare(b.title));

  const printable = vehicles.filter(isPrintable);
  const state = loadState(PATHS.state);
  const result = reconcile(state, printable, { baseline: options.baseline });
  saveState(PATHS.state, result.state);

  // Stamp each vehicle with when it was first seen and whether it predates the
  // tool. The published page reads this file on its own, with no server behind it.
  const decorated = printable.map((vehicle) => {
    const record = result.state.vehicles[vehicle.key] || {};
    return {
      ...vehicle,
      firstSeen: record.firstSeen || null,
      origin: record.status === 'baseline' ? 'baseline' : 'new'
    };
  });

  const inventory = {
    fetchedAt: new Date().toISOString(),
    listingUrl,
    pagesFetched,
    source,
    apiUrl,
    apiTotal,
    apiWarning,
    strategies: Object.fromEntries(strategyTally),
    config: {
      dealerName: config.dealerName,
      listingUrl,
      apiUrl,
      qrTracking: config.qrTracking || {}
    },
    counts: {
      found: vehicles.length,
      printable: printable.length,
      incomplete: vehicles.length - printable.length,
      newThisRun: result.added.filter((record) => record.status === 'queued').length
    },
    vehicles: decorated,
    incomplete: vehicles.filter((vehicle) => !isPrintable(vehicle))
  };
  writeJson(PATHS.inventory, inventory);

  if (!vehicles.length && firstPageHtml) {
    const file = saveDebug('listing-page-1.html', firstPageHtml);
    log('');
    log('No vehicles could be read from the listing page.');
    log(`A copy of the page was saved to ${file} - send that file along if the parser needs tuning.`);
  }

  return { inventory, state: result.state, reconcile: result, config };
}

function parseArgs(argv) {
  const options = {};
  for (const arg of argv) {
    if (arg === '--dump') options.dump = true;
    else if (arg === '--baseline') options.baseline = true;
    else if (arg === '--json') options.json = true;
    else if (arg.startsWith('--url=')) options.url = arg.slice('--url='.length);
  }
  return options;
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  const options = parseArgs(process.argv.slice(2));
  runScrape(options)
    .then(({ inventory, reconcile: outcome }) => {
      if (options.json) {
        console.log(JSON.stringify(inventory.counts, null, 2));
        return;
      }
      console.log('');
      console.log(`Read via                 : ${inventory.source === 'inventory-api' ? 'the website\'s inventory system' : 'reading the listing page'}`);
      console.log(`Vehicles on the used lot : ${inventory.counts.printable}`);
      if (inventory.apiWarning) console.log(`! ${inventory.apiWarning}`);
      if (inventory.counts.incomplete) console.log(`Skipped (missing details): ${inventory.counts.incomplete}`);
      if (outcome.wasBaseline) {
        console.log('First run - everything found was recorded as "already on the lot". Nothing is queued to print.');
      } else {
        console.log(`New since last run       : ${inventory.counts.newThisRun}`);
      }
      console.log(`Written to ${path.relative(ROOT, PATHS.inventory)}`);
    })
    .catch((error) => {
      console.error(`\nScrape failed: ${error.message}`);
      process.exitCode = 1;
    });
}
