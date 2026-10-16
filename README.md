# INSAT AOD → surface PM2.5 (training pipeline)

Trains a model that turns ISRO INSAT-3DR/3DS aerosol optical depth (MOSDAC) plus ERA5 weather into
street-level PM2.5. The model is checked against CPCB ground stations it never saw during training.

```
MOSDAC *_L2G_AOD.h5 ──► match (stations ± 15 km, haversine) ──► station-hour AOD
OpenAQ / CPCB PM2.5 ──► QC (fill values, stuck sensors, spikes, PM2.5 > PM10) ─┐
Open-Meteo ERA5 (BLH, RH, wind, T, rain) + CAMS (PM2.5, AOD) ─────────────────┤
                                                                              ▼
                                     train table ──► LightGBM, spatial-block CV, baselines, SHAP
```

## Results: INSAT-3DR, Oct 2025 – Jan 2026

855 L2G AOD scans, 182,232 station-hours from 505 CPCB stations (via OpenAQ), ERA5 weather and CAMS.
All scores are on stations the model never trained on, over all scan hours.

| model | spatial CV R² | RMSE (µg/m³) | January hold-out R² | RMSE |
|---|---|---|---|---|
| CAMS PM2.5 as-is | 0.187 | 48.8 | 0.080 | 43.9 |
| v1: weather + CAMS + INSAT AOD | 0.249 | 46.9 | 0.105 | 43.3 |
| v2: weather + CAMS, no satellite | 0.300 | 45.2 | −0.019 | 46.2 |
| **v2: + INSAT AOD + satellite context** | **0.380** | **42.6** | **0.404** | **35.3** |

Spatial CV holds out whole 1° blocks (about 100 km); the hold-out trains on Oct–Dec and tests on January.
v2 adds satellite context features (50 km, daily and seasonal AOD), two monotone physics constraints and
larger trees; each change was tested on its own (`runs/ablation.json`). The seasonal AOD climatology became
the second strongest driver after CAMS. Full report: [`runs/winter_v2/report.md`](runs/winter_v2/report.md).

## What the MOSDAC AOD product actually is

These facts come from MOSDAC's public catalog, its AOD algorithm document (ATBD v3), and its product format document:

- Datasets: `3RIMG_L2G_AOD` (INSAT-3DR) and `3SIMG_L2G_AOD` (INSAT-3DS), about **7 scans per day**.
  Files look like `3RIMG_01DEC2025_0845_L2G_AOD_V02R00.h5`. **Time is UTC.**
- Oct 2025 – Jan 2026 has 855 INSAT-3DR files and 848 INSAT-3DS files, as of 16 Oct 2026.
- **Wavelength and resolution conflict between sources.** The catalog says AOD at **650 nm, 4 km**; the ATBD says
  **550 nm, 0.1° (~10 km)**. `inspect` on a real file settles it, and the pipeline works with either grid.
- **Daytime and cloud-free only.** Bright surfaces such as the Thar Desert are masked.
- It has **no Ångström exponent or single-scattering albedo**: the imager has one visible channel.

Run `python -m aqpipe inspect <file>.h5` on your first real file. If the dataset names differ from
`AOD` / `latitude` / `longitude`, edit `AOD_NAMES` / `LAT_NAMES` / `LON_NAMES` in `aqpipe/mosdac.py`.

## Setup

```bash
./setup_env.sh
```

This creates `.venv`. On a Mac without Homebrew's `libomp`, it points LightGBM at the OpenMP library
that scikit-learn already ships, so `brew` isn't needed.

## Run it on real data

**1. Satellite AOD.** Sign up at https://mosdac.gov.in/signup/. New accounts need approval before they can download.
Then open `tools/mosdac/config.json` and replace the two `PUT_YOUR_...` placeholders with your MOSDAC username and password.
It is already set to INSAT-3DR L2G AOD for Oct 2025 – Jan 2026, saving into `data/mosdac/`. Then run MOSDAC's own downloader:

```bash
cd tools/mosdac && ../../.venv/bin/python mdapi.py
```

Answer `Y` when it shows the file count. MOSDAC allows 5,000 files per day, and three wrong passwords lock the
account for an hour. Your password stays in that file on your Mac; don't share or commit it.

**2. Ground truth.** Get a free OpenAQ API key at https://explore.openaq.org/register. OpenAQ mirrors the
CPCB CAAQMS stations. Save the key as the only line of `openaq_key.txt` in this folder, or set `OPENAQ_API_KEY`. Then:

```bash
.venv/bin/python -m aqpipe openaq-stations --out data/stations.csv
.venv/bin/python -m aqpipe openaq-fetch --start 2025-10-01 --end 2026-01-31
```

A location can have several PM2.5 sensors (308 of the 513 active ones do, typically an old and a current feed).
The download tries the newest first and falls back to the others. OpenAQ answers each page in ~15 s, so requests
run on 10 threads under one shared rate limit; 513 stations over 4 months take roughly an hour.
Results are cached in `data/cache/`, so re-runs are free. If you download CPCB CCR files yourself instead,
reshape them to a CSV with `station_id, time_ist, pm25[, pm10]` columns. Then pass that file as `--truth`,
with a matching `stations.csv` (`station_id, lat, lon`).

**2b. No-satellite baseline (needs no MOSDAC data).** This trains weather + CAMS on real stations, using the
same spatial-block tests as the satellite model. Its score is the bar the INSAT model has to beat:

```bash
.venv/bin/python -m aqpipe baseline                 # 06-09 UTC, the hours INSAT AOD exists
.venv/bin/python -m aqpipe baseline --all-hours --out runs/baseline_24h
```

**Spike filter.** Some CPCB sensors jump from ~30 to ~950 µg/m³ and straight back within an hour. A reading is
dropped when it is ≥ 4× its station's centred 13-hour rolling median **and** ≥ 150 µg/m³ above it. It is kept
when nearby stations show the same event: within 50 km at that hour, they read ≥ 2× their own baselines, or at least
40% of the reading's value. That keeps Diwali night in Delhi (77 of 77 readings above 500 µg/m³ kept) while removing
1,748 glitches (0.16% of the data). On the Oct 2025 – Jan 2026 data it cut Cuddalore's RMSE from 173 to 18 µg/m³.

**Time alignment.** CPCB averages over IST clock hours, i.e. hh:30–hh+1:30 UTC. Every station average is labelled
by its centre, a whole UTC hour. That is the same instant as the ERA5 and CAMS fields. A satellite scan is assigned to the
average window that contains it, allowing ~9 min for the full-disk scan to reach India.

Weather and CAMS are fetched once per model grid cell (ERA5 0.25°, CAMS 0.4°) instead of once per station.
That roughly halves the Open-Meteo calls; the free tier allows 10,000 weighted calls a day.

**3. Match, build, add satellite context, train.**

```bash
.venv/bin/python -m aqpipe match --aod-dir data/mosdac --satellite 3R
.venv/bin/python -m aqpipe build          # QC + ERA5 + CAMS from Open-Meteo, cached
.venv/bin/python -m aqpipe context --aod-dir data/mosdac --satellite 3R   # 50 km, daily and seasonal AOD
.venv/bin/python -m aqpipe train --table data/train_table_context.csv --out runs/winter_v2
.venv/bin/python -m aqpipe train --out runs/winter_v1   # v1: no context features, for comparison
```

`context` adds four features computed only from the AOD files, the same way at a station and at a map cell:
mean AOD within 50 km (`aod_50km`), the location's mean over that day's scans (`aod_day`), its seasonal mean
over every scan (`aod_clim`), and today relative to usual (`aod_anom`). Training also applies two physics
guardrails as monotone constraints: PM2.5 can only rise with CAMS PM2.5 and only fall as the mixing layer deepens.

`runs/<name>/report.md` holds the results, alongside `oof_scatter.png`, `model_comparison.png` and `shap_importance.png`.

Raw lat/lon are **off by default**. Tree models split on them, which paints straight-edged rectangles on the
maps, and the model memorises station locations instead of learning from AOD and weather. Use `--latlon`
only as an ablation.

**4. All-India maps and the web app.**

```bash
.venv/bin/python -m aqpipe predict --aod-dir data/mosdac --model runs/winter_v2 --out maps/winter_v2 \
    --satellite 3R --hours 2025-12-10T06,2025-12-10T08
.venv/bin/python -m aqpipe serve --maps maps/winter_v2 --model runs/winter_v2 \
    --stations data/stations.csv --truth data/pm25_truth.csv
```

Open http://127.0.0.1:8000. `predict` treats every 0.1° land cell like a station: the same 15 km AOD window
and the same features. Sea cells are masked using Natural Earth land polygons, because the model only
saw land stations. Weather comes from a 1° grid (about 1,150 Open-Meteo calls per source for each date range,
cached afterwards) and is interpolated bilinearly. Use `--weather-step 0.5` for finer detail, at about four times the calls.

Open http://127.0.0.1:8000 for **Airscope**, the React app in `web/`, served from its build in `web/dist`.
- **Loading screen:** drifting aurora behind the scope logo with an orbiting satellite. India's outline is traced
  while a scanner sweeps across it, and the steps tick off as the real data loads (scan hours → grid cells →
  hexagons → stations). Then the map flies in to India.
- **Map:** India from its own official outline (Natural Earth, India's point of view), neighbouring land as a dim,
  label-free backdrop, and predictions masked to India. Colours: mint → gold → orange → red → magenta for PM2.5
  (lightness falls steadily), teal for the satellite layers, teal ↔ magenta for the Δ layer.
- **Themes:** Deep atmosphere (dark) and Mist (light), with an emerald accent and an aurora gradient for the brand.
- **Motion (framer-motion):**
  - a layer pill that slides between options
  - a headline number that counts to each new value
  - a spring-in location panel (a swipe-to-dismiss bottom sheet on phones)
  - a scale-in search window with staggered results
  - cross-fading captions and expanding sections

  All of it respects the system's reduced-motion setting.
- Search (`/` or ⌘K), info (`?`) with held-out skill and a stations table, shareable links, keyboard shortcuts,
  and a phone layout.

Working on the frontend needs Node.js. It is installed at `~/.local/node`, with no admin rights needed:

```bash
export PATH="$HOME/.local/node/current/bin:$PATH"
cd web && npm run dev     # http://localhost:5173, with /api forwarded to the server on :8765
cd web && npm run build   # writes web/dist, which the server serves at /
```

The previous plain-JavaScript version is at `/lite`.
The earlier Leaflet version is still at `/classic`. It has:
- a layer switcher: ML PM2.5, CAMS PM2.5, ML without satellite, and raw INSAT AOD
- a toggle that shows only cells where the satellite saw the ground
- station dots showing observed vs predicted values
- a click-anywhere inspector with the predicted value and its NAQI category, the inputs, and a SHAP breakdown of why
- a low-confidence warning more than 150 km from any training station

Maps only exist for satellite scan hours (daytime). Night-time maps need a model trained without AOD on all hours.

**Basemap:** no tile server. Land comes from Natural Earth (110m) and India's outline from Natural Earth's
India point-of-view boundary, both bundled in `web/public/`.

## Airscope web app

The frontend in `web/` is React 19 + Vite, MapLibre GL for the map, deck.gl for stations and labels,
three.js / React Three Fiber for the loading-screen globe, and framer-motion for UI motion.

```bash
cd web && npm install && npm run build      # builds web/dist, which `aqpipe serve` serves at /
.venv/bin/python -m aqpipe serve --maps maps/winter_v1 --model runs/winter_v1 \
    --stations data/stations.csv --truth data/pm25_truth.csv --port 8765
```

Open http://localhost:8765. Add `?splash` to the URL to hold the loading screen for review.
For frontend work, `npm run dev` in `web/` proxies `/api` to the Python server.

## How to read the report

- **Spatial-block CV:** whole 1°×1° blocks (about 100 km) are held out together. Delhi's dozens of stations can't leak into each other's test folds.
- **Same rows, four models:**
  - CAMS as-is
  - a linear fit of PM2.5 on AOD
  - LightGBM without the satellite
  - LightGBM with the satellite

  The satellite is worth something only if the last row beats the third.
- **"AOD missing" rows** are cloudy or bright-surface hours. They show how the model performs when it falls back on weather + CAMS.
- **The AOD proxy table** shows, before any ML, whether dividing AOD by the boundary-layer height and by humidity swelling, f(RH), makes it track PM2.5 better. It also shows which γ fits best. Pass that γ to `build --gamma`.
- **If the `--latlon` ablation scores much higher,** the extra skill comes from memorising station places. It won't carry over to unmonitored areas.
- **Station errors:** check the stations with the largest errors first. Those are usually sensor faults or unusual sites.

**Caveat:** almost all CPCB stations are urban. Good held-out scores show the model works in
*unmonitored urban areas*. They don't prove it works in villages.

## Synthetic smoke test

`python -m aqpipe synthetic` writes **simulated** AOD files in the documented L2G layout, plus simulated station
PM2.5 at 40 city coordinates. The weather and CAMS it uses are real. Use it to check the code, never as a result.
`runs/synthetic_smoke_test/` is the output of that test. To see the app on synthetic data:

```bash
.venv/bin/python -m aqpipe predict --aod-dir data/synthetic/mosdac --model runs/synthetic_smoke_test \
    --out maps/synthetic --hours 2025-11-14T06,2025-11-14T07 --cache data/synthetic/cache --note "Synthetic demo"
.venv/bin/python -m aqpipe serve --maps maps/synthetic --model runs/synthetic_smoke_test \
    --stations data/synthetic/stations.csv --truth data/synthetic/pm25_truth.csv
```

## Layout

| File | Role |
|---|---|
| `aqpipe/mosdac.py` | HDF5 reader (L2G 1-D grids and L2B 2-D swaths, CF fill/scale), `inspect` |
| `aqpipe/ground.py` | OpenAQ v3 client, tidy CSV loader, PM2.5 QC |
| `aqpipe/openmeteo.py` | ERA5 weather and CAMS at station points, cached |
| `aqpipe/match.py` | Haversine BallTree window sampling, scans → UTC hours |
| `aqpipe/features.py` | Joins and physics features (AOD/BLH, humidity-corrected AOD, AOD − CAMS) |
| `aqpipe/context.py` | Satellite context: 50 km AOD, daily AOD, seasonal AOD climatology and anomaly |
| `aqpipe/train.py` | CV, baselines, out-of-fold SHAP, plots, report, final model |
| `aqpipe/predict.py` | All-India grid prediction per scan hour (`.npz` maps) |
| `aqpipe/landmask.py` | Land/sea mask from Natural Earth |
| `aqpipe/webapp.py` | FastAPI backend: map hours, cells, point inspector, stations |
| `web/` | Airscope frontend (React, MapLibre, deck.gl, three.js) |
