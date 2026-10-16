"""Hourly weather (ERA5) and CAMS air-quality at station points from the free Open-Meteo APIs.

Training uses ERA5 (models=era5) so every feature comes from one consistent reanalysis. For live
inference you will be using a forecast model instead; expect some train/serve shift in BLH/RH.
"""
from __future__ import annotations

import time
from pathlib import Path

import numpy as np
import pandas as pd
import requests

ARCHIVE_URL = "https://archive-api.open-meteo.com/v1/archive"
AIR_QUALITY_URL = "https://air-quality-api.open-meteo.com/v1/air-quality"

MET_VARS = [
    "temperature_2m",
    "relative_humidity_2m",
    "dew_point_2m",
    "precipitation",
    "surface_pressure",
    "cloud_cover",
    "wind_speed_10m",
    "wind_direction_10m",
    "boundary_layer_height",
]
CAMS_VARS = ["pm2_5", "pm10", "aerosol_optical_depth", "dust"]

# url, variables, extra params, native grid spacing (deg)
SOURCES = {
    "era5": (ARCHIVE_URL, MET_VARS, {"models": "era5", "wind_speed_unit": "ms"}, 0.25),
    "cams": (AIR_QUALITY_URL, CAMS_VARS, {"domains": "cams_global"}, 0.4),
}
CALLS_PER_MINUTE = 500  # Open-Meteo free tier: 600/min, 5,000/hour, 10,000/day (weighted)


def _request(url: str, params: dict) -> list[dict]:
    for attempt in range(5):
        r = requests.get(url, params=params, timeout=120)
        if r.status_code == 429 or r.status_code >= 500:
            time.sleep(20 * (attempt + 1))
            continue
        js = r.json()
        if isinstance(js, dict) and js.get("error"):
            raise RuntimeError(f"Open-Meteo error: {js.get('reason')}")
        r.raise_for_status()
        return js if isinstance(js, list) else [js]
    raise RuntimeError(f"Open-Meteo {url} kept failing after retries")


def fetch_points(
    source: str,
    stations: pd.DataFrame,
    start: str,
    end: str,
    cache_dir: str | Path,
    batch: int = 25,
    snap: bool = True,
) -> pd.DataFrame:
    """Hourly series for every station between start and end (YYYY-MM-DD, inclusive), UTC.

    With snap=True, stations are snapped to the source's native grid (ERA5 0.25°, CAMS 0.4°) and each cell
    is fetched once. Dense networks share cells (Delhi's ~40 stations fall in a handful), and Open-Meteo
    counts every requested location as a call, weighted up for ranges over two weeks.
    """
    url, variables, extra, step = SOURCES[source]
    cache_dir = Path(cache_dir)
    cache_dir.mkdir(parents=True, exist_ok=True)
    pts = stations[["station_id", "lat", "lon"]].copy()
    if snap:
        pts["qlat"] = (pts["lat"] / step).round() * step
        pts["qlon"] = (pts["lon"] / step).round() * step
        pts["key"] = [f"c{a:.2f}_{b:.2f}" for a, b in zip(pts["qlat"], pts["qlon"])]
    else:
        pts["qlat"], pts["qlon"], pts["key"] = pts["lat"], pts["lon"], pts["station_id"]
    path = lambda k: cache_dir / f"{source}_{k}_{start}_{end}.csv"  # noqa: E731
    cells = pts.drop_duplicates("key")
    todo = cells[[not path(k).exists() for k in cells["key"]]]
    days = (pd.Timestamp(end) - pd.Timestamp(start)).days + 1
    weight_per_point = max(1.0, days / 14) * max(1.0, len(variables) / 10)

    for i in range(0, len(todo), batch):
        chunk = todo.iloc[i : i + batch]
        params = {
            "latitude": ",".join(f"{v:.4f}" for v in chunk["qlat"]),
            "longitude": ",".join(f"{v:.4f}" for v in chunk["qlon"]),
            "start_date": start,
            "end_date": end,
            "hourly": ",".join(variables),
            "timezone": "GMT",
            **extra,
        }
        for key, js in zip(chunk["key"], _request(url, params)):
            pd.DataFrame(js["hourly"]).rename(columns={"time": "time_utc"}).to_csv(path(key), index=False)
        print(f"  {source}: fetched {min(i + batch, len(todo))}/{len(todo)} locations", flush=True)
        # Pace weighted calls under the per-minute limit (long ranges cost several calls per location)
        time.sleep(max(1.0, len(chunk) * weight_per_point / CALLS_PER_MINUTE * 60))

    cache: dict[str, pd.DataFrame] = {}
    frames = []
    for sid, key in zip(pts["station_id"], pts["key"]):
        if key not in cache:
            cache[key] = pd.read_csv(path(key), parse_dates=["time_utc"])
        frames.append(cache[key].assign(station_id=sid))
    out = pd.concat(frames, ignore_index=True)
    out["station_id"] = out["station_id"].astype(str)
    return out[["station_id"] + [c for c in out.columns if c != "station_id"]]


def add_met_derived(met: pd.DataFrame) -> pd.DataFrame:
    """Wind components and lagged dispersion/wash-out features, computed per station."""
    met = met.sort_values(["station_id", "time_utc"]).copy()
    rad = np.deg2rad(met["wind_direction_10m"])
    # Meteorological convention: direction is where the wind blows FROM.
    met["u10"] = -met["wind_speed_10m"] * np.sin(rad)
    met["v10"] = -met["wind_speed_10m"] * np.cos(rad)
    g = met.groupby("station_id", sort=False)
    met["precip_24h"] = g["precipitation"].transform(lambda s: s.rolling(24, min_periods=1).sum())
    met["blh_min_12h"] = g["boundary_layer_height"].transform(lambda s: s.rolling(12, min_periods=1).min())
    met["wind_mean_6h"] = g["wind_speed_10m"].transform(lambda s: s.rolling(6, min_periods=1).mean())
    return met
