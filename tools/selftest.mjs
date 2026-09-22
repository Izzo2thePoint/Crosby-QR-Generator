#!/usr/bin/env node
// End-to-end check: stands up a pretend dealer website, scrapes it, and walks
// the whole new-vehicle -> print -> marked-printed cycle. Run it any time with
//   node tools/selftest.mjs
// It writes to a scratch folder, so your real print history is never touched.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'crosby-selftest-'));
process.env.CROSBY_DATA_DIR = path.join(scratch, 'data');
process.env.CROSBY_CONFIG = path.join(scratch, 'config.json');

const vehicleLd = (v) => ({
  '@type': 'Vehicle',
  name: v.name,
  url: v.url,
  sku: v.stock,
  vehicleIdentificationNumber: v.vin,
  brand: { '@type': 'Brand', name: 'Volkswagen' },
  model: v.model,
  vehicleConfiguration: v.trim,
  modelDate: v.year,
  mileageFromOdometer: { '@type': 'QuantitativeValue', value: v.km, unitCode: 'KMT' },
  offers: { '@type': 'Offer', price: v.price, priceCurrency: 'CAD' }
});

function fakeSite(state) {
  return http.createServer((req, res) => {
    const url = new URL(req.url, `http://127.0.0.1:${state.port}`);
    const base = `http://127.0.0.1:${state.port}`;
    const page = Number(url.searchParams.get('page') || 1);
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });

    if (url.pathname === '/vehicles/' && page === 1) {
      // Page 1 looks like a normal dealer SRP: SEO structured data plus a next-page link.
      const items = state.page1.map((v, index) => ({ '@type': 'ListItem', position: index + 1, item: vehicleLd({ ...v, url: base + v.path }) }));
      res.end(`<!doctype html><html><head>
        <script type="application/ld+json">${JSON.stringify({ '@context': 'https://schema.org', '@type': 'ItemList', itemListElement: items })}</script>
        </head><body><h1>Used vehicles</h1>
        ${state.page1.map((v) => `<a href="${v.path}">${v.name}</a>`).join('')}
        <a href="/vehicles/?sc=used&page=2">Next page</a>
        </body></html>`);
      return;
    }

    if (url.pathname === '/vehicles/' && page === 2) {
      // Page 2 deliberately has NO structured data - only links, like a JS-rendered grid.
      res.end(`<!doctype html><html><body>
        ${state.page2.map((v) => `<a href="${v.path}"><span>${v.name}</span></a>`).join('')}
        </body></html>`);
      return;
    }

    const all = [...state.page1, ...state.page2];
    const match = all.find((v) => url.pathname === v.path);
    if (match) {
      res.end(`<!doctype html><html><head><title>${match.name} | Crosby VW</title>
        <script type="application/ld+json">${JSON.stringify(vehicleLd({ ...match, url: base + match.path }))}</script>
        </head><body><p>Stock #: ${match.stock}</p><p>VIN: ${match.vin}</p></body></html>`);
      return;
    }
    res.end('<html><body>Not found</body></html>');
  });
}

const FIXTURES = {
  jetta: { path: '/vehicles/2021-volkswagen-jetta-comfortline/123456/', name: '2021 Volkswagen Jetta Comfortline', year: '2021', model: 'Jetta', trim: 'Comfortline', stock: 'JG0119', vin: '3VWC57BU8MM012345', km: 48210, price: '24995' },
  atlas: { path: '/vehicles/2022-volkswagen-atlas-cross-sport-execline/223344/', name: '2022 Volkswagen Atlas Cross Sport Execline 4Motion', year: '2022', model: 'Atlas Cross Sport', trim: 'Execline 4Motion', stock: 'AC2201', vin: '1V2FE2CA1NC512233', km: 31500, price: '48995' },
  gti: { path: '/vehicles/2019-volkswagen-golf-gti-autobahn/778899/', name: '2019 Volkswagen Golf GTI Autobahn', year: '2019', model: 'Golf GTI', trim: 'Autobahn', stock: 'GT1907', vin: '3VW5T7AU0KM778899', km: 72400, price: '27995' },
  taos: { path: '/vehicles/2023-volkswagen-taos-highline/445566/', name: '2023 Volkswagen Taos Highline', year: '2023', model: 'Taos', trim: 'Highline', stock: 'TA2311', vin: '3VVEX7B27PM445566', km: 19800, price: '33995' }
};

const checks = [];
const check = (label, fn) => checks.push({ label, fn });

// ---------------------------------------------------------------------------
// A stand-in for the real site: a Vue-rendered listing page that contains no
// vehicles, plus the proxy its grid calls. The proxy answers 30 vehicles at a
// time and reports the true total, exactly like the live one.
// ---------------------------------------------------------------------------

const PAGE_CAP = 30;

function makeFleet() {
  const spread = [
    ['Volkswagen', 21, 'SUV'], ['Hyundai', 5, 'SUV'], ['Jeep', 2, 'SUV'], ['Chevrolet', 2, 'Sedan'],
    ['Kia', 2, 'Sedan'], ['Nissan', 1, 'SUV'], ['Ford', 1, 'Minivan'], ['Mazda', 1, 'Hatchback'],
    ['GMC', 1, 'SUV'], ['Dodge', 1, 'Minivan'], ['Chrysler', 1, 'Coupe'], ['Toyota', 1, 'SUV'], ['MINI', 1, 'Hatchback']
  ];
  const fleet = [];
  let n = 0;
  for (const [make, count, body] of spread) {
    for (let i = 0; i < count; i += 1) {
      n += 1;
      fleet.push({
        vehicle_id: 1000 + n,
        vin: 'VIN' + String(n).padStart(14, '0'),
        year: 2019 + (n % 5),
        stock_number: 'ST' + String(n).padStart(4, '0'),
        make,
        model: make === 'Volkswagen' ? 'Atlas Cross Sport' : 'Model' + (n % 7),
        trim: 'Sedan Highline',
        search_trim: 'Highline',
        body_style: body,
        sale_class: 'Used',
        odometer: 10000 + n * 137,
        internet_price: 20000 + n * 250,
        days_on_lot: n,
        in_transit: 0,
        on_order: 0,
        exterior_color: n % 2 ? 'White' : 'Black',
        transmission: 'Automatic',
        vdp_url: `https://dealer.example/vehicles/${2019 + (n % 5)}/${make}/veh/${1000 + n}/?sale_class=Used`
      });
    }
  }
  return fleet;
}

function facetCounts(list, field) {
  const counts = new Map();
  for (const item of list) counts.set(item[field], (counts.get(item[field]) || 0) + 1);
  return [...counts.entries()].map(([name, amount]) => ({ name, amount }));
}

function convertusSite(state) {
  return http.createServer((req, res) => {
    const base = `http://127.0.0.1:${state.port}`;
    const url = new URL(req.url, base);

    // Refusals, the way the real site's bot protection refuses.
    if (state.refuseCount > 0) {
      state.refuseCount -= 1;
      res.writeHead(403, { 'Content-Type': 'text/html' });
      res.end('<html><body>Forbidden</body></html>');
      return;
    }
    if (state.refusePage && !url.pathname.includes('ajax-vehicles') && !url.pathname.startsWith('/api/')) {
      res.writeHead(403, { 'Content-Type': 'text/html' });
      res.end('<html><body>Forbidden</body></html>');
      return;
    }
    if (url.pathname.startsWith('/api/') || url.pathname === '/wp-content/plugins/convertus-vms/include/php/ajax-vehicles.php') {
      state.proxyHits += 1;
      if (state.brokenProxy) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, msg: 'Requested endpoint is invalid.' }));
        return;
      }
      const endpoint = url.searchParams.get('endpoint') ? new URL(url.searchParams.get('endpoint')) : url;
      const filters = endpoint.searchParams;
      let matched = state.fleet.filter((v) => (filters.get('sc') || 'used').toLowerCase() === v.sale_class.toLowerCase());
      if (filters.get('mk')) matched = matched.filter((v) => v.make === filters.get('mk'));
      if (filters.get('bs')) matched = matched.filter((v) => v.body_style === filters.get('bs'));
      if (filters.get('yr')) matched = matched.filter((v) => String(v.year) === filters.get('yr'));
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        results: matched.slice(0, PAGE_CAP),
        summary: {
          total_vehicles: matched.length,
          mk: facetCounts(matched, 'make'),
          bs: facetCounts(matched, 'body_style'),
          yr: facetCounts(matched, 'year'),
          ec: facetCounts(matched, 'exterior_color')
        },
        filters: {},
        all_filters: {}
      }));
      return;
    }

    // The listing page: templates and configuration, no vehicles - like the real one.
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(`<!doctype html><html><head><title>Vehicles</title>
      <script>var globalVars = ${JSON.stringify({
        vmsApiUrl: `${base}/api/`,
        inventoryId: '4211',
        pluginsUrl: `${base}/wp-content/plugins`,
        language: 'en',
        useSearchModel: false,
        hideZeroPriceVehicles: 'true',
        inventoryTags: 'InventoryTagDemo',
        inventoryTagsMethod: 'excl',
        inventoryTagsSaleClass: 'new',
        dealerGeneralName: 'Crosby Volkswagen'
      })};</script></head>
      <body><div id="srp"><pagination :page="currentPage"></pagination></div>${state.pageJsonLd || ''}</body></html>`);
  });
}

let siteState;
let server;
let scrape;
let stateLib;

async function main() {
  siteState = { port: 0, page1: [FIXTURES.jetta, FIXTURES.atlas], page2: [FIXTURES.gti] };
  server = fakeSite(siteState);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  siteState.port = server.address().port;
  const listingUrl = `http://127.0.0.1:${siteState.port}/vehicles/?sc=used&in_stock=true&view=grid`;

  fs.writeFileSync(process.env.CROSBY_CONFIG, JSON.stringify({
    dealerName: 'Crosby Volkswagen (self-test)',
    listingUrl,
    requestDelayMs: 0,
    maxPages: 5,
    qrTracking: { utm_source: 'window_sticker', utm_medium: 'qr' }
  }, null, 2));

  scrape = await import('./scrape.mjs');
  stateLib = await import('./lib/state.mjs');

  const quiet = () => {};
  let first;
  let second;

  check('finds every vehicle across both listing pages', async () => {
    first = await scrape.runScrape({ log: quiet });
    assert.equal(first.inventory.counts.printable, 3, 'expected 3 vehicles');
  });

  check('reads year / make / model / trim / stock from structured data', async () => {
    const jetta = first.inventory.vehicles.find((v) => v.stock === 'JG0119');
    assert.ok(jetta, 'Jetta missing');
    assert.equal(jetta.year, '2021');
    assert.equal(jetta.make, 'Volkswagen');
    assert.equal(jetta.model, 'Jetta');
    assert.equal(jetta.trim, 'Comfortline');
    assert.equal(jetta.odometer, '48210');
  });

  check('keeps multi-word models intact (Atlas Cross Sport)', async () => {
    const atlas = first.inventory.vehicles.find((v) => v.stock === 'AC2201');
    assert.ok(atlas, 'Atlas missing');
    assert.equal(atlas.model, 'Atlas Cross Sport');
    assert.equal(atlas.trim, 'Execline 4Motion');
  });

  check('recovers a vehicle that only appears as a link (no structured data)', async () => {
    const gti = first.inventory.vehicles.find((v) => v.stock === 'GT1907');
    assert.ok(gti, 'GTI missing - vehicle-page fallback did not run');
    assert.equal(gti.model, 'Golf GTI');
    assert.equal(gti.vin, '3VW5T7AU0KM778899');
  });

  check('first run baselines the lot instead of queueing 3 labels', async () => {
    assert.equal(first.reconcile.wasBaseline, true);
    const queued = Object.values(first.state.vehicles).filter((r) => r.status === 'queued');
    assert.equal(queued.length, 0, 'nothing should be queued on a first run');
  });

  check('a newly listed vehicle shows up as new on the next check', async () => {
    siteState.page1 = [FIXTURES.jetta, FIXTURES.atlas, FIXTURES.taos];
    second = await scrape.runScrape({ log: quiet });
    assert.equal(second.inventory.counts.printable, 4);
    const queued = Object.values(second.state.vehicles).filter((r) => r.status === 'queued');
    assert.equal(queued.length, 1, 'exactly the Taos should be queued');
    assert.equal(queued[0].stock, 'TA2311');
  });

  check('re-checking does not re-queue something already queued', async () => {
    const third = await scrape.runScrape({ log: quiet });
    const queued = Object.values(third.state.vehicles).filter((r) => r.status === 'queued');
    assert.equal(queued.length, 1);
  });

  check('marking printed clears it from the queue for good', async () => {
    const state = stateLib.loadState(scrape.PATHS.state);
    const key = Object.values(state.vehicles).find((r) => r.status === 'queued').key;
    stateLib.setStatus(state, [key], stateLib.STATUS.PRINTED);
    stateLib.saveState(scrape.PATHS.state, state);
    const fourth = await scrape.runScrape({ log: quiet });
    const queued = Object.values(fourth.state.vehicles).filter((r) => r.status === 'queued');
    assert.equal(queued.length, 0);
    const printed = Object.values(fourth.state.vehicles).filter((r) => r.status === 'printed');
    assert.equal(printed.length, 1);
    assert.ok(printed[0].printedAt, 'printedAt should be stamped');
  });

  check('a sold vehicle disappearing from the site is recorded, not lost', async () => {
    siteState.page1 = [FIXTURES.jetta, FIXTURES.taos];
    const fifth = await scrape.runScrape({ log: quiet });
    const atlas = Object.values(fifth.state.vehicles).find((r) => r.stock === 'AC2201');
    assert.ok(atlas.removedAt, 'removed vehicle should be stamped with removedAt');
    assert.equal(fifth.inventory.vehicles.some((v) => v.stock === 'AC2201'), false);
  });

  check('the web app answers with inventory and serves the label page', async () => {
    const { startServer } = await import('./serve.mjs');
    const { server: appServer, port } = await startServer({ port: 0, open: false, scrapeOnStart: false });
    try {
      const payload = await fetch(`http://127.0.0.1:${port}/api/state`).then((r) => r.json());
      assert.ok(Array.isArray(payload.vehicles));
      assert.equal(payload.vehicles.length, 3);
      assert.equal(payload.dealerName, 'Crosby Volkswagen (self-test)');
      const page = await fetch(`http://127.0.0.1:${port}/`).then((r) => r.text());
      assert.ok(page.includes('Label Studio'), 'label page should be served at /');
      const lib = await fetch(`http://127.0.0.1:${port}/vendor/qr-code-styling.js`);
      assert.equal(lib.status, 200, 'QR library should be served locally');
    } finally {
      appServer.close();
    }
  });

  // ---- the inventory-system route ----
  const convState = { port: 0, fleet: makeFleet(), proxyHits: 0, brokenProxy: false, pageJsonLd: '', refusePage: false, refuseCount: 0 };
  const convServer = convertusSite(convState);
  await new Promise((resolve) => convServer.listen(0, '127.0.0.1', resolve));
  convState.port = convServer.address().port;
  const convListing = `http://127.0.0.1:${convState.port}/vehicles/?sc=used&in_stock=true&view=grid`;

  let apiRun;
  check('reads the whole lot from the inventory system, not the page', async () => {
    convState.proxyHits = 0;
    apiRun = await scrape.runScrape({ url: convListing, baseline: true, log: quiet });
    assert.equal(apiRun.inventory.source, 'inventory-api');
    assert.equal(apiRun.inventory.counts.printable, 40, 'expected all 40 vehicles');
  });

  check('splits the request when the answer is cut off at 30', async () => {
    assert.ok(convState.proxyHits > 1, 'should have made more than one request');
    assert.equal(apiRun.inventory.apiTotal, 40);
    assert.equal(apiRun.inventory.apiWarning, null, 'nothing should be reported missing');
  });

  check('maps the API fields onto the label', async () => {
    const vehicle = apiRun.inventory.vehicles.find((v) => v.stock === 'ST0001');
    assert.ok(vehicle, 'ST0001 missing');
    assert.equal(vehicle.make, 'Volkswagen');
    assert.equal(vehicle.model, 'Atlas Cross Sport');
    assert.equal(vehicle.trim, 'Highline', 'should prefer the short trim over "Sedan Highline"');
    assert.equal(vehicle.vin, 'VIN00000000000001');
    assert.equal(vehicle.odometer, '10137');
    assert.ok(vehicle.url.includes('/vehicles/'), 'should carry the vehicle page link');
  });

  check('keeps junk trims off the label', async () => {
    const { toVehicle } = await import('./lib/convertus.mjs');
    const make = (extra) => toVehicle({ make: 'Volkswagen', stock_number: 'X1', vdp_url: 'https://dealer.example/v/1', ...extra });
    assert.equal(make({ model: 'Golf GTI', search_trim: "Other/Don't Know" }).trim, '', 'placeholder trim should be dropped');
    assert.equal(make({ model: 'Beetle Dune', search_trim: 'Dune' }).trim, '', 'trim already in the model should be dropped');
    assert.equal(make({ model: 'Taos', search_trim: 'Unspecified' }).trim, '');
    assert.equal(make({ model: 'Forte Sedan', search_trim: 'LX', trim: 'Sedan LX' }).trim, 'LX', 'a real trim must survive');
    assert.equal(make({ model: 'Tiguan', search_trim: '', trim: 'Comfortline' }).trim, 'Comfortline', 'falls back to the long trim');
  });

  check('says so when the inventory system hands back less than it claims', async () => {
    const shortState = { ...convState, fleet: convState.fleet };
    assert.ok(shortState.fleet.length === 40);
    // A lot with one make and no usable facets cannot be split past the cap.
    const flat = convState.fleet.map((v) => ({ ...v, make: 'Volkswagen', body_style: 'SUV', year: 2020, exterior_color: 'White' }));
    const previous = convState.fleet;
    convState.fleet = flat;
    const run = await scrape.runScrape({ url: convListing, baseline: true, log: quiet });
    convState.fleet = previous;
    assert.equal(run.inventory.counts.printable, PAGE_CAP);
    assert.ok(run.inventory.apiWarning, 'a shortfall should be reported, not hidden');
  });

  check('reads the inventory even when the page is refused', async () => {
    // The settings the page would have given us, kept from the last good read.
    fs.writeFileSync(scrape.PATHS.siteConfig, JSON.stringify({
      vmsApiUrl: `http://127.0.0.1:${convState.port}/api/`,
      inventoryId: '4211',
      pluginsUrl: `http://127.0.0.1:${convState.port}/wp-content/plugins`,
      language: 'en',
      hideZeroPriceVehicles: 'true',
      inventoryTags: 'InventoryTagDemo',
      inventoryTagsMethod: 'excl',
      inventoryTagsSaleClass: 'new'
    }));
    convState.refusePage = true;
    const run = await scrape.runScrape({ url: convListing, baseline: true, log: quiet });
    convState.refusePage = false;
    assert.equal(run.inventory.source, 'inventory-api');
    assert.equal(run.inventory.counts.printable, 40, 'the whole lot should still be read');
  });

  check('a refusal that clears is retried rather than fatal', async () => {
    fs.rmSync(scrape.PATHS.siteConfig, { force: true });
    convState.refuseCount = 1;            // the first request only
    const run = await scrape.runScrape({ url: convListing, baseline: true, log: quiet });
    assert.equal(convState.refuseCount, 0, 'the refusal should have been consumed');
    assert.equal(run.inventory.counts.printable, 40, 'the retry should have succeeded');
  });

  check('remembers the settings after reading the page', async () => {
    const saved = JSON.parse(fs.readFileSync(scrape.PATHS.siteConfig, 'utf8'));
    assert.equal(saved.inventoryId, '4211');
    assert.ok(saved.vmsApiUrl, 'the api address should be kept for next time');
    assert.ok(saved.savedAt, 'and stamped');
  });

  check('falls back to reading the page when the inventory system refuses', async () => {
    convState.brokenProxy = true;
    convState.pageJsonLd = `<script type="application/ld+json">${JSON.stringify({
      '@context': 'https://schema.org', '@type': 'Vehicle', name: '2021 Volkswagen Jetta Comfortline',
      url: `http://127.0.0.1:${convState.port}/vehicles/jetta/1/`, sku: 'FB0001',
      vehicleIdentificationNumber: '3VWC57BU8MM012345', brand: { name: 'Volkswagen' },
      model: 'Jetta', vehicleConfiguration: 'Comfortline', modelDate: '2021'
    })}</script>`;
    const run = await scrape.runScrape({ url: convListing, baseline: true, log: quiet });
    convState.brokenProxy = false;
    convState.pageJsonLd = '';
    assert.equal(run.inventory.source, 'page');
    assert.equal(run.inventory.counts.printable, 1);
    assert.equal(run.inventory.vehicles[0].stock, 'FB0001');
  });

  // ---- the label page itself ----
  // These two mistakes both shipped and both broke printing, so they are worth
  // a guard even though this file cannot open a browser.
  const pageSource = fs.readFileSync(path.join(scrape.ROOT, 'index.html'), 'utf8');

  check('libraries are loaded by relative path', async () => {
    const absolute = pageSource.match(/<script[^>]+src="\/[^"]*"/g) || [];
    assert.equal(absolute.length, 0,
      'a published project site lives in a subdirectory, where "/vendor/..." points above it: ' + absolute.join(', '));
  });

  check('the QR is drawn to a canvas, not left as a clipped drawing', async () => {
    assert.match(pageSource, /type: 'canvas'/, 'print engines drop the clip-path the SVG output relies on');
  });

  check('the centre logo stays small enough for the code to survive', async () => {
    const match = /imageSize:\s*([\d.]+)/.exec(pageSource);
    assert.ok(match, 'imageSize not found');
    assert.ok(Number(match[1]) <= 0.3, `imageSize ${match[1]} hides too much of the code to scan`);
  });

  let passed = 0;
  for (const { label, fn } of checks) {
    try {
      await fn();
      console.log(`  PASS  ${label}`);
      passed += 1;
    } catch (error) {
      console.log(`  FAIL  ${label}`);
      console.log(`        ${error.message}`);
    }
  }

  server.close();
  convServer.close();
  fs.rmSync(scratch, { recursive: true, force: true });
  console.log(`\n${passed}/${checks.length} checks passed`);
  process.exitCode = passed === checks.length ? 0 : 1;
}

main().catch((error) => {
  console.error(error);
  if (server) server.close();
  process.exitCode = 1;
});
