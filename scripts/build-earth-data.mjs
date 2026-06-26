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
  { key: 'temp',   label: 'Global temp anomaly', value: 1.32, unit: '°C',     trend: 'up',   context: 'vs. 1951–1980 mean', source: 'NASA GISTEMP' },
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

// NASA FIRMS — global active-fire detections (VIIRS). Thousands of pixels, so we bin them into
// hotspots and weight severity by fire radiative power (FRP). Needs a free MAP_KEY via env var;
// if unset, it's skipped silently and EONET's (US-centric) wildfires are used instead.
async function firms() {
  const key = process.env.FIRMS_MAP_KEY;
  if (!key) { console.warn('FIRMS: no FIRMS_MAP_KEY set — skipping global fires'); return []; }
  const csv = await getText(`https://firms.modaps.eosdis.nasa.gov/api/area/csv/${key}/VIIRS_SNPP_NRT/world/2`);
  const lines = csv.trim().split('\n');
  if (lines.length < 2) return [];
  const head = lines[0].split(',');
  const iLat = head.indexOf('latitude'), iLon = head.indexOf('longitude'),
        iFrp = head.indexOf('frp'), iConf = head.indexOf('confidence'), iDate = head.indexOf('acq_date');
  if (iLat < 0 || iLon < 0) { console.warn('FIRMS: unexpected CSV header'); return []; }
  const cells = new Map();
  for (let r = 1; r < lines.length; r++) {
    const c = lines[r].split(',');
    const conf = c[iConf];
    if (conf === 'l' || conf === 'L') continue;              // drop low-confidence (VIIRS letter scale)
    if (/^\d+$/.test(conf) && +conf < 50) continue;          // drop low-confidence (MODIS numeric scale)
    const lat = +c[iLat], lon = +c[iLon], frp = +c[iFrp] || 0;
    if (!isFinite(lat) || !isFinite(lon)) continue;
    const gk = Math.round(lat / 1.5) + ',' + Math.round(lon / 1.5);  // ~165 km bins
    let cell = cells.get(gk);
    if (!cell) { cell = { sx: 0, sy: 0, wn: 0, n: 0, frp: 0, date: '' }; cells.set(gk, cell); }
    const w = frp + 1;
    cell.sx += lon * w; cell.sy += lat * w; cell.wn += w;
    cell.n++; cell.frp += frp;
    const d = c[iDate]; if (d > cell.date) cell.date = d;
  }
  const arr = [...cells.values()].filter(c => c.n >= 3);      // need a few detections to count as a hotspot
  arr.sort((a, b) => b.frp - a.frp);
  return arr.slice(0, 22).map((c, i) => {
    const lon = c.sx / c.wn, lat = c.sy / c.wn;
    const sev = c.frp > 600 ? 5 : c.frp > 250 ? 4 : c.frp > 90 ? 3 : c.frp > 30 ? 2 : 1;
    return {
      id: `firms-${i}-${Math.round(lat)}_${Math.round(lon)}`, type: 'wildfire',
      name: 'Active wildfires', place: '',
      lat: +lat.toFixed(3), lon: +lon.toFixed(3), severity: sev,
      date: c.date || new Date().toISOString().slice(0, 10)
    };
  });
}

function dedupeAndCap(events) {
  // guard: only finite, in-range coordinates ever reach the globe (rejects polygon/garbage geometry)
  const valid = events.filter(e =>
    Number.isFinite(e.lat) && Number.isFinite(e.lon) &&
    Math.abs(e.lat) <= 90 && Math.abs(e.lon) <= 180);
  // drop exact id duplicates, then near-duplicates (same type within ~1.2°), keeping higher severity
  const byId = new Set();
  const kept = [];
  for (const e of valid.sort((a, b) => b.severity - a.severity || (a.date < b.date ? 1 : -1))) {
    if (byId.has(e.id)) continue;
    if (kept.some(k => k.type === e.type && Math.abs(k.lat - e.lat) < 1.2 && Math.abs(k.lon - e.lon) < 1.2)) continue;
    byId.add(e.id);
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

  const results = await Promise.allSettled([usgsQuakes(), eonet(), firms()]);
  let events = [];
  const names = ['USGS', 'EONET', 'FIRMS'];
  results.forEach((r, i) => {
    if (r.status === 'fulfilled') { events.push(...r.value); console.log(`${names[i]}: ${r.value.length}`); }
    else console.warn(`${names[i]} failed:`, r.reason?.message);
  });
  if (!events.length && prev.events) { console.warn('all event feeds failed — keeping previous events'); events = prev.events; }
  else {
    // if FIRMS supplied global fires, drop EONET's US-centric wildfires to avoid double coverage
    if (events.some(e => e.id.startsWith('firms-'))) events = events.filter(e => !(e.id.startsWith('eonet-') && e.type === 'wildfire'));
    events = dedupeAndCap(events);
  }

  const climate = await buildClimate(prev.climate);

  const now = new Date();
  const elapsed = (now - new Date(POP_ANCHOR.atISO)) / 1000;
  const data = {
    meta: {
      title: 'Planetary readings',
      updated: now.toISOString().slice(0, 10),
      source: 'USGS · NASA EONET · NASA FIRMS · NOAA · NASA GISTEMP — refreshed daily by GitHub Actions.',
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
