"""FastAPI backend for the map: layers as PNG overlays, click-anywhere inspector with SHAP, stations."""
from __future__ import annotations

import io
import json
from functools import lru_cache
from pathlib import Path

import lightgbm as lgb
import numpy as np
import pandas as pd
from fastapi import FastAPI, HTTPException, Query
from fastapi.middleware.gzip import GZipMiddleware
from fastapi.responses import FileResponse, Response
from fastapi.staticfiles import StaticFiles
from PIL import Image

from .ground import label_by_centre, load_stations, load_truth_csv, qc_pm25

STATIC = Path(__file__).parent / "static"
WEB_DIST = Path(__file__).resolve().parent.parent / "web" / "dist"  # Airscope (React), built with `npm run build` in web/

# Indian National AQI breakpoints for PM2.5 (µg/m³); the colour ramp is anchored on them
NAQI = [(0, "Good"), (30, "Satisfactory"), (60, "Moderate"), (90, "Poor"), (120, "Very poor"), (250, "Severe")]
PM_STOPS = [0, 30, 60, 90, 120, 250, 400]
PM_RAMP = ["#fde3d3", "#f9b996", "#f28c5c", "#eb6834", "#c84f1f", "#9c3a14", "#6e260b"]
AOD_STOPS = [0, 0.25, 0.5, 0.75, 1.0, 1.5, 2.0]
BLUE_RAMP = ["#cde2fb", "#9ec5f4", "#6da7ec", "#3987e5", "#256abf", "#184f95", "#0d366b"]

LAYERS = {
    "pm25": {"label": "ML PM2.5 (satellite model)", "unit": "µg/m³", "stops": PM_STOPS, "ramp": PM_RAMP},
    "cams_pm25": {"label": "CAMS PM2.5 (baseline)", "unit": "µg/m³", "stops": PM_STOPS, "ramp": PM_RAMP},
    "pm25_no_satellite": {"label": "ML PM2.5 without satellite", "unit": "µg/m³", "stops": PM_STOPS, "ramp": PM_RAMP},
    "aod": {"label": "INSAT AOD at 550 nm (raw)", "unit": "", "stops": AOD_STOPS, "ramp": BLUE_RAMP},
}

FRIENDLY = {
    "aod": "Satellite AOD", "aod_nearest": "Satellite AOD", "aod_std": "AOD patchiness nearby",
    "aod_frac_valid": "Cloud-free share of pixels", "aod_over_blh": "AOD ÷ mixing height",
    "aod_corr": "AOD corrected for humidity & mixing height", "aod_minus_cams": "Satellite vs CAMS AOD gap",
    "aod_50km": "Regional haze, 50 km", "aod_day": "Today's haze, all scans", "aod_clim": "Usual haze here (season)",
    "aod_anom": "Today's haze vs usual",
    "boundary_layer_height": "Mixing height (BLH)", "blh_min_12h": "Mixing height, past 12 h",
    "relative_humidity_2m": "Humidity", "temperature_2m": "Temperature", "dew_point_2m": "Humidity",
    "surface_pressure": "Surface pressure", "cloud_cover": "Cloud cover", "u10": "Wind", "v10": "Wind",
    "wind_speed_10m": "Wind", "wind_mean_6h": "Wind", "precip_24h": "Rain, past 24 h",
    "cams_pm25": "CAMS forecast", "cams_pm10": "CAMS forecast", "cams_aod": "CAMS forecast",
    "cams_dust": "CAMS dust", "doy_sin": "Season", "doy_cos": "Season", "hour_ist": "Time of day",
    "lat": "Location", "lon": "Location",
}


def _hex(h: str) -> np.ndarray:
    return np.array([int(h[i : i + 2], 16) for i in (1, 3, 5)], dtype=float)


def colorize(values: np.ndarray, stops, ramp, alpha=205) -> np.ndarray:
    rgb = np.stack([_hex(c) for c in ramp])
    v = np.clip(values, stops[0], stops[-1])
    out = np.zeros(values.shape + (4,), dtype=np.uint8)
    for ch in range(3):
        out[..., ch] = np.interp(v, stops, rgb[:, ch]).astype(np.uint8)
    out[..., 3] = np.where(np.isfinite(values), alpha, 0)
    return out


def naqi_category(pm: float) -> str:
    label = NAQI[0][1]
    for lo, name in NAQI:
        if pm >= lo:
            label = name
    return label


def _merc_y(lat):
    return np.log(np.tan(np.pi / 4 + np.radians(lat) / 2))


def create_app(maps_dir, model_dir, stations_csv=None, truth_csv=None) -> FastAPI:
    maps_dir, model_dir = Path(maps_dir), Path(model_dir)
    booster = lgb.Booster(model_file=str(model_dir / "lgbm_with_insat_aod.txt"))
    stations = load_stations(stations_csv) if stations_csv else None
    truth = None
    if truth_csv:
        truth, _ = qc_pm25(load_truth_csv(truth_csv), stations=stations)
        truth = label_by_centre(truth).set_index(["station_id", "time_utc"])["pm25"]
    metrics_path = model_dir / "metrics.json"
    skill = json.loads(metrics_path.read_text()).get("spatial_cv", []) if metrics_path.exists() else []

    app = FastAPI(title="INSAT PM2.5")
    app.add_middleware(GZipMiddleware, minimum_size=1000)

    @app.middleware("http")
    async def revalidate_app_files(request, call_next):
        # The app's own JS/CSS change during development: make browsers re-check them (ETag) on every load.
        # Vendored libraries are versioned in their file names and can be cached for long.
        response = await call_next(request)
        path = request.url.path
        if path.startswith(("/static/vendor/", "/assets/")):  # versioned / content-hashed file names
            response.headers["Cache-Control"] = "public, max-age=31536000, immutable"
        elif path.startswith("/static/") or path in ("/", "/classic", "/lite") or path.endswith(".geojson"):
            response.headers["Cache-Control"] = "no-cache"
        return response
    app.mount("/static", StaticFiles(directory=STATIC), name="static")

    def files() -> dict[str, Path]:
        return {p.stem: p for p in sorted(maps_dir.glob("*.npz"))}

    @lru_cache(maxsize=6)
    def load(key: str) -> dict:
        path = files().get(key)
        if path is None:
            raise HTTPException(404, f"No map for {key}")
        with np.load(path, allow_pickle=False) as z:
            return {k: z[k] for k in z.files}

    @app.get("/")
    def index():
        # Airscope (React build) when it exists, otherwise the plain-JS version
        built = WEB_DIST / "index.html"
        return FileResponse(built if built.exists() else STATIC / "index.html")

    @app.get("/lite")
    def lite():
        return FileResponse(STATIC / "index.html")

    @app.get("/classic")
    def classic():
        return FileResponse(STATIC / "classic" / "index.html")

    @lru_cache(maxsize=8)
    def cells_payload(key: str) -> bytes:
        m = load(key)
        land = (m["land"] if "land" in m else np.ones(m["pm25"].shape, bool)).ravel()
        idx = np.flatnonzero(land)

        def q(name, scale=1.0):  # compact ints; -1 marks missing
            v = m[name].ravel()[idx].astype(float) * scale
            return np.where(np.isfinite(v), np.round(v), -1).astype(int).tolist()

        return json.dumps({
            "lat0": float(m["lat"][0]), "lon0": float(m["lon"][0]), "step": float(m["step"]),
            "nlon": int(m["lon"].size), "idx": idx.tolist(),
            "pm25": q("pm25"), "pm25_no_satellite": q("pm25_no_satellite"), "cams_pm25": q("cams_pm25"),
            "aod": q("aod", 100), "aod_corr": q("aod_corr", 100),
        }, separators=(",", ":")).encode()

    @app.get("/api/cells/{key}")
    def cells(key: str):
        """Land cells of one map hour: flat grid index + values (AOD x100), for client-side hexagons."""
        return Response(cells_payload(key), media_type="application/json",
                        headers={"Cache-Control": "no-cache"})  # maps get regenerated under the same hour key

    _hour_summary: dict = {}  # (path, mtime) -> hour label, note and median, so the list stays cheap

    @app.get("/api/hours")
    def hours():
        out = []
        for key, path in files().items():
            stamp = (str(path), path.stat().st_mtime)
            if stamp not in _hour_summary:
                with np.load(path, allow_pickle=False) as z:
                    pm = z["pm25"]
                    land = z["land"] if "land" in z.files else np.isfinite(pm)
                    _hour_summary[stamp] = {"hour_utc": str(z["hour"]), "note": str(z["note"]),
                                            "median_pm25": round(float(np.nanmedian(pm[land])), 1)}
            out.append({"key": key, **_hour_summary[stamp]})
        return {"hours": out, "layers": {k: {**v, "naqi": NAQI if v["stops"] is PM_STOPS else None}
                                         for k, v in LAYERS.items()}, "skill": skill}

    @app.get("/api/meta/{key}")
    def meta(key: str):
        m = load(key)
        step = float(m["step"])
        lat, lon = m["lat"], m["lon"]
        land = m["land"] if "land" in m else np.ones(m["pm25"].shape, bool)
        return {
            "bounds": [[float(lat[0] - step / 2), float(lon[0] - step / 2)],
                       [float(lat[-1] + step / 2), float(lon[-1] + step / 2)]],
            "hour_utc": str(m["hour"]),
            "note": str(m["note"]),
            "version": int(files()[key].stat().st_mtime),
            "median_pm25": float(np.nanmedian(m["pm25"][land])),
            "share_cells_with_aod": float(np.isfinite(m["aod"][land]).mean()),
        }

    @app.get("/api/layer/{key}/{layer}.png")
    def layer_png(key: str, layer: str, only_aod: bool = False):
        if layer not in LAYERS:
            raise HTTPException(404, f"Unknown layer {layer}")
        m = load(key)
        vals = m[layer].astype(float)
        if "land" in m:
            vals = np.where(m["land"], vals, np.nan)
        if only_aod:
            vals = np.where(np.isfinite(m["aod"]), vals, np.nan)
        step, lat = float(m["step"]), m["lat"]
        # Rows are resampled to be evenly spaced in Web Mercator so the overlay lines up with the map
        y0, y1 = _merc_y(lat[0] - step / 2), _merc_y(lat[-1] + step / 2)
        height = lat.size * 2
        y = y1 - (np.arange(height) + 0.5) * (y1 - y0) / height
        lat_rows = np.degrees(2 * np.arctan(np.exp(y)) - np.pi / 2)
        src = np.clip(np.floor((lat_rows - (lat[0] - step / 2)) / step).astype(int), 0, lat.size - 1)
        img = colorize(vals[src], LAYERS[layer]["stops"], LAYERS[layer]["ramp"])
        buf = io.BytesIO()
        Image.fromarray(img, "RGBA").save(buf, "PNG", optimize=True)
        return Response(buf.getvalue(), media_type="image/png", headers={"Cache-Control": "max-age=3600"})

    @app.get("/api/point/{key}")
    def point(key: str, lat: float = Query(...), lon: float = Query(...)):
        m = load(key)
        step = float(m["step"])
        i = int(round((lat - float(m["lat"][0])) / step))
        j = int(round((lon - float(m["lon"][0])) / step))
        if not (0 <= i < m["lat"].size and 0 <= j < m["lon"].size):
            raise HTTPException(404, "Outside the map")
        if "land" in m and not m["land"][i, j]:
            raise HTTPException(404, "Over the sea: the model is trained on land stations only")
        cell = i * m["lon"].size + j
        x = m["X"][cell : cell + 1].astype(float)
        contrib = booster.predict(x, pred_contrib=True)[0]
        groups: dict[str, float] = {}
        for name, c in zip([str(f) for f in m["features"]], contrib[:-1]):
            label = FRIENDLY.get(name, name)
            groups[label] = groups.get(label, 0.0) + float(c)
        ranked = sorted(groups.items(), key=lambda kv: -abs(kv[1]))
        top = [{"driver": k, "log_effect": v, "pct": (np.exp(v) - 1) * 100} for k, v in ranked[:7]]
        rest = sum(v for _, v in ranked[7:])

        def val(name):
            v = float(m[name][i, j])
            return None if not np.isfinite(v) else v

        pm = val("pm25")
        nearest = None
        if stations is not None:
            d = _haversine(lat, lon, stations["lat"].to_numpy(), stations["lon"].to_numpy())
            k = int(np.argmin(d))
            sid = stations["station_id"].iloc[k]
            obs = None
            if truth is not None and (sid, pd.Timestamp(str(m["hour"]))) in truth.index:
                obs = float(truth.loc[(sid, pd.Timestamp(str(m["hour"])))])
            nearest = {"station_id": sid, "name": str(stations.get("name", stations["station_id"]).iloc[k]),
                       "km": float(d[k]), "observed": obs}
        return {
            "cell": {"lat": float(m["lat"][i]), "lon": float(m["lon"][j])},
            "pm25": pm, "category": naqi_category(pm) if pm is not None else None,
            "pm25_no_satellite": val("pm25_no_satellite"), "cams_pm25": val("cams_pm25"),
            "aod": val("aod"), "aod_corr": val("aod_corr"),
            "blh": val("boundary_layer_height"), "rh": val("relative_humidity_2m"), "wind": val("wind_speed_10m"),
            "baseline_pm25": float(np.expm1(contrib[-1])),
            "drivers": top, "other_log_effect": rest, "nearest_station": nearest,
        }

    @app.get("/api/stations/{key}")
    def station_values(key: str):
        if stations is None:
            return {"stations": []}
        m = load(key)
        hour = pd.Timestamp(str(m["hour"]))
        step = float(m["step"])
        out = []
        for s in stations.itertuples(index=False):
            i = int(round((s.lat - float(m["lat"][0])) / step))
            j = int(round((s.lon - float(m["lon"][0])) / step))
            if not (0 <= i < m["lat"].size and 0 <= j < m["lon"].size):
                continue
            obs = None
            if truth is not None and (s.station_id, hour) in truth.index:
                obs = float(truth.loc[(s.station_id, hour)])
            pred = float(m["pm25"][i, j])
            out.append({"station_id": s.station_id, "name": getattr(s, "name", s.station_id), "lat": s.lat,
                        "lon": s.lon, "observed": obs, "predicted": pred if np.isfinite(pred) else None})
        return {"stations": out}

    if WEB_DIST.exists():  # last, so /api and the routes above win: serves /assets/* and /*.geojson
        app.mount("/", StaticFiles(directory=WEB_DIST), name="web")
    return app


def _haversine(lat, lon, lats, lons):
    p1, p2 = np.radians(lat), np.radians(lats)
    dphi, dl = p2 - p1, np.radians(lons - lon)
    a = np.sin(dphi / 2) ** 2 + np.cos(p1) * np.cos(p2) * np.sin(dl / 2) ** 2
    return 2 * 6371.0088 * np.arcsin(np.sqrt(a))
