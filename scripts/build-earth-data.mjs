// Builds assets/earth-data.json from authoritative public sources.
// Runs in Node 20+ (global fetch). No npm dependencies.
//
// Design goals:
//  - Each source is fetched in its own try/catch: one failing feed never breaks the file.
//  - On failure, the previous value in earth-data.json is preserved (graceful degradation).
//  - Everything is normalized into the schema the globe already reads.
//
// Run locally:  node scripts/build-earth-data.mjs
// In CI:        see .github/workflows/update-earth-data.yml

import { readFile, writeFile } from 'node:fs/promises';

const OUT = 'assets/earth-data.json';

// ---- config: values that change slowly (monthly/annual) or have no simple JSON API ----
// Update these from the cited sources when new figures are published; the script keeps them
// if it can't fetch a fresher number automatically.
const CLIMATE_FALLBACK = [
  { key: 'temp',   label: 'Global temp anomaly', value: 1.32, unit: '°C',     trend: 'up',   context: 'vs. 1850–1900 average', source: 'NASA GISTEMP' },
  { key: 'co2',    label: 'Atmospheric CO\u2082', value: 426,  unit: 'ppm',    trend: 'up',   context: 'monthly mean',           source: 'NOAA GML, Mauna Loa' },
  { key: 'sea',    label: 'Mean sea level',      value: 104,  unit: 'mm',     trend: 'up',   context: 'rise since 1993',        source: 'NASA Sea Level Change' },
  { key: 'ice',    label: 'Arctic sea ice',      value: 4.2,  unit: 'M km\u00b2', trend: 'down', context: 'annual minimum',       source: 'NSIDC Sea Ice Index' },
  { key: 'forest', label: 'Tree cover loss',     value: 3.7,  unit: 'M ha',   trend: 'up',   context: 'past year',              source: 'Global Forest Watch' }
];

// UN World Population Prospects anchor — refresh yearly. Globe extrapolates per-second from asOf.
const POP_ANCHOR = { atISO: '2025-01-01T00:00:00Z', count: 8_092_000_000, perSecond: 2.3 };

const TYPES = ['wildfire','flood','cyclone','earthquake','drought','heatwave','volcano'];
const MAX_EVENTS = 40;

async function getJSON(url, opts) {
  const r = await fetch(url, { headers: { 'user-agent': 'dot-earth-data-bot' }, ...opts });
  if (!r.ok) throw new Error(`${r.status} ${url}`);
  return r.json();
}
async function getText(url) {
  const r = await fetch(url, { headers: { 'user-agent': 'dot-earth-data-bot' } });
  if (!r.ok) throw new Error(`${r.status} ${url}`);
  return r.text();
}

// ---------- EVENTS ----------

// USGS — earthquakes (reliable real-time GeoJSON, no key, CORS-enabled)
async function usgsQuakes() {
  const d = await getJSON('https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/4.5_day.geojson');
  return (d.features || []).map(f => {
    const [lon, lat] = f.geometry.coordinates;
    const mag = f.properties.mag ?? 0;
    const sev = mag >= 7 ? 5 : mag >= 6.5 ? 4 : mag >= 6 ? 3 : mag >= 5.2 ? 2 : 1;
    return {
      id: 'usgs-' + f.id, type: 'earthquake',
      name: `M${mag.toFixed(1)} earthquake`,
      place: (f.properties.place || '').replace(/^\d+\s*km.*?of\s*/i, ''),
      lat, lon, severity: sev,
      date: new Date(f.properties.time).toISOString().slice(0, 10)
    };
  });
}

// NASA EONET — wildfires, storms, volcanoes, floods, drought (open JSON tracker)
const EONET_MAP = {
  wildfires: 'wildfire', severeStorms: 'cyclone', volcanoes: 'volcano',
  floods: 'flood', drought: 'drought'
};
async function eonet() {
  const d = await getJSON('https://eonet.gsfc.nasa.gov/api/v3/events?status=open&days=21&limit=200');
  const out = [];
  for (const e of d.events || []) {
    const catId = e.categories?.[0]?.id;
    const type = EONET_MAP[catId];
    if (!type) continue;
    const g = e.geometry?.[e.geometry.length - 1];
    if (!g?.coordinates) continue;
    const [lon, lat] = g.coordinates;
    // storms carry a wind/pressure magnitude; use it to scale severity when present
    let sev = type === 'cyclone' ? 3 : type === 'volcano' ? 2 : 3;
    const m = g.magnitudeValue;
    if (type === 'cyclone' && typeof m === 'number') sev = m >= 115 ? 5 : m >= 95 ? 4 : m >= 75 ? 3 : 2;
    out.push({
      id: 'eonet-' + e.id, type,
      name: e.title, place: '', lat, lon, severity: sev,
      date: (g.date || new Date().toISOString()).slice(0, 10)
    });
  }
  return out;
}

// GDACS — multi-hazard alert levels (green/orange/red). Optional; skipped silently on failure.
const GDACS_MAP = { EQ: 'earthquake', TC: 'cyclone', FL: 'flood', DR: 'drought', VO: 'volcano', WF: 'wildfire' };
async function gdacs() {
  const d = await getJSON('https://www.gdacs.org/gdacsapi/api/events/geteventlist/MAP');
  return (d.features || []).map(f => {
    const p = f.properties || {};
    const type = GDACS_MAP[p.eventtype];
    if (!type) return null;
    const [lon, lat] = f.geometry.coordinates;
    const sev = p.alertlevel === 'Red' ? 5 : p.alertlevel === 'Orange' ? 3 : 2;
    return {
      id: 'gdacs-' + p.eventid, type,
      name: p.name || p.htmldescription || `${type} event`,
      place: p.country || '', lat, lon, severity: sev,
      date: (p.fromdate || new Date().toISOString()).slice(0, 10)
    };
  }).filter(Boolean);
}

function dedupeAndCap(events) {
  // drop near-duplicates (same type within ~1.2°) keeping the higher severity
  const kept = [];
  for (const e of events.sort((a, b) => b.severity - a.severity || (a.date < b.date ? 1 : -1))) {
    if (kept.some(k => k.type === e.type && Math.abs(k.lat - e.lat) < 1.2 && Math.abs(k.lon - e.lon) < 1.2)) continue;
    kept.push(e);
    if (kept.length >= MAX_EVENTS) break;
  }
  return kept;
}

// ---------- CLIMATE ----------

// NOAA Mauna Loa — latest global CO2 monthly mean (whitespace text file)
async function co2ppm() {
  const txt = await getText('https://gml.noaa.gov/webdata/ccgg/trends/co2/co2_mm_gl.txt');
  const rows = txt.split('\n').filter(l => l && !l.startsWith('#'));
  const last = rows[rows.length - 1].trim().split(/\s+/);
  const val = parseFloat(last[3]); // year month decimal average ...
  if (!isFinite(val)) throw new Error('co2 parse');
  return Math.round(val);
}

// NASA GISTEMP — latest global temperature anomaly (CSV, °C vs 1951–1980; rebased note in context)
async function tempAnomaly() {
  const csv = await getText('https://data.giss.nasa.gov/gistemp/tabledata_v4/GLB.Ts+dSST.csv');
  const lines = csv.split('\n').filter(l => /^\d{4},/.test(l));
  const last = lines[lines.length - 1].split(',');
  // columns 1..12 are monthly anomalies; take the latest non-empty month
  for (let i = 12; i >= 1; i--) {
    const v = parseFloat(last[i]);
    if (isFinite(v)) return Math.round(v * 100) / 100; // already °C vs 1951–1980
  }
  throw new Error('temp parse');
}

async function buildClimate(prev) {
  const out = CLIMATE_FALLBACK.map(m => ({ ...m }));
  const set = (key, value) => { const m = out.find(x => x.key === key); if (m) m.value = value; };
  // start from whatever the previous file had, so unfetched metrics persist
  for (const m of out) { const p = prev?.find(x => x.key === m.key); if (p) m.value = p.value; }
  await Promise.allSettled([
    co2ppm().then(v => set('co2', v)).catch(e => console.warn('co2:', e.message)),
    tempAnomaly().then(v => set('temp', v)).catch(e => console.warn('temp:', e.message))
  ]);
  return out;
}

// ---------- MAIN ----------

async function main() {
  let prev = {};
  try { prev = JSON.parse(await readFile(OUT, 'utf8')); } catch {}

  const results = await Promise.allSettled([usgsQuakes(), eonet(), gdacs()]);
  let events = [];
  const names = ['USGS', 'EONET', 'GDACS'];
  results.forEach((r, i) => {
    if (r.status === 'fulfilled') { events.push(...r.value); console.log(`${names[i]}: ${r.value.length}`); }
    else console.warn(`${names[i]} failed:`, r.reason?.message);
  });
  if (!events.length && prev.events) { console.warn('all event feeds failed — keeping previous events'); events = prev.events; }
  else events = dedupeAndCap(events);

  const climate = await buildClimate(prev.climate);

  const now = new Date();
  const elapsed = (now - new Date(POP_ANCHOR.atISO)) / 1000;
  const data = {
    meta: {
      title: 'Planetary readings',
      updated: now.toISOString().slice(0, 10),
      source: 'USGS · NASA EONET · GDACS · NOAA · NASA GISTEMP — refreshed daily by GitHub Actions.',
      note: 'Disaster dots warm toward the dominant nearby event hue; severity (1–5) drives the blend.'
    },
    population: {
      asOf: now.toISOString(),
      count: Math.round(POP_ANCHOR.count + POP_ANCHOR.perSecond * elapsed),
      perSecond: POP_ANCHOR.perSecond
    },
    climate,
    events
  };

  await writeFile(OUT, JSON.stringify(data, null, 2) + '\n');
  console.log(`Wrote ${OUT}: ${events.length} events, ${climate.length} metrics.`);
}

main().catch(e => { console.error(e); process.exit(1); });
