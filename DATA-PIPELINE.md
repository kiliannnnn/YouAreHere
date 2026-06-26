# Daily data pipeline

The globe reads `assets/earth-data.json`. This pipeline regenerates that file every day
from authoritative public feeds, so the readings stay current with no backend to run.

## What it does

`scripts/build-earth-data.mjs` (plain Node 20, no npm installs) fetches:

| Reading            | Source                                  | Notes |
|--------------------|-----------------------------------------|-------|
| Earthquakes        | USGS real-time GeoJSON                   | magnitude → severity 1–5 |
| Wildfires (global) | NASA FIRMS (VIIRS active fire)           | needs free MAP_KEY; clustered into hotspots, severity by FRP |
| Storms / volcanoes / floods / drought | NASA EONET v3        | open-event tracker, browser-fetchable |
| CO₂                | NOAA Global Monitoring Lab (Mauna Loa)  | latest monthly mean |
| Temp anomaly       | NASA GISTEMP                            | latest month, °C |
| Sea level / ice / forest | maintained constants              | update from cited sources (slow-moving) |
| Population         | UN WPP anchor + per-second extrapolation| globe tickers it live from `asOf` |

Each feed is fetched in its own try/catch — if one is down, the previous value is kept,
so the file never ends up broken or empty. A final validation step drops any event whose
coordinates aren't finite and in range, so malformed geometry can never reach the globe.

`.github/workflows/update-earth-data.yml` runs the script daily (05:17 UTC) and on demand,
then commits the refreshed JSON back to the repo.

## Setup (one time)

1. Create a GitHub repo and push this project to it (the whole folder is fine).
2. **(Optional, for global wildfires)** Get a free FIRMS map key at
   <https://firms.modaps.eosdis.nasa.gov/api/map_key/> and add it to the repo under
   **Settings → Secrets and variables → Actions → New repository secret**, named `FIRMS_MAP_KEY`.
   Without it, the pipeline still runs and falls back to EONET wildfires (US-centric).
3. In **Settings → Actions → General → Workflow permissions**, choose **Read and write permissions**
   (the workflow already requests `contents: write`, but the repo setting must allow it).
4. Go to the **Actions** tab → **Update Earth Data** → **Run workflow** to do a first run now.
   After that it runs automatically every day.
5. Host the site (e.g. GitHub Pages). The published `earth-data.json` updates itself each day,
   and the globe re-colors on next load.

## Tuning

- **Add/remove sources:** edit the fetch functions in `build-earth-data.mjs`. Each returns an
  array of events in the schema `{ id, type, name, place, lat, lon, severity, date }`.
- **Event types** the globe colors: `wildfire, flood, cyclone, earthquake, drought, heatwave, volcano`.
- **Slow-moving metrics** (sea level, Arctic ice, forest loss): update the `CLIMATE_FALLBACK`
  values from their cited sources a few times a year.
- **Population:** refresh `POP_ANCHOR` yearly from UN World Population Prospects.
- **Cap / density:** `MAX_EVENTS` limits how many dots the globe paints.

## Run it locally

```bash
node scripts/build-earth-data.mjs
```

Writes `assets/earth-data.json` in place. Useful for testing before committing.
