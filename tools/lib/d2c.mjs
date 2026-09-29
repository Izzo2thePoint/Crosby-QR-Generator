// Reads the used-inventory listing on the D2C Media platform, which the
// dealership site moved to at the end of September 2026.
//
// Unlike the old site, these pages are rendered on the server: each vehicle is a
// <li class="carBoxWrapper"> card holding everything a label needs - stock #,
// VIN, year/make/model, trim, kilometres, price and the vehicle page link.
//
// The catch is that the search page renders only the first page of results (36)
// and fetches the rest in the browser. Its per-brand pages (/used/Hyundai.html,
// /demos/Volkswagen.html...) render in full, and the search page publishes how
// many vehicles each brand has. So we read the search page, and wherever a brand
// comes up short we read that brand's page too - then check the total adds up,
// so a missed vehicle cannot pass silently.
//
// Parsing is kept free of Node APIs: the label page imports this in the browser
// for its paste-the-page-source fallback.

import { decodeEntities, stripTags } from './html.mjs';
import { vehicleKey } from './vehicles.mjs';

const CARD_START = /<li\b[^>]*\bclass\s*=\s*["'][^"']*\bcarBoxWrapper\b[^"']*["'][^>]*>/gi;

/** Is this a D2C Media vehicle listing? */
export function isD2cListing(html) {
  CARD_START.lastIndex = 0;
  return CARD_START.test(String(html || ''));
}

function attr(tag, name) {
  const match = new RegExp(`\\s${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, 'i').exec(tag || '');
  return match ? decodeEntities(match[1] !== undefined ? match[1] : match[2]).trim() : '';
}

/** Inner text of the first element whose class list includes `className`. */
function textOfClass(html, className) {
  const re = new RegExp(`<(\\w+)\\b[^>]*\\bclass\\s*=\\s*["'][^"']*\\b${className}\\b[^"']*["'][^>]*>([\\s\\S]*?)</\\1>`, 'i');
  const match = re.exec(html || '');
  return match ? stripTags(match[2]) : '';
}

function absolute(href, baseUrl) {
  if (!href) return '';
  try { return new URL(href, baseUrl).toString(); } catch { return href; }
}

// D2C title-cases every word of a trim ("Se Awd", "2.0t 6sp", "Comfortline 2.0 Tsi").
// Put the letters back the way they are written on a car.
const UPPERCASE_WORDS = new Set([
  'se', 'sel', 'sle', 'slt', 'sxt', 'sx', 'sv', 'sl', 'sr', 'sr5', 'le', 'xle', 'xse', 'lx', 'ex', 'ex-l',
  'dx', 'si', 'gl', 'gls', 'glx', 'gt', 'gti', 'gli', 'gtx', 'rs', 'st', 'ss', 'ls', 'lt', 'ltz', 'rst',
  'xl', 'xlt', 'srt', 'trd', 'z71', 'awd', 'fwd', 'rwd', '4wd', '2wd', '4x4', 'at', 'mt', 'cvt', 'dsg',
  'tsi', 'tdi', 'tfsi', 'hev', 'phev', 'ev', 'suv'
]);

export function formatTrim(value) {
  return String(value || '')
    .split(/\s+/)
    .filter(Boolean)
    .map((word) => {
      const lower = word.toLowerCase();
      if (UPPERCASE_WORDS.has(lower)) return word.toUpperCase();
      if (/^\d+(?:\.\d+)?[tl]$/i.test(word)) return word.slice(0, -1) + word.slice(-1).toUpperCase(); // 2.0t -> 2.0T
      if (/^v\d{1,2}$/i.test(word)) return word.toUpperCase();                                         // v6 -> V6
      if (lower === '4motion' || lower === '4matic') return word.toUpperCase();
      return word;
    })
    .join(' ');
}

const PLACEHOLDER_TRIM = /^(other\s*\/\s*don'?t\s*know|other|unspecified|unknown|not specified|n\/?a|none|-)$/i;

function cleanTrim(value, model) {
  const trim = formatTrim(value);
  if (!trim || PLACEHOLDER_TRIM.test(trim)) return '';
  const lowerModel = String(model || '').trim().toLowerCase();
  const lowerTrim = trim.toLowerCase();
  if (lowerModel === lowerTrim || lowerModel.endsWith(' ' + lowerTrim)) return '';
  return trim;
}

// Demo stock numbers carry a suffix ("JG4050-DEMO"). The sticker, and the print
// history, want the dealership's own number.
const DEMO_SUFFIX = /[-\s]*demo$/i;

function vehicleLd(card) {
  const re = /<script\b[^>]*application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi;
  let match;
  let fallback = null;
  while ((match = re.exec(card)) !== null) {
    let data;
    try { data = JSON.parse(match[1].trim()); } catch { continue; }
    const types = [].concat(data['@type'] || []);
    if (types.includes('Vehicle') || types.includes('Car')) return data;
    if (types.includes('Product')) fallback = data;
  }
  return fallback || {};
}

/** Every vehicle card on a D2C listing page, as label records. */
export function readD2cCards(html, baseUrl) {
  const source = String(html || '');
  const starts = [];
  CARD_START.lastIndex = 0;
  let match;
  while ((match = CARD_START.exec(source)) !== null) starts.push({ index: match.index, tag: match[0] });

  const vehicles = [];
  for (let i = 0; i < starts.length; i += 1) {
    // A card runs to the next card, or - for the last one - to the end of the results list.
    const listEnd = source.indexOf('</ul>', starts[i].index);
    const end = i + 1 < starts.length ? starts[i + 1].index : (listEnd === -1 ? source.length : listEnd);
    const card = source.slice(starts[i].index, end);

    const data = (/<input\b[^>]*\bname\s*=\s*["']vehicledata["'][^>]*>/i.exec(card) || [''])[0];
    const image = (/<div\b[^>]*\bclass\s*=\s*["'][^"']*\bcarImage\b[^"']*["'][^>]*>/i.exec(card) || [''])[0];
    const ld = vehicleLd(card);
    const offers = ld.offers && typeof ld.offers === 'object' ? (Array.isArray(ld.offers) ? ld.offers[0] : ld.offers) : {};

    const year = (attr(data, 'data-year') || attr(image, 'data-year')).slice(0, 4);
    const make = attr(data, 'data-make') || attr(image, 'data-make') || (ld.brand && ld.brand.name) || '';
    const model = attr(data, 'data-model') || attr(image, 'data-model');
    const rawStock = attr(data, 'data-stock-number') || attr(image, 'data-nostock');
    const stock = rawStock.replace(DEMO_SUFFIX, '').trim();
    const vin = (attr(data, 'data-vin') || attr(image, 'data-vin') || ld.vehicleIdentificationNumber || '').toUpperCase();
    const trim = cleanTrim(attr(data, 'data-trim') || textOfClass(card, 'divTrim'), model);

    const titleLink = /<a\b[^>]*\bhref\s*=\s*["']([^"']+)["'][^>]*\bclass\s*=\s*["'][^"']*\bcarTitle\b/i.exec(card);
    const url = absolute(offers.url || (titleLink && titleLink[1]) || '', baseUrl);

    const km = /(\d[\d,.\s]*)\s*km\b/i.exec(textOfClass(card, 's-km'));
    const imgTag = (/<img\b[^>]*\bclass\s*=\s*["'][^"']*\bmainImage\b[^>]*>/i.exec(card) || [''])[0];

    const vehicle = {
      year,
      make,
      model,
      trim,
      stock,
      vin,
      url,
      price: offers.price !== undefined && offers.price !== null ? String(offers.price) : '',
      odometer: km ? km[1].replace(/[^\d]/g, '') : '',
      image: attr(imgTag, 'data-imgsrc') || attr(imgTag, 'src') || (Array.isArray(ld.image) ? ld.image[0] : ld.image) || '',
      condition: attr(data, 'data-condition').toLowerCase(),
      demo: DEMO_SUFFIX.test(rawStock),
      siteId: attr(starts[i].tag, 'data-carid'),
      title: [year, make, model].filter(Boolean).join(' ')
    };
    vehicle.key = vehicleKey(vehicle);
    if (vehicle.key) vehicles.push(vehicle);
  }
  return vehicles;
}

const squash = (value) => String(value || '').toLowerCase().replace(/[^a-z0-9]/g, '');

/**
 * The "Our stock by brand" list under the results: a link and a count for each
 * make (demos listed separately). The counts add up to the whole lot.
 */
export function readBrandCounts(html, baseUrl) {
  const source = String(html || '');
  // The visible heading, not the copy of its wording kept in a hidden template input.
  const heading = />\s*our\s+stock\s+by\s+brand\s*</i.exec(source);
  if (!heading) return null;
  const listStart = source.indexOf('<ul', heading.index);
  const listEnd = source.indexOf('</ul>', listStart);
  if (listStart === -1 || listEnd === -1) return null;

  const entries = [];
  const re = /<a\b[^>]*\bhref\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>\s*<span\b[^>]*\bs-num\b[^>]*>\s*(\d+)\s*<\/span>/gi;
  let match;
  const list = source.slice(listStart, listEnd);
  while ((match = re.exec(list)) !== null) {
    const url = absolute(match[1], baseUrl);
    const brandSlug = decodeURIComponent(url.split('/').pop() || '').replace(/\.html?$/i, '');
    entries.push({ url, label: stripTags(match[2]), count: Number(match[3]), brand: squash(brandSlug) });
  }
  return entries.length ? entries : null;
}

/**
 * Collects the whole lot: the search page, plus the brand pages for any make
 * that came up short. `fetchPage(url)` returns { html, finalUrl }.
 */
export async function collectD2cInventory(firstPage, { fetchPage, log = () => {}, delayMs = 0, sleep } = {}) {
  const collected = new Map();
  const pages = [firstPage.finalUrl];
  const add = (html, url) => {
    let fresh = 0;
    for (const vehicle of readD2cCards(html, url)) {
      if (!collected.has(vehicle.key)) fresh += 1;
      collected.set(vehicle.key, vehicle);
    }
    return fresh;
  };

  add(firstPage.html, firstPage.finalUrl);
  log(`  search page: ${collected.size} vehicle(s)`);

  const brands = readBrandCounts(firstPage.html, firstPage.finalUrl);
  const claimedTotal = brands ? brands.reduce((sum, entry) => sum + entry.count, 0) : null;

  if (brands && collected.size < claimedTotal) {
    // How many of each make we should have (used + demo lines share a make).
    const expected = new Map();
    for (const entry of brands) expected.set(entry.brand, (expected.get(entry.brand) || 0) + entry.count);
    const haveOf = (brand) => [...collected.values()].filter((vehicle) => squash(vehicle.make) === brand).length;

    for (const entry of brands) {
      if (haveOf(entry.brand) >= expected.get(entry.brand)) continue;
      if (sleep && delayMs) await sleep(delayMs);
      try {
        const page = await fetchPage(entry.url);
        pages.push(page.finalUrl);
        const fresh = add(page.html, page.finalUrl);
        log(`  ${entry.label || entry.brand}: ${fresh} more`);
      } catch (error) {
        log(`  ! could not read ${entry.url} (${error.message})`);
      }
    }
  }

  const vehicles = [...collected.values()];
  return {
    vehicles,
    claimedTotal,
    complete: claimedTotal === null ? null : vehicles.length >= claimedTotal,
    pages
  };
}
