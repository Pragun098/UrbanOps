/**
 * Region (state/province) resolution for jurisdiction.
 *
 * Every issue gets a region from its coordinates, e.g.
 *   { key: "india/karnataka", name: "Karnataka, India" }
 * Admins and dispatchers are scoped to one region key.
 *
 * Default resolver: OpenStreetMap Nominatim reverse geocoding at state level.
 * To respect Nominatim's usage policy (≤1 req/s, identify the app), lookups are
 *  - cached per geohash-4 cell (~20 x 20 km), so a city costs a handful of calls ever;
 *  - serialised with a minimum gap between requests.
 * If the lookup fails, the issue is filed under "unassigned"; the superadmin sees
 * those and nothing is lost.
 *
 * Tests replace the resolver with setResolver() so they never touch the network.
 */

const ngeohash = require('ngeohash');

const UNASSIGNED = Object.freeze({ key: 'unassigned', name: 'Unassigned' });
const NOMINATIM_URL = process.env.NOMINATIM_URL || 'https://nominatim.openstreetmap.org/reverse';
const USER_AGENT = process.env.NOMINATIM_USER_AGENT || 'UrbanOps/1.0 (civic issue dispatch; student project)';
const MIN_GAP_MS = 1100;
const CACHE_MAX = 5000;

/** "Tamil Nādu" → "tamil-nadu" */
const slug = (s) =>
  String(s || '')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');

/** Build a region from human names. Same function for invites and for issues, so keys always match. */
const makeRegion = (state, country) => {
  const s = String(state || '').trim();
  const c = String(country || '').trim();
  if (!s || !c) return UNASSIGNED;
  return { key: `${slug(c)}/${slug(s)}`, name: `${s}, ${c}` };
};

const isValidRegionKey = (key) => typeof key === 'string' && /^[a-z0-9-]+\/[a-z0-9-]+$/.test(key);

// ---- default resolver: Nominatim, rate-limited

let lastCall = 0;
let queue = Promise.resolve();

const nominatimResolver = (lat, lng) => {
  const run = async () => {
    const wait = lastCall + MIN_GAP_MS - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    lastCall = Date.now();

    const url = `${NOMINATIM_URL}?format=jsonv2&zoom=5&addressdetails=1&lat=${lat}&lon=${lng}`;
    const res = await fetch(url, {
      headers: { 'User-Agent': USER_AGENT, 'Accept-Language': 'en' },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) throw new Error(`Nominatim ${res.status}`);
    const data = await res.json();
    const a = data.address || {};
    const state = a.state || a.province || a.region || a.state_district || a.territory || a.county;
    return makeRegion(state, a.country);
  };
  // Serialise calls so the gap is honoured even under concurrent reports.
  const result = queue.then(run, run);
  queue = result.catch(() => undefined);
  return result;
};

let resolver = nominatimResolver;
const cache = new Map();

/** Replace the resolver (tests) — fn(lat, lng) → Promise<{key, name}>. Clears the cache. */
const setResolver = (fn) => {
  resolver = fn || nominatimResolver;
  cache.clear();
};

/**
 * Region for a point. Never throws: failures return UNASSIGNED (not cached, so
 * the next report in that cell retries).
 */
const resolveRegion = async (lat, lng) => {
  const cell = ngeohash.encode(lat, lng, 4);
  if (cache.has(cell)) return cache.get(cell);
  try {
    const region = await resolver(lat, lng);
    if (region && region.key !== UNASSIGNED.key) {
      if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value);
      cache.set(cell, region);
    }
    return region || UNASSIGNED;
  } catch (err) {
    if (process.env.NODE_ENV !== 'test') console.warn('[Regions] lookup failed:', err.message);
    return UNASSIGNED;
  }
};

module.exports = { resolveRegion, setResolver, makeRegion, slug, isValidRegionKey, UNASSIGNED };
