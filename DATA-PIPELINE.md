# Daily data pipeline

The globe reads `assets/earth-data.json`. This pipeline regenerates that file every day
from authoritative public feeds, so the readings stay current with no backend to run.

## What it does

`scripts/build-earth-data.mjs` (plain Node 20, no npm installs) fetches:

| Reading            | Source                                  | Notes |
|--------------------|-----------------------------------------|-------|
| Earthquakes        | USGS real-time GeoJSON                   | magnitude → severity 1–5 |
| Wildfires / storms / volcanoes / floods / drought | NASA EONET v3 | open-event tracker |
| Multi-hazard alerts| GDACS (optional)                        | green/orange/red → severity |
| CO₂                | NOAA Global Monitoring Lab (Mauna Loa)  | latest monthly mean |
| Temp anomaly       | NASA GISTEMP                            | latest month, °C |
| Sea level / ice / forest | maintained constants              | update from cited sources (slow-moving) |
| Population         | UN WPP anchor + per-second extrapolation| globe tickers it live from `asOf` |

Each feed is fetched in its own try/catch — if one is down, the previous value is kept,
so the file never ends up broken or empty.

`.github/workflows/update-earth-data.yml` runs the script daily (05:17 UTC) and on demand,
then commits the refreshed JSON back to the repo.

## Setup (one time)

1. Create a GitHub repo and push this project to it (the whole folder is fine).
2. In **Settings → Actions → General → Workflow permissions**, choose **Read and write permissions**
   (the workflow already requests `contents: write`, but the repo setting must allow it).
3. Go to the **Actions** tab → **Update Earth Data** → **Run workflow** to do a first run now.
   After that it runs automatically every day.
4. Host the site (e.g. GitHub Pages). The published `earth-data.json` updates itself each day,
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
