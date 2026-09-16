#!/usr/bin/env node
// Runs the Label Studio locally: serves the label page, talks to the scraper,
// and remembers what has already been printed. Bound to 127.0.0.1 only.

import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { runScrape, loadConfig, PATHS, ROOT } from './scrape.mjs';
import { loadState, saveState, setStatus, STATUS } from './lib/state.mjs';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon'
};

const STATIC_DIRS = ['vendor', 'assets'];
const LOGO_NAMES = { header: 'logo-header', icon: 'logo-icon' };

let lastScrapeError = null;
let scrapeInFlight = null;

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function findLogo(kind) {
  const base = LOGO_NAMES[kind];
  const dir = path.join(ROOT, 'assets');
  if (!fs.existsSync(dir)) return '';
  const match = fs.readdirSync(dir).find((file) => file.startsWith(`${base}.`));
  return match ? `/assets/${match}` : '';
}

/** Inventory joined with print-queue status - everything the page needs in one call. */
function buildPayload() {
  const config = loadConfig();
  const inventory = readJson(PATHS.inventory, null);
  const state = loadState(PATHS.state);

  const vehicles = (inventory ? inventory.vehicles : []).map((vehicle) => {
    const record = state.vehicles[vehicle.key] || {};
    return {
      ...vehicle,
      status: record.status || STATUS.QUEUED,
      firstSeen: record.firstSeen || null,
      printedAt: record.printedAt || null
    };
  });

  // Queued vehicles that vanished from the website (sold before a label was printed).
  // Only surface recent ones - older ones are history, not something to act on.
  const listedKeys = new Set(vehicles.map((vehicle) => vehicle.key));
  const recentCutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
  const queuedButGone = Object.values(state.vehicles).filter((record) => (
    record.status === STATUS.QUEUED
    && !listedKeys.has(record.key)
    && record.removedAt
    && new Date(record.removedAt).getTime() >= recentCutoff
  ));

  return {
    dealerName: config.dealerName,
    listingUrl: config.listingUrl,
    qrTracking: config.qrTracking || {},
    logos: { header: findLogo('header'), icon: findLogo('icon') },
    fetchedAt: inventory ? inventory.fetchedAt : null,
    counts: inventory ? inventory.counts : null,
    strategies: inventory ? inventory.strategies : null,
    incomplete: inventory ? inventory.incomplete || [] : [],
    everScraped: Boolean(inventory),
    baselined: Boolean(state.baselined),
    lastError: lastScrapeError,
    queuedButGone,
    vehicles
  };
}

function sendJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(payload);
}

function sendFile(res, filePath) {
  const ext = path.extname(filePath).toLowerCase();
  res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream', 'Cache-Control': 'no-store' });
  fs.createReadStream(filePath).pipe(res);
}

async function readBody(req, limitBytes = 12 * 1024 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limitBytes) throw new Error('Upload too large');
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

function saveLogo(kind, dataUrl) {
  const match = /^data:image\/(png|jpeg|jpg|gif|svg\+xml|webp);base64,([A-Za-z0-9+/=]+)$/.exec(String(dataUrl || ''));
  if (!match) throw new Error(`${kind} logo must be a PNG, JPG, GIF, SVG or WEBP image`);
  const ext = match[1] === 'svg+xml' ? 'svg' : match[1] === 'jpeg' ? 'jpg' : match[1];
  const dir = path.join(ROOT, 'assets');
  fs.mkdirSync(dir, { recursive: true });
  for (const existing of fs.readdirSync(dir)) {
    if (existing.startsWith(`${LOGO_NAMES[kind]}.`)) fs.unlinkSync(path.join(dir, existing));
  }
  fs.writeFileSync(path.join(dir, `${LOGO_NAMES[kind]}.${ext}`), Buffer.from(match[2], 'base64'));
  return `/assets/${LOGO_NAMES[kind]}.${ext}`;
}

async function handleApi(req, res, url) {
  if (req.method === 'GET' && url.pathname === '/api/state') {
    sendJson(res, 200, buildPayload());
    return true;
  }

  if (req.method === 'POST' && url.pathname === '/api/refresh') {
    const body = await readBody(req).catch(() => ({}));
    if (!scrapeInFlight) {
      lastScrapeError = null;
      scrapeInFlight = runScrape({ baseline: Boolean(body.baseline), dump: Boolean(body.dump), log: (line) => console.log(line) })
        .catch((error) => {
          lastScrapeError = error.message;
          console.error(`Scrape failed: ${error.message}`);
        })
        .finally(() => { scrapeInFlight = null; });
    }
    await scrapeInFlight;
    sendJson(res, lastScrapeError ? 502 : 200, buildPayload());
    return true;
  }

  if (req.method === 'POST' && url.pathname === '/api/mark') {
    const body = await readBody(req);
    const keys = Array.isArray(body.keys) ? body.keys : [];
    const status = Object.values(STATUS).includes(body.status) ? body.status : STATUS.PRINTED;
    const state = loadState(PATHS.state);
    const touched = setStatus(state, keys, status);
    saveState(PATHS.state, state);
    console.log(`Marked ${touched.length} vehicle(s) as ${status}`);
    sendJson(res, 200, { touched, ...buildPayload() });
    return true;
  }

  if (req.method === 'POST' && url.pathname === '/api/logos') {
    const body = await readBody(req);
    const saved = {};
    if (body.header) saved.header = saveLogo('header', body.header);
    if (body.icon) saved.icon = saveLogo('icon', body.icon);
    console.log('Saved dealership logo(s) to assets/');
    sendJson(res, 200, { saved, ...buildPayload() });
    return true;
  }

  return false;
}

function resolveStatic(pathname) {
  if (pathname === '/' || pathname === '/index.html') return path.join(ROOT, 'labels.html');
  const segments = pathname.split('/').filter(Boolean);
  if (!segments.length || !STATIC_DIRS.includes(segments[0])) return '';
  const candidate = path.join(ROOT, ...segments);
  const root = path.join(ROOT, segments[0]);
  if (!candidate.startsWith(root + path.sep)) return '';
  return fs.existsSync(candidate) && fs.statSync(candidate).isFile() ? candidate : '';
}

function openBrowser(target) {
  const command = process.platform === 'win32' ? 'cmd' : process.platform === 'darwin' ? 'open' : 'xdg-open';
  const args = process.platform === 'win32' ? ['/c', 'start', '""', target] : [target];
  try {
    spawn(command, args, { detached: true, stdio: 'ignore' }).unref();
  } catch {
    // Headless box or no default browser - the URL is printed below anyway.
  }
}

async function listen(server, port, attemptsLeft = 10) {
  return new Promise((resolve, reject) => {
    const onError = (error) => {
      if (error.code === 'EADDRINUSE' && attemptsLeft > 0) {
        server.removeListener('error', onError);
        resolve(listen(server, port + 1, attemptsLeft - 1));
        return;
      }
      reject(error);
    };
    server.once('error', onError);
    server.listen(port, '127.0.0.1', () => {
      server.removeListener('error', onError);
      resolve(server.address().port);
    });
  });
}

export async function startServer({ port, open = true, scrapeOnStart = true } = {}) {
  const config = loadConfig();
  const server = http.createServer(async (req, res) => {
    let url;
    try {
      url = new URL(req.url, 'http://127.0.0.1');
    } catch {
      sendJson(res, 400, { error: 'Bad request' });
      return;
    }

    try {
      if (url.pathname.startsWith('/api/')) {
        const handled = await handleApi(req, res, url);
        if (!handled) sendJson(res, 404, { error: 'Unknown endpoint' });
        return;
      }
      if (url.pathname === '/favicon.ico') {
        res.writeHead(204);
        res.end();
        return;
      }
      const file = resolveStatic(url.pathname);
      if (!file) {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('Not found');
        return;
      }
      sendFile(res, file);
    } catch (error) {
      console.error(error);
      sendJson(res, 500, { error: error.message });
    }
  });

  // port === 0 means "any free port" (used by the self-test); undefined means "use config".
  const requested = port === undefined || port === null ? Number(config.port) || 4321 : Number(port);
  const activePort = await listen(server, requested);
  const address = `http://127.0.0.1:${activePort}/`;

  console.log('');
  console.log(`  ${config.dealerName} Label Studio`);
  console.log(`  ${address}`);
  console.log('  Leave this window open while you work. Close it (or press Ctrl+C) when done.');
  console.log('');

  if (scrapeOnStart) {
    console.log('Checking the used inventory page for new arrivals...');
    try {
      await runScrape({ log: (line) => console.log(line) });
    } catch (error) {
      lastScrapeError = error.message;
      console.error(`Could not reach the inventory page: ${error.message}`);
      console.error('The page will still open - use "Check for new vehicles" to try again.');
    }
  }

  if (open) openBrowser(address);
  return { server, port: activePort, url: address };
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  const args = process.argv.slice(2);
  const portArg = args.find((arg) => arg.startsWith('--port='));
  startServer({
    port: portArg ? Number(portArg.slice('--port='.length)) : undefined,
    open: !args.includes('--no-open'),
    scrapeOnStart: !args.includes('--no-scrape')
  }).catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
