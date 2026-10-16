"""Satellite context features: the wider area, the whole day, and the season, at any point.

All of them come from the AOD files alone and are computed the same way at a training station and
at a map cell, so none of them encodes where the monitors are (unlike raw lat/lon).

- aod_50km  mean AOD within 50 km this hour: regional haze, and a value when the 15 km window is cloudy
- aod_day   mean of the point's hourly AOD over that UTC day (~7 scans): bridges cloudy hours
- aod_clim  the point's seasonal mean AOD over every scan: how hazy this place usually is
- aod_anom  aod_day / aod_clim: how unusual today is for this place
"""
from __future__ import annotations

import hashlib
from pathlib import Path

import numpy as np
import pandas as pd

from .match import StationMatcher, match_files, to_hourly
from .mosdac import INDIA_BBOX, AODScene, read_aod

CONTEXT_FEATURES = ["aod_50km", "aod_day", "aod_clim", "aod_anom"]
WIDE_RADIUS_KM = 50.0
MIN_CLIM_SCANS = 20  # pixels seen clear fewer times than this get no climatology


def climatology(files: list[Path], bbox=INDIA_BBOX, cache_dir="data/cache") -> AODScene:
    """Per-pixel mean AOD over every scan (NaN-aware), cached by the exact file list."""
    names = sorted(Path(f).name for f in files)
    key = hashlib.sha1("\n".join(names).encode()).hexdigest()[:12]
    cache = Path(cache_dir) / f"aod_climatology_{key}.npz"
    if cache.exists():
        z = np.load(cache)
        return AODScene(cache, pd.NaT, "clim", "L2G", z["lat"], z["lon"], z["aod"])
    total = count = lat = lon = None
    for i, f in enumerate(files, 1):
        s = read_aod(f, bbox=bbox)
        if total is None:
            total, count, lat, lon = np.zeros(s.aod.shape), np.zeros(s.aod.shape), s.lat, s.lon
        if s.aod.shape != total.shape:  # a different grid (e.g. an L2B swath): skip rather than misalign
            continue
        ok = np.isfinite(s.aod)
        total[ok] += s.aod[ok]
        count[ok] += 1
        if i % 200 == 0 or i == len(files):
            print(f"  climatology {i}/{len(files)} scans")
    aod = np.where(count >= MIN_CLIM_SCANS, total / np.maximum(count, 1), np.nan).astype(np.float32)
    cache.parent.mkdir(parents=True, exist_ok=True)
    np.savez_compressed(cache, lat=lat, lon=lon, aod=aod)
    return AODScene(cache, pd.NaT, "clim", "L2G", lat, lon, aod)


def finish(df: pd.DataFrame) -> pd.DataFrame:
    """aod_day and aod_anom from per-hour aod and aod_clim (rows: one point-hour each)."""
    day = df["time_utc"].dt.floor("D")
    df["aod_day"] = df.groupby([df["station_id"], day])["aod"].transform("mean")
    df["aod_anom"] = df["aod_day"] / df["aod_clim"].where(df["aod_clim"] > 0.02)
    return df


def station_context(files: list[Path], stations: pd.DataFrame, table: pd.DataFrame, aod_hourly: pd.DataFrame,
                    radius_km: float = 15.0, bbox=INDIA_BBOX, cache_dir="data/cache") -> pd.DataFrame:
    """Add CONTEXT_FEATURES to a station-hour training table.

    aod_hourly is the full `match` output (every scan hour), so aod_day averages the same hours a map cell does,
    not only the hours that kept a PM2.5 value.
    """
    print(f"Wide window: sampling {len(files)} scans within {WIDE_RADIUS_KM:g} km of {len(stations)} stations...")
    wide = to_hourly(match_files(files, stations, radius_km=WIDE_RADIUS_KM, bbox=bbox))
    wide = wide[["station_id", "time_utc", "aod"]].rename(columns={"aod": "aod_50km"})
    print("Seasonal climatology...")
    clim = StationMatcher(stations, radius_km).sample(climatology(files, bbox, cache_dir))
    clim = clim[["station_id", "aod_mean"]].rename(columns={"aod_mean": "aod_clim"})
    days = finish(aod_hourly[["station_id", "time_utc", "aod"]].merge(clim, on="station_id", how="left"))
    out = table.drop(columns=[c for c in CONTEXT_FEATURES if c in table])
    out = out.merge(wide, on=["station_id", "time_utc"], how="left")
    return out.merge(days[["station_id", "time_utc", "aod_clim", "aod_day", "aod_anom"]], on=["station_id", "time_utc"], how="left")
