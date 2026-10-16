"""All-India PM2.5 maps: apply a trained model to every grid cell for each satellite scan hour.

Each output cell is treated exactly like a station during training: the same 15 km AOD window,
the same scan-to-hour aggregation and the same features. Weather and CAMS are fetched on a
coarse grid (Open-Meteo counts every point as one API call) and interpolated bilinearly.
"""
from __future__ import annotations

import json
from pathlib import Path

import lightgbm as lgb
import numpy as np
import pandas as pd
from scipy.interpolate import RegularGridInterpolator

from .features import CAMS_RENAME, add_physics, add_time_features
from .landmask import india_mask, land_mask
from .match import StationMatcher, scan_hour, to_hourly
from .mosdac import INDIA_BBOX, list_aod_files, parse_filename, read_aod
from .openmeteo import add_met_derived, fetch_points

GRID_VARS = [
    "boundary_layer_height", "blh_min_12h", "relative_humidity_2m", "temperature_2m", "dew_point_2m",
    "surface_pressure", "cloud_cover", "u10", "v10", "wind_speed_10m", "wind_mean_6h", "precip_24h",
    "cams_pm25", "cams_pm10", "cams_aod", "cams_dust",
]
MAP_LAYERS = ["pm25", "pm25_no_satellite", "cams_pm25", "aod", "aod_corr",
              "boundary_layer_height", "relative_humidity_2m", "wind_speed_10m"]


def axis(lo: float, hi: float, step: float) -> np.ndarray:
    return np.round(np.arange(lo, hi + step / 2, step), 4)


def fetch_grid_weather(bbox, step: float, start: str, end: str, cache_dir) -> tuple[np.ndarray, np.ndarray, pd.DataFrame]:
    # Snap outwards so every map cell lies inside the weather grid: interpolation, never extrapolation
    snap = lambda lo, hi: axis(np.floor(lo / step) * step, np.ceil(hi / step) * step, step)  # noqa: E731
    lat_ax, lon_ax = snap(bbox[0], bbox[1]), snap(bbox[2], bbox[3])
    LON, LAT = np.meshgrid(lon_ax, lat_ax)
    pts = pd.DataFrame({"lat": LAT.ravel(), "lon": LON.ravel()})
    pts["station_id"] = [f"grid{step:g}_{la:.2f}_{lo:.2f}" for la, lo in zip(pts["lat"], pts["lon"])]
    print(f"Fetching ERA5 + CAMS on a {step}° grid ({len(pts)} points, {start}..{end}); cached after the first run")
    met = add_met_derived(fetch_points("era5", pts, start, end, cache_dir, batch=100, snap=False))
    cams = fetch_points("cams", pts, start, end, cache_dir, batch=100, snap=False).rename(columns=CAMS_RENAME)
    wx = met.merge(cams, on=["station_id", "time_utc"], how="left").merge(pts, on="station_id")
    return lat_ax, lon_ax, wx


def interpolate_hour(wx: pd.DataFrame, lat_ax, lon_ax, hour: pd.Timestamp, cell_lat, cell_lon) -> pd.DataFrame:
    w = wx[wx["time_utc"] == hour]
    if w.empty:
        raise ValueError(f"No weather for {hour}; is the date inside the fetched range?")
    i = np.searchsorted(lat_ax, w["lat"].round(4))
    j = np.searchsorted(lon_ax, w["lon"].round(4))
    out = {}
    for var in GRID_VARS:
        grid = np.full((lat_ax.size, lon_ax.size), np.nan)
        grid[i, j] = w[var].to_numpy(dtype=float)
        f = RegularGridInterpolator((lat_ax, lon_ax), grid, bounds_error=True)
        out[var] = f(np.c_[cell_lat, cell_lon])
    return pd.DataFrame(out)


def predict_maps(
    aod_dir,
    model_dir,
    out_dir,
    hours: list[str] | None = None,
    bbox=INDIA_BBOX,
    step: float = 0.1,
    weather_step: float = 1.0,
    satellite: str | None = None,
    cache_dir="data/cache",
    note: str = "",
) -> list[Path]:
    model_dir, out_dir = Path(model_dir), Path(out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    spec = json.loads((model_dir / "features.json").read_text())
    sets, prep = spec["feature_sets"], spec.get("preprocessing", {})
    models = {k: lgb.Booster(model_file=str(model_dir / f"{k}.txt")) for k in sets}

    files = list_aod_files(aod_dir)
    if satellite:
        files = [f for f in files if parse_filename(f)[1] == satellite.upper()]
    by_hour: dict[pd.Timestamp, list[Path]] = {}
    for f in files:
        by_hour.setdefault(scan_hour(parse_filename(f)[0]), []).append(f)
    wanted = sorted(by_hour) if not hours else [pd.Timestamp(h).floor("h") for h in hours]
    missing = [h for h in wanted if h not in by_hour]
    if missing:
        raise SystemExit(f"No AOD files for hour(s): {', '.join(str(m) for m in missing)}")
    if not wanted:
        raise SystemExit(f"No AOD files under {aod_dir}")

    lat_ax, lon_ax = axis(bbox[0], bbox[1], step), axis(bbox[2], bbox[3], step)
    LON, LAT = np.meshgrid(lon_ax, lat_ax)
    cells = pd.DataFrame({"station_id": np.arange(LAT.size), "lat": LAT.ravel(), "lon": LON.ravel()})
    matcher = StationMatcher(cells, radius_km=float(prep.get("radius_km", 15.0)))

    start = (min(wanted) - pd.Timedelta(days=1)).strftime("%Y-%m-%d")
    end = max(wanted).strftime("%Y-%m-%d")
    w_lat, w_lon, wx = fetch_grid_weather(bbox, weather_step, start, end, cache_dir)
    # Map only India (its own official boundary); the model never saw stations elsewhere
    land = land_mask(LAT, LON, cache_dir) & india_mask(LAT, LON, cache_dir)

    written = []
    for hour in wanted:
        samples = pd.concat([matcher.sample(read_aod(f, bbox=bbox)) for f in by_hour[hour]], ignore_index=True)
        aod = to_hourly(samples).set_index("station_id").reindex(cells["station_id"])
        df = pd.concat(
            [cells.reset_index(drop=True),
             aod[["aod", "aod_nearest", "aod_std", "aod_frac_valid"]].reset_index(drop=True),
             interpolate_hour(wx, w_lat, w_lon, hour, cells["lat"], cells["lon"])],
            axis=1,
        )
        df["time_utc"] = hour
        df = add_time_features(add_physics(df, float(prep.get("gamma", 0.5))))
        full = sets["lgbm_with_insat_aod"]
        X = df[full].to_numpy(dtype=np.float32)
        df["pm25"] = np.expm1(models["lgbm_with_insat_aod"].predict(X))
        df["pm25_no_satellite"] = np.expm1(models["lgbm_no_satellite"].predict(df[sets["lgbm_no_satellite"]].to_numpy(np.float32)))
        shape = LAT.shape
        path = out_dir / f"{hour:%Y%m%dT%H}.npz"
        np.savez_compressed(
            path,
            lat=lat_ax, lon=lon_ax, step=step, hour=str(hour), note=note, land=land,
            features=np.array(full), X=X,
            **{name: df[name].to_numpy(np.float32).reshape(shape) for name in MAP_LAYERS},
        )
        has = np.isfinite(df["aod"].to_numpy()[land.ravel()]).mean()
        med = np.nanmedian(df["pm25"].to_numpy()[land.ravel()])
        print(f"  {hour} UTC: median land PM2.5 {med:.0f} µg/m³, {has:.0%} of land cells with AOD -> {path}")
        written.append(path)
    return written
