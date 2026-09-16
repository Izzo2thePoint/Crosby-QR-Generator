// Three independent ways to pull vehicles out of an inventory page, tried in
// order of trustworthiness. Dealer platforms change their markup; they rarely
// drop their SEO structured data, so JSON-LD leads.

import { anchors, decodeEntities, scriptBlocks, stripTags } from './html.mjs';
import { mergeVehicle, normalizeVehicle, vehicleKey } from './vehicles.mjs';

const VEHICLE_TYPES = new Set(['vehicle', 'car', 'motorcycle', 'product', 'individualproduct', 'offer']);

/** Walks parsed JSON and returns every object that smells like a vehicle. */
function collectVehicleObjects(node, found = [], depth = 0) {
  if (!node || depth > 12) return found;
  if (Array.isArray(node)) {
    for (const item of node) collectVehicleObjects(item, found, depth + 1);
    return found;
  }
  if (typeof node !== 'object') return found;

  const keys = Object.keys(node).map((k) => k.toLowerCase());
  const type = String(node['@type'] || node.type || '').toLowerCase();
  const hasIdentifier = keys.some((k) => ['vin', 'vehicleidentificationnumber', 'stock', 'stocknumber', 'stock_number', 'stockno', 'sku'].includes(k));
  const hasShape = keys.includes('make') && keys.includes('model');
  const isTypedVehicle = VEHICLE_TYPES.has(type) && (keys.includes('name') || keys.includes('url'));

  if (hasIdentifier || hasShape || isTypedVehicle) found.push(node);

  for (const value of Object.values(node)) {
    if (value && typeof value === 'object') collectVehicleObjects(value, found, depth + 1);
  }
  return found;
}

function addVehicle(map, raw, baseUrl) {
  const vehicle = normalizeVehicle(raw, baseUrl);
  if (!vehicle || !vehicle.key) return;
  map.set(vehicle.key, map.has(vehicle.key) ? mergeVehicle(map.get(vehicle.key), vehicle) : vehicle);
}

export function extractFromJsonLd(html, baseUrl) {
  const found = new Map();
  for (const block of scriptBlocks(html, (type) => type.includes('ld+json'))) {
    let parsed;
    try {
      parsed = JSON.parse(block.trim());
    } catch {
      continue;
    }
    for (const candidate of collectVehicleObjects(parsed)) addVehicle(found, candidate, baseUrl);
  }
  return [...found.values()];
}

/** Scans forward from `start` (a { or [) and returns the balanced slice. */
function balancedSlice(text, start) {
  const open = text[start];
  const close = open === '{' ? '}' : ']';
  let depth = 0;
  let inString = false;
  let quote = '';
  for (let i = start; i < text.length; i += 1) {
    const ch = text[i];
    if (inString) {
      if (ch === '\\') { i += 1; continue; }
      if (ch === quote) inString = false;
      continue;
    }
    if (ch === '"' || ch === "'") { inString = true; quote = ch; continue; }
    if (ch === open) depth += 1;
    else if (ch === close) {
      depth -= 1;
      if (depth === 0) return text.slice(start, i + 1);
    }
    if (i - start > 6_000_000) break;
  }
  return '';
}

const STATE_ASSIGNMENTS = [
  /window\.__(?:NUXT|INITIAL_STATE|PRELOADED_STATE|APOLLO_STATE|NEXT_DATA|INVENTORY)__\s*=\s*/g,
  /window\.(?:vehicles|inventory|inventoryData|srpData|vehicleData|searchResults)\s*=\s*/gi,
  /(?:var|let|const)\s+(?:vehicles|inventory|inventoryData|srpData|vehicleData|searchResults)\s*=\s*/gi,
  /dataLayer\s*\.\s*push\s*\(\s*/g,
  /dataLayer\s*=\s*/g
];

export function extractFromEmbeddedJson(html, baseUrl) {
  const found = new Map();
  const jsonChunks = [];

  for (const block of scriptBlocks(html, (type, attrs) => /__NEXT_DATA__/.test(attrs) || type === 'application/json')) {
    jsonChunks.push(block.trim());
  }

  for (const pattern of STATE_ASSIGNMENTS) {
    pattern.lastIndex = 0;
    let match;
    while ((match = pattern.exec(html)) !== null) {
      const start = match.index + match[0].length;
      const opener = html.slice(start, start + 200).search(/[{[]/);
      if (opener === -1) continue;
      const slice = balancedSlice(html, start + opener);
      if (slice) jsonChunks.push(slice);
    }
  }

  const dataAttr = /data-(?:vehicle|vehicle-info|vehicle-data|inventory|gtm|product)\s*=\s*(["'])([\s\S]*?)\1/gi;
  let attrMatch;
  while ((attrMatch = dataAttr.exec(html)) !== null) {
    const value = decodeEntities(attrMatch[2]).trim();
    if (value.startsWith('{') || value.startsWith('[')) jsonChunks.push(value);
  }

  for (const chunk of jsonChunks) {
    let parsed;
    try {
      parsed = JSON.parse(chunk);
    } catch {
      continue;
    }
    for (const candidate of collectVehicleObjects(parsed)) addVehicle(found, candidate, baseUrl);
  }
  return [...found.values()];
}

const NON_VEHICLE_SEGMENTS = new Set([
  'compare', 'finance', 'search', 'page', 'filter', 'sort', 'print', 'share',
  'brochure', 'new', 'used', 'specials', 'value-your-trade', 'test-drive'
]);

/** Links that look like a vehicle detail page (VDP) rather than a filter link. */
export function findVdpLinks(html, baseUrl) {
  const seen = new Map();
  for (const link of anchors(html, baseUrl)) {
    let parsed;
    try {
      parsed = new URL(link.href);
    } catch {
      continue;
    }
    if (parsed.host !== new URL(baseUrl).host) continue;

    const segments = parsed.pathname.split('/').filter(Boolean);
    if (segments.length < 2) continue;

    const inVehicleSection = /^(vehicles?|inventory|used-vehicles|used-inventory|vehicle-details|auto)$/i.test(segments[0]);
    if (!inVehicleSection) continue;
    if (NON_VEHICLE_SEGMENTS.has(segments[1].toLowerCase())) continue;

    // A real VDP path ends in something specific: a stock/id or a slug with a year.
    const tail = segments[segments.length - 1];
    const looksSpecific = /\d/.test(parsed.pathname) && (segments.length >= 3 || /[-_]/.test(tail) || /^\d+$/.test(tail));
    if (!looksSpecific) continue;

    // Dedupe on a normalized path, but keep the href exactly as the site wrote it -
    // some platforms 404 without the trailing slash.
    const dedupeKey = `${parsed.origin}${parsed.pathname}`.replace(/\/$/, '');
    const href = `${parsed.origin}${parsed.pathname}`;
    const text = link.text.replace(/\s+/g, ' ').trim();
    const existing = seen.get(dedupeKey);
    if (!existing || (text.length > existing.text.length && /(19|20)\d{2}/.test(text))) seen.set(dedupeKey, { href, text });
  }
  return [...seen.values()];
}

/** Last-resort scrape: VDP links plus whatever title text sits in the anchor. */
export function extractFromDom(html, baseUrl) {
  const found = new Map();
  for (const link of findVdpLinks(html, baseUrl)) {
    const titleMatch = /((?:19|20)\d{2}\s+[A-Za-z][\w.\-]*(?:\s+[\w.\-/]+){0,6})/.exec(link.text);
    const raw = {
      url: link.href,
      title: titleMatch ? titleMatch[1] : link.text,
      condition: 'used'
    };
    if (!raw.title) continue;
    addVehicle(found, raw, baseUrl);
  }
  return [...found.values()];
}

/** Runs every strategy and merges the results by stock/VIN/URL. */
export function extractVehicles(html, baseUrl) {
  const merged = new Map();
  const strategies = [];
  const runners = [
    ['json-ld', extractFromJsonLd],
    ['embedded-json', extractFromEmbeddedJson],
    ['dom', extractFromDom]
  ];

  for (const [name, runner] of runners) {
    let results = [];
    try {
      results = runner(html, baseUrl);
    } catch (error) {
      strategies.push({ name, count: 0, error: error.message });
      continue;
    }
    strategies.push({ name, count: results.length });
    for (const vehicle of results) {
      const key = vehicle.key || vehicleKey(vehicle);
      if (!key) continue;
      merged.set(key, merged.has(key) ? mergeVehicle(merged.get(key), vehicle) : { ...vehicle, key });
    }
  }
  return { vehicles: [...merged.values()], strategies };
}

/** Highest page number linked from the listing, so we know how far to paginate. */
export function findMaxPage(html, baseUrl) {
  let max = 1;
  for (const link of anchors(html, baseUrl)) {
    const queryMatch = /[?&](?:page|p|pg|pagenumber)=(\d{1,3})\b/i.exec(link.href);
    const pathMatch = /\/page\/(\d{1,3})\b/i.exec(link.href);
    const value = Number((queryMatch && queryMatch[1]) || (pathMatch && pathMatch[1]) || 0);
    if (value > max && value < 500) max = value;
  }
  const textual = /showing\s+\d+\s*[-–]\s*\d+\s+of\s+(\d{1,4})/i.exec(stripTags(html));
  if (textual) {
    const total = Number(textual[1]);
    if (total > 0) max = Math.max(max, Math.ceil(total / 12));
  }
  return max;
}
