// Reads the inventory straight from the system the website's own vehicle grid
// uses, instead of parsing a page that never contains the vehicles.
//
// The grid (WordPress + Convertus, Vue-rendered) calls a proxy on the dealership
// domain, which forwards to the inventory API:
//
//   GET /wp-content/plugins/convertus-vms/include/php/ajax-vehicles.php
//       ?endpoint=<url-encoded API query>&action=vms_data
//
// The API answers 30 vehicles at a time and ignores every paging parameter, but
// it reports the true total and a set of facet counts (make, body style, year,
// colour...). So we ask for the whole lot, and wherever the answer is truncated
// we split that request along a facet and merge - checking the result against
// the API's own total so a missed vehicle cannot pass silently.

import { fetchHtml, sleep, BROWSER_HEADERS } from './fetcher.mjs';
import { vehicleKey } from './vehicles.mjs';

const REQUIRED = ['vmsApiUrl', 'inventoryId', 'pluginsUrl'];
// What the page tells us, and all the API needs. Remembered between runs so a
// refused page does not stop the inventory being read.
export const REMEMBERED_FIELDS = ['vmsApiUrl', 'inventoryId', 'pluginsUrl', 'language',
  'useSearchModel', 'hideZeroPriceVehicles', 'inventoryTags', 'inventoryTagsMethod', 'inventoryTagsSaleClass'];

export function rememberable(gv) {
  const kept = {};
  for (const field of REMEMBERED_FIELDS) {
    if (gv[field] !== undefined && gv[field] !== null) kept[field] = gv[field];
  }
  return kept;
}
const FACET_ORDER = ['mk', 'bs', 'yr', 'ec', 'tm'];
const PROXY_PATH = '/convertus-vms/include/php/ajax-vehicles.php';

/** The page publishes its own configuration in a globalVars object. */
export function readGlobalVars(html) {
  const match = /globalVars\s*=\s*\{/.exec(html);
  if (!match) return null;
  const start = html.indexOf('{', match.index);
  let depth = 0;
  for (let i = start; i < html.length; i += 1) {
    if (html[i] === '{') depth += 1;
    else if (html[i] === '}') {
      depth -= 1;
      if (depth === 0) {
        try {
          const parsed = JSON.parse(html.slice(start, i + 1));
          return REQUIRED.every((key) => parsed[key]) ? parsed : null;
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

// Matches the encoding the site's own bundle uses when it builds the query.
const encodeValue = (value) => encodeURIComponent(String(value)).replace(/%25/g, '%');

function buildApiQuery(gv, filters) {
  let endpoint = `${gv.vmsApiUrl}filtering/?cp=${gv.inventoryId}`;
  endpoint += gv.useSearchModel ? '&sf=true' : '';
  endpoint += `&ln=${gv.language || 'en'}&`;
  endpoint += Object.entries(filters).map(([key, value]) => `${encodeURIComponent(key)}=${encodeValue(value)}`).join('&');
  if (String(gv.hideZeroPriceVehicles) === 'true') endpoint += '&hzpv=true';
  if (gv.inventoryTags && !('tg' in filters)) {
    endpoint += `&tg=${gv.inventoryTags}&tgm=${gv.inventoryTagsMethod}&tgsc=${gv.inventoryTagsSaleClass}`;
  }
  return endpoint;
}

export function proxyUrl(gv, filters) {
  return `${gv.pluginsUrl}${PROXY_PATH}?endpoint=${encodeURIComponent(buildApiQuery(gv, filters))}&action=vms_data`;
}

function apiHeaders(listingUrl) {
  return {
    ...BROWSER_HEADERS,
    Accept: 'application/json, text/plain, */*',
    Referer: listingUrl,
    'X-Requested-With': 'XMLHttpRequest',
    'Sec-Fetch-Dest': 'empty',
    'Sec-Fetch-Mode': 'cors',
    'Sec-Fetch-Site': 'same-origin'
  };
}

function parsePayload(body) {
  let payload;
  try {
    payload = JSON.parse(body);
  } catch {
    throw new Error('Inventory request did not return JSON');
  }
  if (payload && payload.success === false) throw new Error(payload.msg || 'Inventory request refused');
  return payload;
}

/**
 * Asks the way the website's own grid asks - through the proxy on the
 * dealership domain - and, if that is refused, asks the inventory system
 * itself. The two are the same data; only the doorway differs, which matters
 * when the dealership domain is the thing refusing.
 */
async function request(gv, filters, context) {
  const { listingUrl, timeoutMs } = context;
  const endpoint = buildApiQuery(gv, filters);
  const doors = [];
  if (gv.pluginsUrl) {
    doors.push({ name: 'proxy', url: `${gv.pluginsUrl}${PROXY_PATH}?endpoint=${encodeURIComponent(endpoint)}&action=vms_data` });
  }
  doors.push({ name: 'direct', url: endpoint });
  if (context.preferred === 'direct') doors.reverse();

  let lastError;
  for (const door of doors) {
    try {
      const { html } = await fetchHtml(door.url, { timeoutMs, retries: 2, headers: apiHeaders(listingUrl) });
      const payload = parsePayload(html);
      if (context.preferred !== door.name) {
        context.preferred = door.name;
        if (door.name === 'direct') context.log('  the dealership domain refused; reading the inventory system directly');
      }
      return payload;
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError;
}

// Real records carry these where a trim is unknown; they must not reach a label.
const PLACEHOLDER_TRIM = /^(other\s*\/\s*don'?t\s*know|other|unspecified|unknown|not specified|n\/?a|none|-)$/i;

/** Drops junk trims, and trims the model name already says ("Beetle Dune" + "Dune"). */
function cleanTrim(value, model) {
  const trim = String(value || '').trim();
  if (!trim || PLACEHOLDER_TRIM.test(trim)) return '';
  const lowerModel = String(model || '').trim().toLowerCase();
  const lowerTrim = trim.toLowerCase();
  if (lowerModel === lowerTrim || lowerModel.endsWith(' ' + lowerTrim)) return '';
  return trim;
}

/** One API record -> the five fields a label needs, plus the extras worth showing. */
export function toVehicle(record) {
  const year = record.year ? String(record.year) : '';
  const make = (record.make || '').trim();
  const model = (record.model || '').trim();
  // search_trim is the short form ("LX"); trim often repeats the body style ("Sedan LX").
  const trim = cleanTrim(record.search_trim, model) || cleanTrim(record.trim, model);
  const vehicle = {
    year,
    make,
    model,
    trim,
    stock: (record.stock_number || '').trim(),
    vin: (record.vin || '').trim().toUpperCase(),
    url: record.vdp_url || '',
    price: String(record.internet_price || record.asking_price || record.final_price || '') || '',
    odometer: record.odometer ? String(record.odometer) : '',
    image: record.image || '',
    condition: (record.sale_class || '').toLowerCase(),
    certified: Boolean(record.certified),
    daysOnLot: Number.isFinite(record.days_on_lot) ? record.days_on_lot : null,
    inTransit: Boolean(record.in_transit),
    onOrder: Boolean(record.on_order),
    title: [year, make, model].filter(Boolean).join(' ')
  };
  vehicle.key = vehicleKey(vehicle);
  return vehicle;
}

/**
 * Collects the whole filtered set, splitting along facets wherever the API
 * truncates its answer. Returns what was gathered plus the total it claims.
 */
export async function fetchInventory(listingUrl, options = {}) {
  const { log = () => {}, delayMs = 250, timeoutMs = 30000, maxRequests = 80, remembered = null } = options;

  let gv = null;
  let filtersFrom = listingUrl;
  let settingsFrom = 'page';

  try {
    const { html, finalUrl } = await fetchHtml(listingUrl, { timeoutMs });
    gv = readGlobalVars(html);
    if (gv) filtersFrom = finalUrl;
    else log('  the page carries no inventory settings');
  } catch (error) {
    log(`  the page could not be read (${error.message})`);
  }

  if (!gv && remembered && remembered.vmsApiUrl && remembered.inventoryId) {
    gv = { ...remembered };
    settingsFrom = 'remembered';
    log('  using the inventory settings remembered from the last successful read');
  }
  if (!gv) throw new Error('No inventory settings available - the page was refused and none are remembered');

  const baseFilters = {};
  for (const [key, value] of new URL(filtersFrom).searchParams) {
    if (key !== 'view') baseFilters[key] = value;
  }

  const collected = new Map();
  const context = { listingUrl, timeoutMs, log, preferred: null };
  let requests = 0;
  let claimedTotal = null;

  async function gather(filters, facetIndex, label) {
    if (requests >= maxRequests) return;
    if (requests > 0) await sleep(delayMs);
    requests += 1;

    const payload = await request(gv, filters, context);
    const results = Array.isArray(payload.results) ? payload.results : [];
    const total = payload.summary && Number.isFinite(payload.summary.total_vehicles)
      ? payload.summary.total_vehicles
      : results.length;
    if (claimedTotal === null) claimedTotal = total;

    for (const record of results) {
      const vehicle = toVehicle(record);
      if (vehicle.key) collected.set(vehicle.key, vehicle);
    }
    log(`  ${label}: ${results.length} of ${total}`);

    if (results.length >= total) return; // this slice came back whole

    // Truncated: split along the first facet that offers more than one value.
    for (let index = facetIndex; index < FACET_ORDER.length; index += 1) {
      const facet = FACET_ORDER[index];
      const values = (payload.summary && payload.summary[facet]) || [];
      if (!Array.isArray(values) || values.length < 2) continue;
      for (const entry of values) {
        const value = entry && entry.name !== undefined ? entry.name : entry;
        if (value === '' || value === undefined || value === null) continue;
        await gather({ ...filters, [facet]: value }, index + 1, `${label} ${facet}=${value}`);
      }
      return;
    }
    log(`  ${label}: no facet left to split on - ${collected.size} gathered`);
  }

  await gather(baseFilters, 0, 'all');

  const vehicles = [...collected.values()];
  return {
    vehicles,
    claimedTotal,
    requests,
    complete: claimedTotal === null || vehicles.length >= claimedTotal,
    apiUrl: proxyUrl(gv, baseFilters),
    dealer: gv.dealerGeneralName || '',
    settingsFrom,
    settings: settingsFrom === 'page' ? rememberable(gv) : null
  };
}
