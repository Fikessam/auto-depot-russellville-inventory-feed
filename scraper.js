#!/usr/bin/env node
/**
 * Auto Depot Russellville — Inventory Feed Builder
 * --------------------------------------------------------------------------
 * Tuscaloosa is deliberately NOT included in this repo. It only has ~2
 * vehicles right now (well under a workable minimum for dynamic inventory
 * ads), and this is meant to be a separate feed/repo per location anyway.
 * If/when Tuscaloosa's lot fills out, stand up its own copy of this project
 * rather than re-adding it here — keeps the two feeds, pixels, and catalogs
 * cleanly separated.
 *
 * Unlike scraper.js (Fikes), this does NOT need Puppeteer, stealth, sitemap
 * crawling, or DOM text parsing. Auto Depot's site exposes a plain public
 * JSON endpoint:
 *
 *   https://autodepotrussellville.com/service/inventory/website
 *
 * CONFIRMED (live fetch against Russellville's endpoint, full field list):
 * id, accountId, locationId, stockNo, vin, description, year, make, model,
 * trim, body, style, doors, passengers, interiorColor, exteriorColor,
 * engine, cylinders, transmission, driveTrain, fuel, weight, used, special,
 * certified, titleBranded, frameDamage, forWeb, intialMileage, mileage,
 * price, specialPrice, cashValue, minimumPrice, wholesalePrice,
 * downPayment, paymentAmount, paymentTerm, acquiredOn, soldOn,
 * stockPictures, cityMpg, highwayMpg, options, details, pictures,
 * categories, accountNo.
 *
 * Price is the `price` field (string, e.g. "12995.00" — cast with Number()).
 * Images are the `pictures` field: an array of objects, each with a full
 * absolute `url` (e.g. https://autodepotrussellville.com/service/picture/
 * {accountNo}/{stockNo}/{signature}) — no relative-path handling needed.
 * Both of these were originally guessed before Chrome access was available;
 * both guesses turned out correct on verification, but the resolver
 * functions below are left as-is (checking a candidate list) as a safety
 * net in case Tuscaloosa's schema ever drifts from Russellville's.
 *
 * OUTPUT: same Meta Commerce Manager <listings><listing> XML schema as the
 * Fikes feed (docs/feed-russellville.xml), reusing the field-mapping/XML
 * logic that's already confirmed to work with Commerce Manager for this
 * catalog type.
 * --------------------------------------------------------------------------
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { XMLValidator } = require('fast-xml-parser');

// ============================================================================
// Config — one entry per location
// ============================================================================
const LOCATIONS = [
  {
    key: 'russellville',
    label: 'Auto Depot Russellville',
    inventoryUrl: 'https://autodepotrussellville.com/service/inventory/website',
    siteUrl: 'https://autodepotrussellville.com',
    phone: '256-331-3333',
    address: { street: '16180 Highway 43', city: 'Russellville', state: 'AL', zip: '35653', country: 'US' },
    pixelId: '455178129177209',
  },
];

const OUTPUT_DIR = path.join(__dirname, 'docs');

// Auto Depot Russellville had 13 vehicles at last check. Unlike Fikes'
// threshold of 10 out of a normal 60-70, a flat low number here would defeat
// the point of the guardrail — this is intentionally set lower than Fikes'.
const MIN_EXPECTED_VEHICLES = {
  russellville: 5,
};

// ============================================================================
// Sold-vehicle tracking (ported from the Fikes scraper)
// --------------------------------------------------------------------------
// Meta's Commerce Catalog does NOT automatically remove a vehicle just
// because it disappears from a feed-managed catalog's next fetch — and
// manual deletion in Commerce Manager is blocked for feed-managed catalogs
// (Meta forces edits through the feed). Left alone, a sold vehicle can keep
// showing up in dynamic ads and send clicks to a dead/wrong page.
//
// So: when a vehicle drops out of the live API response, we keep emitting
// it here with availability=SOLD for a few runs (long enough for Meta's
// scheduled sync to pick up the status change), then stop referencing it —
// Meta retains the last-known SOLD status indefinitely once set, so there's
// no need to keep emitting it forever.
const SOLD_GRACE_RUNS = 3;
function soldTrackingPath(location) {
  return path.join(OUTPUT_DIR, `sold-tracking-${location.key}.json`);
}
function vehicleKey(v) {
  return v.stock_number || v.vin;
}

// ============================================================================
// Fetch + field mapping
// ============================================================================
async function fetchLocationInventory(location) {
  console.log(`Fetching inventory: ${location.label} (${location.inventoryUrl})`);
  const res = await fetch(location.inventoryUrl, {
    headers: { accept: 'application/json' },
  });
  if (!res.ok) {
    throw new Error(`${location.label}: HTTP ${res.status} fetching ${location.inventoryUrl}`);
  }
  const data = await res.json();
  if (!Array.isArray(data)) {
    throw new Error(`${location.label}: expected an array from ${location.inventoryUrl}, got ${typeof data}`);
  }
  console.log(`  ${data.length} raw record(s) returned`);
  return data;
}

// Price field name wasn't confirmed before the sample got cut off — try the
// most likely candidates in order. If a record has a genuine $0 price (seen
// on Tuscaloosa's current listings), that's real data, not a missing-field
// problem — don't treat 0 as "not found."
const PRICE_FIELD_CANDIDATES = ['price', 'retailPrice', 'sellingPrice', 'salePrice', 'listPrice', 'webPrice'];
function resolvePrice(raw) {
  for (const field of PRICE_FIELD_CANDIDATES) {
    if (raw[field] !== undefined && raw[field] !== null) {
      return { value: Number(raw[field]), fieldUsed: field };
    }
  }
  return { value: null, fieldUsed: null };
}

// Same situation for images — common candidates for this type of dealer
// inventory API. resolveImages always returns an array (possibly empty).
const IMAGE_FIELD_CANDIDATES = ['images', 'photos', 'pictures', 'photoUrls', 'imageUrls'];
function resolveImages(raw, location) {
  for (const field of IMAGE_FIELD_CANDIDATES) {
    const val = raw[field];
    if (Array.isArray(val) && val.length > 0) {
      // Values might be full URLs already, or relative paths, or objects
      // with a url-like key — handle all three defensively.
      return val
        .map((item) => {
          if (typeof item === 'string') {
            return item.startsWith('http') ? item : `${location.siteUrl}${item.startsWith('/') ? '' : '/'}${item}`;
          }
          if (item && typeof item === 'object') {
            const url = item.url || item.src || item.href || null;
            if (!url) return null;
            return url.startsWith('http') ? url : `${location.siteUrl}${url.startsWith('/') ? '' : '/'}${url}`;
          }
          return null;
        })
        .filter(Boolean);
    }
  }
  // Known fallback: individual vehicle photo URLs were seen in the network
  // log following the pattern /service/picture/{accountId}/{stockNo}/{hash}
  // — if a raw record carries enough of those pieces, this reconstructs one
  // best-guess image URL rather than shipping an empty <image> block.
  if (raw.accountId && raw.stockNo) {
    console.warn(
      `  UNRESOLVED FIELD (images) for stock #${raw.stockNo} — no matching key from [${IMAGE_FIELD_CANDIDATES.join(
        ', '
      )}]. Falling back to picture-service URL pattern; verify this actually resolves.`
    );
  }
  return [];
}

// Confirmed via the site's own "View Details" links: individual vehicle
// pages exist and follow this pattern —
//   /inventory/{accountNo}/view/{stockNo}/{City}-{State}/{year}-{make}-{model}
// `accountNo` is a per-site constant distinct from `accountId`/`locationId`
// (e.g. Tuscaloosa's accountNo is "26539" while its accountId is "1397") —
// it's present on every vehicle record, so no extra config needed per
// location beyond what's already in the API response.
function buildVehicleUrl(raw, location) {
  if (!raw.accountNo || !raw.stockNo) return `${location.siteUrl}/legacy`; // fallback if a record is missing pieces
  const citySlug = `${location.address.city}-${location.address.state}`;
  const nameSlug = [raw.year, raw.make, raw.model].filter(Boolean).join('-').replace(/\s+/g, '-');
  return `${location.siteUrl}/inventory/${raw.accountNo}/view/${raw.stockNo}/${citySlug}/${nameSlug}`;
}

function mapToVehicle(raw, location) {
  const { value: price, fieldUsed } = resolvePrice(raw);
  if (fieldUsed === null) {
    console.warn(`  UNRESOLVED FIELD (price) for stock #${raw.stockNo || raw.id} — raw record:`, JSON.stringify(raw));
  }
  const images = resolveImages(raw, location);
  return {
    vin: raw.vin || null,
    stock_number: raw.stockNo || null,
    condition: raw.used === false ? 'new' : 'used',
    year: raw.year || null,
    make: raw.make || null,
    model: raw.model || null,
    trim: raw.trim || null,
    title: [raw.year, raw.make, raw.model, raw.trim].filter(Boolean).join(' '),
    url: buildVehicleUrl(raw, location),
    exterior_color: raw.exteriorColor || null,
    interior_color: raw.interiorColor || null,
    drivetrain: raw.driveTrain || null,
    transmission: raw.transmission || null,
    engine: raw.engine || null,
    mileage: raw.mileage != null ? Number(raw.mileage) : null,
    fuel_type: raw.fuel || null,
    body_style_raw: raw.body || raw.style || null,
    description: raw.description || null,
    price,
    images,
    dealer_address: location.address,
    dealer_phone: location.phone,
    availability: 'AVAILABLE',
  };
}

// ============================================================================
// Output (reused from scraper.js — same Meta Commerce Manager schema)
// ============================================================================
function escapeXml(value) {
  if (value === null || value === undefined) return '';
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function buildDescription(v) {
  const bits = [];
  if (v.condition === 'used' && v.mileage != null) bits.push(`${v.mileage.toLocaleString()} miles`);
  if (v.exterior_color) bits.push(`${v.exterior_color} exterior`);
  if (v.interior_color) bits.push(`${v.interior_color} interior`);
  if (v.transmission) bits.push(v.transmission);
  if (v.engine) bits.push(v.engine);
  // Auto Depot's raw description field carries the financing/warranty pitch
  // (12.9% financing, Protection Plus) rather than vehicle specs — that's
  // genuinely useful ad copy, so append it rather than discarding it the
  // way Fikes' buildDescription does (Fikes doesn't have this field at all).
  const specLine = bits.length ? bits.join(', ') : v.title;
  return v.description ? `${specLine} — ${v.description}` : specLine;
}

// Adjusted for Auto Depot's actual brands (Honda/Kia/Hyundai/Nissan), unlike
// Fikes' GM-specific hint list.
const SUV_MODEL_HINTS = ['cr-v', 'crv', 'pilot', 'soul', 'santa fe', 'tucson', 'rogue', 'murano', 'kona'];
const VAN_MODEL_HINTS = ['odyssey', 'sienna'];
const PICKUP_MODEL_HINTS = ['ridgeline', 'frontier', 'titan'];
function normalizeBodyStyle(v) {
  const raw = (v.body_style_raw || '').toLowerCase();
  const model = (v.model || '').toLowerCase();
  if (/sedan/.test(raw)) return 'SEDAN';
  if (/(sport utility|suv)/.test(raw)) return 'SUV';
  if (/van/.test(raw)) return 'VAN';
  if (/(pickup|truck)/.test(raw)) return 'PICKUP';
  if (VAN_MODEL_HINTS.some((m) => model.includes(m))) return 'VAN';
  if (PICKUP_MODEL_HINTS.some((m) => model.includes(m))) return 'PICKUP';
  if (SUV_MODEL_HINTS.some((m) => model.includes(m))) return 'SUV';
  // Civic, Elantra, Altima, TLX etc. fall through to here correctly.
  return 'SEDAN';
}

function vehicleToFeedItem(v) {
  const priceStr = v.price != null && v.price > 0 ? `${Number(v.price).toFixed(2)} USD` : '';
  const bodyStyle = normalizeBodyStyle(v);
  const imageBlocks = v.images.map((img) => `    <image>\n      <url>${escapeXml(img)}</url>\n    </image>`).join('\n');
  return `  <listing>
    <vehicle_id>${escapeXml(v.stock_number || v.vin)}</vehicle_id>
    <description>${escapeXml(buildDescription(v))}</description>
    <url>${escapeXml(v.url)}</url>
    <title>${escapeXml(v.title)}</title>
    <body_style>${bodyStyle}</body_style>
    <price>${priceStr}</price>
    <address format="simple">
      <component name="addr1">${escapeXml(v.dealer_address.street)}</component>
      <component name="city">${escapeXml(v.dealer_address.city)}</component>
      <component name="region">${escapeXml(v.dealer_address.state)}</component>
      <component name="postal_code">${escapeXml(v.dealer_address.zip)}</component>
      <component name="country">${escapeXml(v.dealer_address.country)}</component>
    </address>
    <make>${escapeXml(v.make)}</make>
    <model>${escapeXml(v.model)}</model>
    <year>${escapeXml(v.year)}</year>
    <vin>${escapeXml(v.vin)}</vin>
    <state_of_vehicle>${v.condition === 'new' ? 'NEW' : 'USED'}</state_of_vehicle>
    <availability>${v.availability === 'SOLD' ? 'SOLD' : 'AVAILABLE'}</availability>
    <mileage>
      <unit>MI</unit>
      <value>${v.mileage != null ? v.mileage : 0}</value>
    </mileage>
    <transmission>${escapeXml(v.transmission)}</transmission>
    <drivetrain>${escapeXml(v.drivetrain)}</drivetrain>
    <exterior_color>${escapeXml(v.exterior_color)}</exterior_color>
    <interior_color>${escapeXml(v.interior_color)}</interior_color>
    <vehicle_type>car_truck</vehicle_type>
${imageBlocks}
  </listing>`;
}

function loadPreviousVehicles(location) {
  try {
    const prev = JSON.parse(fs.readFileSync(path.join(OUTPUT_DIR, `inventory-${location.key}.json`), 'utf8'));
    return Array.isArray(prev.vehicles) ? prev.vehicles : [];
  } catch (err) {
    return []; // no previous run (first run, or file missing/corrupt) — nothing to diff against
  }
}

function loadSoldTracking(location) {
  try {
    return JSON.parse(fs.readFileSync(soldTrackingPath(location), 'utf8'));
  } catch (err) {
    return {};
  }
}

function saveSoldTracking(location, tracking) {
  fs.writeFileSync(soldTrackingPath(location), JSON.stringify(tracking, null, 2));
}

// Compares this run's scraped vehicles against last run's, marks
// newly-missing vehicles as sold (tracked for SOLD_GRACE_RUNS more runs),
// clears tracking for anything that reappears, and expires tracking once
// the grace period passes. Returns { vehiclesForOutput, updatedTracking } —
// vehiclesForOutput is this run's live vehicles plus any still-in-grace
// sold vehicles (with availability=SOLD), ready to write/feed as-is.
function reconcileSoldVehicles(location, currentVehicles) {
  const previousVehicles = loadPreviousVehicles(location);
  const tracking = loadSoldTracking(location);

  const currentKeys = new Set(currentVehicles.map(vehicleKey));
  const updatedTracking = {};
  const soldVehiclesForOutput = [];

  // 1) Anything already being tracked as sold: if it's back, drop tracking
  //    (treat as a data hiccup, not a real re-sale); otherwise burn one run
  //    off its grace period, and expire it once the grace period runs out.
  for (const [key, entry] of Object.entries(tracking)) {
    if (currentKeys.has(key)) continue; // reappeared — let the live record win, tracking cleared
    if (entry.runsRemaining <= 0) continue; // grace period already expired — stop emitting, drop tracking
    soldVehiclesForOutput.push(entry.vehicle); // this run counts as one of its emissions
    const runsRemaining = entry.runsRemaining - 1;
    if (runsRemaining > 0) {
      updatedTracking[key] = { runsRemaining, vehicle: entry.vehicle };
    } // else: this was its last emission — let it expire, don't add back to tracking
  }

  // 2) Anything that was AVAILABLE last run but isn't tracked yet and isn't
  //    in this run's results is newly sold — start its grace period.
  const previousAvailable = previousVehicles.filter((v) => v.availability !== 'SOLD');
  for (const prevVehicle of previousAvailable) {
    const key = vehicleKey(prevVehicle);
    if (currentKeys.has(key) || updatedTracking[key]) continue; // still here, or already handled above
    const soldSnapshot = { ...prevVehicle, availability: 'SOLD' };
    updatedTracking[key] = { runsRemaining: SOLD_GRACE_RUNS - 1, vehicle: soldSnapshot };
    soldVehiclesForOutput.push(soldSnapshot);
  }

  return {
    vehiclesForOutput: [...currentVehicles, ...soldVehiclesForOutput],
    updatedTracking,
  };
}

function writeLocationOutputs(location, vehicles) {
  if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR, { recursive: true });

  const zeroPriceVehicles = vehicles.filter((v) => !v.price || v.price <= 0);
  if (zeroPriceVehicles.length > 0) {
    console.log(
      `  ${zeroPriceVehicles.length} vehicle(s) at ${location.label} have no usable price (0 or missing): ` +
        zeroPriceVehicles.map((v) => v.stock_number || v.vin).join(', ') +
        ' — these will still appear in inventory JSON but with an empty <price> tag in the feed, which Commerce ' +
        'Manager may reject or display oddly. Fix pricing at the source before this feed goes live.'
    );
  }
  const noImageVehicles = vehicles.filter((v) => v.images.length === 0);
  if (noImageVehicles.length > 0) {
    console.log(
      `  ${noImageVehicles.length} vehicle(s) at ${location.label} have 0 resolved images — excluded from feed.xml.`
    );
  }

  const jsonPath = path.join(OUTPUT_DIR, `inventory-${location.key}.json`);
  fs.writeFileSync(
    jsonPath,
    JSON.stringify({ generated_at: new Date().toISOString(), location: location.label, total_vehicles: vehicles.length, vehicles }, null, 2)
  );

  const feedVehicles = vehicles.filter((v) => v.images.length > 0);
  const items = feedVehicles.map(vehicleToFeedItem).join('\n');
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<!-- ${location.label} — Meta Commerce Manager automotive inventory feed -->
<!-- Pixel ID: ${location.pixelId} — confirmed via Events Manager -->
<listings>
  <title>${escapeXml(location.label)}</title>
${items}
</listings>
`;
  const feedPath = path.join(OUTPUT_DIR, `feed-${location.key}.xml`);
  fs.writeFileSync(feedPath, xml);
  console.log(
    `  Wrote ${vehicles.length} vehicle(s) -> ${jsonPath} and ${feedVehicles.length} vehicle(s) -> ${feedPath}`
  );
  return feedPath;
}

function validateFeedXml(feedPath) {
  const xml = fs.readFileSync(feedPath, 'utf8');
  const result = XMLValidator.validate(xml, { allowBooleanAttributes: true });
  if (result !== true) {
    const { code, msg, line, col } = result.err;
    throw new Error(`${feedPath} failed XML validation: [${code}] ${msg} (line ${line}, col ${col})`);
  }
  console.log(`  ${feedPath} passed XML validation`);
}

// ============================================================================
// Main
// ============================================================================
async function main() {
  for (const location of LOCATIONS) {
    console.log(`\n=== ${location.label} ===`);
    let raw;
    try {
      raw = await fetchLocationInventory(location);
    } catch (err) {
      console.error(`  FAILED to fetch ${location.label}: ${err.message}`);
      continue; // one location failing shouldn't stop the other from running
    }
    const vehicles = raw.map((r) => mapToVehicle(r, location));
    const minExpected = MIN_EXPECTED_VEHICLES[location.key] ?? 1;
    if (vehicles.length < minExpected) {
      console.error(
        `  Only ${vehicles.length} vehicle(s) for ${location.label} — below the safety threshold of ${minExpected}. ` +
          'Refusing to write feed for this location (existing feed file, if any, is left untouched).'
      );
      continue;
    }
    const { vehiclesForOutput, updatedTracking } = reconcileSoldVehicles(location, vehicles);
    const soldCount = vehiclesForOutput.length - vehicles.length;
    if (soldCount > 0) {
      console.log(`  ${soldCount} vehicle(s) still in SOLD grace period, emitted with availability=SOLD`);
    }

    const feedPath = writeLocationOutputs(location, vehiclesForOutput);
    validateFeedXml(feedPath);
    saveSoldTracking(location, updatedTracking);
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error('Fatal error:', err);
    process.exitCode = 1;
  });
}

module.exports = {
  resolvePrice,
  resolveImages,
  mapToVehicle,
  normalizeBodyStyle,
  vehicleToFeedItem,
  buildDescription,
  vehicleKey,
  reconcileSoldVehicles,
};
