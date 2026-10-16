"""Match satellite AOD pixels to ground stations and aggregate scans to station-hours."""
from __future__ import annotations

from pathlib import Path

import numpy as np
import pandas as pd
from sklearn.neighbors import BallTree

from .mosdac import INDIA_BBOX, read_aod

EARTH_RADIUS_KM = 6371.0088
# INSAT's ~26 min full-disk scan runs north to south and crosses India ~7-12 min after the nominal file time
SCAN_LAG = pd.Timedelta(minutes=9)


def scan_hour(t):
    """Centre hour (UTC) of the station hourly-average window [hh-30min, hh+30min) that contains a scan."""
    if isinstance(t, pd.Timestamp):
        return (t + SCAN_LAG).round("h")
    return (pd.to_datetime(t) + SCAN_LAG).dt.round("h")


class StationMatcher:
    """Samples every station's pixel window from a scene using great-circle distances.

    A KD-tree on raw lat/lon degrees would distort distances (a degree of longitude shrinks with
    latitude), so a haversine BallTree is used. The tree is built once per grid geometry.
    """

    def __init__(self, stations: pd.DataFrame, radius_km: float = 15.0):
        self.ids = stations["station_id"].to_numpy()
        self.points = np.radians(stations[["lat", "lon"]].to_numpy(dtype=float))
        self.radius_km = radius_km
        self._cache: dict[tuple, tuple] = {}

    def _neighbours(self, lat: np.ndarray, lon: np.ndarray):
        key = (lat.shape, float(lat.flat[0]), float(lat.flat[-1]), float(lon.flat[0]), float(lon.flat[-1]))
        if key not in self._cache:
            flat_lat, flat_lon = lat.ravel(), lon.ravel()
            ok = np.flatnonzero(np.isfinite(flat_lat) & np.isfinite(flat_lon))
            tree = BallTree(np.radians(np.c_[flat_lat[ok], flat_lon[ok]]), metric="haversine")
            window = [ok[i] for i in tree.query_radius(self.points, r=self.radius_km / EARTH_RADIUS_KM)]
            dist, near = tree.query(self.points, k=1)
            dist_km = dist[:, 0] * EARTH_RADIUS_KM
            nearest = np.where(dist_km <= self.radius_km, ok[near[:, 0]], -1)
            self._cache[key] = (window, nearest, dist_km)
        return self._cache[key]

    def sample(self, scene) -> pd.DataFrame:
        window, nearest, dist_km = self._neighbours(scene.lat, scene.lon)
        aod = scene.aod.ravel()
        rows = []
        for sid, idx, nidx, d in zip(self.ids, window, nearest, dist_km):
            if nidx < 0:  # station is outside this scene's grid
                continue
            vals = aod[idx]
            good = vals[np.isfinite(vals)]
            rows.append(
                (
                    sid,
                    good.mean() if good.size else np.nan,
                    good.std() if good.size > 1 else np.nan,
                    good.size,
                    idx.size,
                    aod[nidx],
                    d,
                )
            )
        df = pd.DataFrame(
            rows,
            columns=["station_id", "aod_mean", "aod_std", "aod_n", "n_pixels", "aod_nearest", "pixel_dist_km"],
        )
        df["time_utc"] = scene.time_utc
        df["satellite"] = scene.satellite
        return df


def match_files(files: list[Path], stations: pd.DataFrame, radius_km: float = 15.0, bbox=INDIA_BBOX) -> pd.DataFrame:
    """One row per (station, scan) with window statistics of valid AOD pixels."""
    matcher = StationMatcher(stations, radius_km)
    frames, failed = [], []
    for i, path in enumerate(files, 1):
        try:
            frames.append(matcher.sample(read_aod(path, bbox=bbox)))
        except Exception as e:  # noqa: BLE001 — one corrupt download should not stop a 6-month run
            failed.append((path.name, str(e)))
        if i % 100 == 0 or i == len(files):
            print(f"  matched {i}/{len(files)} files")
    for name, err in failed[:10]:
        print(f"  skipped {name}: {err}")
    if len(failed) > 10:
        print(f"  ... and {len(failed) - 10} more unreadable files")
    if not frames:
        raise RuntimeError("No AOD file could be read")
    return pd.concat(frames, ignore_index=True)


def to_hourly(samples: pd.DataFrame) -> pd.DataFrame:
    """Aggregate scans (every 30 min) to the station-average window they fall in, weighting by valid pixels."""
    s = samples.copy()
    s["time_utc"] = scan_hour(s["time_utc"])
    s["aod_x_n"] = s["aod_mean"].fillna(0.0) * s["aod_n"]
    g = s.groupby(["station_id", "time_utc"], sort=True)
    out = g.agg(
        aod_x_n=("aod_x_n", "sum"),
        aod_n=("aod_n", "sum"),
        n_pixels=("n_pixels", "sum"),
        aod_nearest=("aod_nearest", "mean"),
        aod_std=("aod_std", "mean"),
        n_scans=("aod_mean", "size"),
        n_valid_scans=("aod_mean", "count"),
        satellite=("satellite", lambda x: "+".join(sorted(set(x)))),
    ).reset_index()
    out["aod"] = np.where(out["aod_n"] > 0, out["aod_x_n"] / out["aod_n"].clip(lower=1), np.nan)
    out["aod_frac_valid"] = out["aod_n"] / out["n_pixels"].clip(lower=1)
    return out.drop(columns="aod_x_n")
