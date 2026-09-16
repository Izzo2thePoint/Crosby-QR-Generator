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
  fs.rmSync(scratch, { recursive: true, force: true });
  console.log(`\n${passed}/${checks.length} checks passed`);
  process.exitCode = passed === checks.length ? 0 : 1;
}

main().catch((error) => {
  console.error(error);
  if (server) server.close();
  process.exitCode = 1;
});
