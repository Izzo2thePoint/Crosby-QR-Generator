// Vehicle normalization: turns whatever shape the dealer site gives us into the
// five fields the label needs (year / make / model / trim / stock) plus the VDP url.

const MULTI_WORD_MODELS = [
  // Volkswagen first - this is a VW store, so these must win.
  'Atlas Cross Sport', 'Golf Alltrack', 'Golf SportWagen', 'Golf Sportwagen', 'Golf GTI', 'Golf R',
  'Jetta GLI', 'ID.4', 'ID.Buzz', 'ID. Buzz', 'e-Golf', 'e-Tron', 'Beetle Convertible',
  'Tiguan Limited', 'Cross Sport',
  // Common trade-ins.
  'Grand Caravan', 'Grand Cherokee L', 'Grand Cherokee', 'Grand Wagoneer', 'Wrangler Unlimited',
  'Santa Fe XL', 'Santa Fe Sport', 'Santa Fe', 'Santa Cruz', 'Elantra GT', 'Ioniq 5', 'Ioniq 6',
  'Rogue Sport', 'Mustang Mach-E', 'Transit Connect', 'Grand Touring', 'Model 3', 'Model Y',
  'Model S', 'Model X', 'Outlander PHEV', 'Eclipse Cross', 'Silverado 1500', 'Silverado 2500HD',
  'Sierra 1500', 'Sierra 2500HD', 'Ram 1500', 'Ram 2500', 'Ram 3500', 'F-150', 'F-250', 'F-350',
  'Super Duty', 'Escalade ESV', 'Range Rover Sport', 'Range Rover Evoque', 'Range Rover Velar',
  'Range Rover', 'Civic Type R', 'CX-5', 'CX-30', 'CX-50', 'CX-9', 'CR-V', 'HR-V', 'RAV4 Prime',
  'RAV4', 'C-HR', 'GR86', 'GR Corolla', 'Corolla Cross', 'Highlander Hybrid', 'Prius Prime',
  'XC40 Recharge', 'XC60', 'XC90', 'Q5 e', 'e-tron GT', 'Kona Electric', 'Niro EV', 'Soul EV'
];

const MULTI_WORD_MAKES = [
  'Land Rover', 'Alfa Romeo', 'Aston Martin', 'Rolls Royce', 'Rolls-Royce'
];

const MAKE_ALIASES = {
  vw: 'Volkswagen',
  volkswagen: 'Volkswagen',
  chevy: 'Chevrolet',
  mercedes: 'Mercedes-Benz',
  'mercedes benz': 'Mercedes-Benz'
};

export function titleCaseMake(make) {
  const key = String(make || '').trim().toLowerCase();
  if (!key) return '';
  if (MAKE_ALIASES[key]) return MAKE_ALIASES[key];
  return String(make).trim();
}

/** "2021 Volkswagen Atlas Cross Sport Execline 4Motion" -> {year, make, model, trim} */
export function parseTitle(title) {
  const clean = String(title || '').replace(/\s+/g, ' ').trim();
  const out = { year: '', make: '', model: '', trim: '' };
  if (!clean) return out;

  let rest = clean;
  const yearMatch = /^(?:new|used|pre-?owned|certified)?\s*((?:19|20)\d{2})\b\s*/i.exec(rest);
  if (yearMatch) {
    out.year = yearMatch[1];
    rest = rest.slice(yearMatch[0].length);
  }

  const multiMake = MULTI_WORD_MAKES.find((mk) => rest.toLowerCase().startsWith(mk.toLowerCase() + ' '));
  if (multiMake) {
    out.make = multiMake;
    rest = rest.slice(multiMake.length).trim();
  } else {
    const firstSpace = rest.indexOf(' ');
    out.make = titleCaseMake(firstSpace === -1 ? rest : rest.slice(0, firstSpace));
    rest = firstSpace === -1 ? '' : rest.slice(firstSpace + 1).trim();
  }

  if (!rest) return out;

  const multiModel = MULTI_WORD_MODELS.find((md) => {
    const lower = rest.toLowerCase();
    const target = md.toLowerCase();
    return lower === target || lower.startsWith(target + ' ');
  });
  if (multiModel) {
    out.model = rest.slice(0, multiModel.length);
    out.trim = rest.slice(multiModel.length).trim();
  } else {
    const firstSpace = rest.indexOf(' ');
    out.model = firstSpace === -1 ? rest : rest.slice(0, firstSpace);
    out.trim = firstSpace === -1 ? '' : rest.slice(firstSpace + 1).trim();
  }
  return out;
}

const pick = (...values) => {
  for (const value of values) {
    if (value === 0) continue;
    if (value === null || value === undefined) continue;
    const str = String(typeof value === 'object' ? (value.name || value.value || '') : value).trim();
    if (str && str.toLowerCase() !== 'null' && str.toLowerCase() !== 'undefined') return str;
  }
  return '';
};

const digits = (value) => {
  const str = pick(value);
  const match = /(\d[\d,\.]*)/.exec(str);
  return match ? match[1].replace(/[,\.]$/, '') : '';
};

/**
 * Accepts a loose object from JSON-LD, a site's embedded JSON, or DOM scraping
 * and returns the canonical label record (or null when it clearly isn't a vehicle).
 */
export function normalizeVehicle(raw, baseUrl) {
  if (!raw || typeof raw !== 'object') return null;

  const brand = raw.brand && typeof raw.brand === 'object' ? raw.brand.name : raw.brand;
  const title = pick(raw.title, raw.name, raw.vehicleTitle, raw.displayName, raw.heading);

  const fromTitle = parseTitle(title);
  const year = pick(raw.year, raw.modelYear, raw.model_year, raw.vehicleModelDate, raw.modelDate, raw.productionDate, fromTitle.year).slice(0, 4);
  const make = titleCaseMake(pick(raw.make, brand, raw.manufacturer, fromTitle.make));
  const model = pick(raw.model, raw.modelName, raw.model_name, fromTitle.model);
  const trim = pick(raw.trim, raw.trimLevel, raw.trim_level, raw.vehicleConfiguration, raw.series, fromTitle.trim);
  const stock = pick(raw.stock, raw.stockNumber, raw.stock_number, raw.stockNo, raw.stockId, raw.sku, raw.inventoryId);
  const vin = pick(raw.vin, raw.vehicleIdentificationNumber, raw.VIN).toUpperCase();

  let url = pick(raw.url, raw.vdpUrl, raw.vdp_url, raw.link, raw.detailUrl, raw.href, raw['@id']);
  if (url && baseUrl) { try { url = new URL(url, baseUrl).toString(); } catch { /* keep as-is */ } }

  const offers = raw.offers && typeof raw.offers === 'object'
    ? (Array.isArray(raw.offers) ? raw.offers[0] : raw.offers)
    : null;
  const price = digits(pick(raw.price, raw.salePrice, raw.internetPrice, offers ? offers.price : ''));
  const odometer = digits(pick(
    raw.odometer, raw.mileage, raw.kilometres, raw.kilometers, raw.km,
    raw.mileageFromOdometer && typeof raw.mileageFromOdometer === 'object'
      ? raw.mileageFromOdometer.value
      : raw.mileageFromOdometer
  ));
  const condition = pick(raw.condition, raw.itemCondition, raw.vehicleCondition, raw.type).toLowerCase();
  const image = pick(
    Array.isArray(raw.image) ? raw.image[0] : raw.image,
    raw.photo, raw.thumbnail, raw.primaryImage
  );

  const identifiable = Boolean(stock || vin || url);
  const describable = Boolean((year && model) || title);
  if (!identifiable || !describable) return null;

  return {
    year,
    make,
    model,
    trim,
    stock,
    vin,
    url,
    price,
    odometer,
    image,
    condition,
    title: title || [year, make, model].filter(Boolean).join(' '),
    key: vehicleKey({ stock, vin, url })
  };
}

export function vehicleKey(vehicle) {
  const stock = pick(vehicle.stock).toUpperCase();
  if (stock) return `STK:${stock}`;
  const vin = pick(vehicle.vin).toUpperCase();
  if (vin) return `VIN:${vin}`;
  const url = pick(vehicle.url);
  return url ? `URL:${url.split('?')[0].replace(/\/$/, '')}` : '';
}

/** Later sources fill gaps in earlier ones; they never blank out a known value. */
export function mergeVehicle(base, extra) {
  const merged = { ...base };
  for (const [field, value] of Object.entries(extra || {})) {
    if (value === null || value === undefined || value === '') continue;
    if (!merged[field]) merged[field] = value;
  }
  merged.key = vehicleKey(merged) || merged.key;
  return merged;
}

/** Enough detail to actually print a label? */
export function isPrintable(vehicle) {
  return Boolean(vehicle && vehicle.url && (vehicle.year || vehicle.model) && (vehicle.stock || vehicle.vin));
}
