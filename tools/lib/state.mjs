// Print-queue state. A vehicle is "new" until you actually print or skip it,
// so a crash, a paper jam, or closing the tab never loses a label.

import fs from 'node:fs';
import path from 'node:path';

export const STATUS = {
  QUEUED: 'queued',       // seen, never printed -> this is the "new" list
  PRINTED: 'printed',     // label produced
  SKIPPED: 'skipped',     // deliberately passed over
  BASELINE: 'baseline'    // already on the lot when the tool was first installed
};

export function loadState(statePath) {
  try {
    const parsed = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    if (parsed && typeof parsed === 'object' && parsed.vehicles) return parsed;
  } catch {
    // No state yet (or it was hand-edited into something unreadable) - start clean.
  }
  return { version: 1, createdAt: new Date().toISOString(), baselined: false, vehicles: {} };
}

export function saveState(statePath, state) {
  fs.mkdirSync(path.dirname(statePath), { recursive: true });
  const tmp = `${statePath}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
  fs.renameSync(tmp, statePath);
  return state;
}

/**
 * Folds a fresh inventory scrape into the state file.
 * First ever run baselines everything so you do not print the whole lot by accident.
 */
export function reconcile(state, vehicles, { baseline = false } = {}) {
  const now = new Date().toISOString();
  const isFirstRun = !state.baselined && Object.keys(state.vehicles).length === 0;
  const asBaseline = baseline || isFirstRun;
  const seenKeys = new Set();
  const added = [];

  for (const vehicle of vehicles) {
    if (!vehicle.key) continue;
    seenKeys.add(vehicle.key);
    const existing = state.vehicles[vehicle.key];
    if (existing) {
      existing.lastSeen = now;
      existing.removedAt = null;
      existing.title = vehicle.title || existing.title;
      existing.stock = vehicle.stock || existing.stock;
      existing.vin = vehicle.vin || existing.vin;
      existing.url = vehicle.url || existing.url;
      continue;
    }
    state.vehicles[vehicle.key] = {
      key: vehicle.key,
      stock: vehicle.stock || '',
      vin: vehicle.vin || '',
      url: vehicle.url || '',
      title: vehicle.title || '',
      status: asBaseline ? STATUS.BASELINE : STATUS.QUEUED,
      firstSeen: now,
      lastSeen: now,
      printedAt: null,
      removedAt: null
    };
    added.push(state.vehicles[vehicle.key]);
  }

  for (const record of Object.values(state.vehicles)) {
    if (!seenKeys.has(record.key) && !record.removedAt) record.removedAt = now;
  }

  state.baselined = true;
  state.lastScrape = now;
  return { state, added, wasBaseline: asBaseline, isFirstRun };
}

export function setStatus(state, keys, status) {
  const now = new Date().toISOString();
  const touched = [];
  for (const key of keys) {
    const record = state.vehicles[key];
    if (!record) continue;
    record.status = status;
    record.printedAt = status === STATUS.PRINTED ? now : record.printedAt;
    touched.push(key);
  }
  return touched;
}
