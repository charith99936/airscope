"""Ground-truth PM2.5: OpenAQ v3 (mirrors CPCB CAAQMS) or a tidy CSV, plus quality control.

Times are tz-naive UTC. Files and caches store the START of each averaging hour; build relabels them
with label_by_centre() before joining with satellite scans and weather.
"""
from __future__ import annotations

import threading
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

import numpy as np
import pandas as pd
import requests

OPENAQ = "https://api.openaq.org/v3"
PM25_PARAMETER_ID = 2
_MIN_INTERVAL_S = 1.9  # stays under OpenAQ's 60/min and 2000/hour limits, across all threads
_rate_lock = threading.Lock()
_last_call = 0.0


def _openaq_get(path: str, api_key: str, params: dict) -> dict:
    global _last_call
    for attempt in range(8):
        with _rate_lock:
            wait = _MIN_INTERVAL_S - (time.monotonic() - _last_call)
            if wait > 0:
                time.sleep(wait)
            _last_call = time.monotonic()
        try:
            r = requests.get(f"{OPENAQ}{path}", params=params, headers={"X-API-Key": api_key}, timeout=120)
        except (requests.Timeout, requests.ConnectionError):
            time.sleep(15 * (attempt + 1))  # the API is sometimes slow; back off and retry
            continue
        if r.status_code == 429 or r.status_code >= 500:
            time.sleep(float(r.headers.get("Retry-After", 30 * (attempt + 1))))
            continue
        if r.status_code == 401:
            raise PermissionError("OpenAQ rejected the API key (HTTP 401). Check openaq_key.txt.")
        r.raise_for_status()
        return r.json()
    raise RuntimeError(f"OpenAQ {path} kept failing after retries")


def fetch_openaq_stations(api_key: str, iso: str = "IN", monitors_only: bool = True) -> pd.DataFrame:
    """Reference-grade (isMonitor) fixed PM2.5 locations in a country, one row per location.

    A location can carry several PM2.5 sensors (e.g. an old feed and the current one). All are kept in
    `sensor_ids`, newest (highest id) first; the download falls back through them.
    """
    rows, page = [], 1
    while True:
        js = _openaq_get(
            "/locations",
            api_key,
            {"iso": iso, "parameters_id": PM25_PARAMETER_ID, "limit": 1000, "page": page},
        )
        results = js.get("results", [])
        for loc in results:
            if loc.get("isMobile") or (monitors_only and not loc.get("isMonitor")):
                continue
            coords = loc.get("coordinates") or {}
            for s in loc.get("sensors", []):
                if (s.get("parameter") or {}).get("name") != "pm25":
                    continue
                rows.append(
                    {
                        "station_id": f"oaq{loc['id']}",
                        "name": loc.get("name"),
                        "lat": coords.get("latitude"),
                        "lon": coords.get("longitude"),
                        "provider": (loc.get("provider") or {}).get("name"),
                        "sensor_id": s["id"],
                        "first_utc": ((loc.get("datetimeFirst") or {}).get("utc")),
                        "last_utc": ((loc.get("datetimeLast") or {}).get("utc")),
                    }
                )
        if len(results) < 1000:
            break
        page += 1
    df = pd.DataFrame(rows).dropna(subset=["lat", "lon"]).sort_values("sensor_id", ascending=False)
    ids = df.groupby("station_id")["sensor_id"].agg(lambda x: ";".join(str(i) for i in x))
    df = df.drop_duplicates("station_id").reset_index(drop=True)
    df["sensor_ids"] = df["station_id"].map(ids)
    return df


def _sensor_hours(api_key: str, sensor_id, start: str, end: str) -> list[dict]:
    rows, page = [], 1
    while True:
        js = _openaq_get(
            f"/sensors/{sensor_id}/hours",
            api_key,
            {"datetime_from": f"{start}T00:00:00Z", "datetime_to": f"{end}T23:59:59Z", "limit": 1000, "page": page},
        )
        res = js.get("results", [])
        for r in res:
            period = (r.get("period") or {}).get("datetimeFrom") or {}
            if period.get("utc") is None or r.get("value") is None:
                continue
            rows.append({"time_utc": period["utc"], "pm25": r["value"],
                         "coverage_pct": (r.get("coverage") or {}).get("percentCoverage")})
        if len(res) < 1000:
            return rows
        page += 1


def fetch_openaq_hours(
    api_key: str, stations: pd.DataFrame, start: str, end: str, cache_dir: str | Path, workers: int = 4
) -> pd.DataFrame:
    """Hourly mean PM2.5 per station from /v3/sensors/{id}/hours, cached per station and range.

    Requests run on a few threads (responses can take tens of seconds) under one shared rate limit.
    """
    cache_dir = Path(cache_dir)
    cache_dir.mkdir(parents=True, exist_ok=True)

    def one(st) -> pd.DataFrame:
        cache = cache_dir / f"openaq_{st.station_id}_{start}_{end}.csv"
        if cache.exists():
            return pd.read_csv(cache, parse_dates=["time_utc"])
        ids = str(getattr(st, "sensor_ids", "") or st.sensor_id).split(";")
        rows, used = [], ids[0]
        for sid in ids:
            rows, used = _sensor_hours(api_key, sid, start, end), sid
            if rows:
                break
        df = pd.DataFrame(rows, columns=["time_utc", "pm25", "coverage_pct"])
        df["time_utc"] = pd.to_datetime(df["time_utc"], utc=True).dt.tz_localize(None)
        df.insert(0, "station_id", st.station_id)
        df["sensor_id"] = used
        df.to_csv(cache, index=False)
        return df

    frames, todo = [], list(stations.itertuples(index=False))
    with ThreadPoolExecutor(max_workers=workers) as ex:
        futures = {ex.submit(one, st): st for st in todo}
        for i, fut in enumerate(as_completed(futures), 1):
            st = futures[fut]
            try:
                df = fut.result()
            except Exception as e:  # noqa: BLE001 — one bad station must not lose an hour of downloads
                print(f"  [{i}/{len(todo)}] {st.station_id} {st.name}: FAILED ({e})", flush=True)
                continue
            frames.append(df)
            print(f"  [{i}/{len(todo)}] {st.station_id} {st.name}: {len(df)} hours", flush=True)
    return pd.concat(frames, ignore_index=True) if frames else pd.DataFrame()


def load_truth_csv(path: str | Path) -> pd.DataFrame:
    """Tidy CSV with columns station_id, pm25 and either time_utc or time_ist (hour start).

    Use this for CPCB CCR downloads after reshaping them to one row per station-hour.
    """
    df = pd.read_csv(path)
    missing = {"station_id", "pm25"} - set(df.columns)
    if missing:
        raise ValueError(f"{path}: missing columns {sorted(missing)}")
    if "time_utc" in df:
        t = pd.to_datetime(df["time_utc"], utc=True)
    elif "time_ist" in df:
        t = pd.to_datetime(df["time_ist"]).dt.tz_localize("Asia/Kolkata").dt.tz_convert("UTC")
    else:
        raise ValueError(f"{path}: needs a time_utc or time_ist column")
    out = pd.DataFrame(
        {
            "station_id": df["station_id"].astype(str),
            "time_utc": t.dt.tz_localize(None),
            "pm25": pd.to_numeric(df["pm25"], errors="coerce"),
        }
    )
    if "pm10" in df:
        out["pm10"] = pd.to_numeric(df["pm10"], errors="coerce")
    return out


def label_by_centre(df: pd.DataFrame) -> pd.DataFrame:
    """Relabel hourly averages (stored by their START) with the whole UTC hour at their centre.

    CPCB averages over IST clock hours, i.e. [hh:30, hh+1:30) UTC, so the centre is a whole UTC hour: the same
    instant as the ERA5/CAMS fields and the label a satellite scan inside that window gets (match.scan_hour).
    """
    out = df.copy()
    out["time_utc"] = (out["time_utc"] + pd.Timedelta(minutes=30)).dt.floor("h")
    return out


SPIKE_WINDOW = "13h"  # centred: 6 h either side of the reading


def flag_spikes(
    df: pd.DataFrame,
    stations: pd.DataFrame | None = None,
    ratio: float = 4.0,
    min_jump: float = 150.0,
    radius_km: float = 50.0,
    neighbour_ratio: float = 2.0,
    neighbour_share: float = 0.4,
) -> tuple[np.ndarray, int]:
    """Single-station sensor spikes, e.g. 30 -> 950 -> 30 µg/m³ within an hour.

    A reading is a candidate when it is >= `ratio` x its station's centred 13-hour rolling median AND at least
    `min_jump` µg/m³ above it. Candidates are kept as a regional event (Diwali fireworks, crop-burning smoke)
    rather than a glitch when stations within `radius_km` at the same hour either read >= `neighbour_ratio` x their
    own baselines, or read at least `neighbour_share` of the candidate's value (on Diwali night Delhi's stations
    were all at 600-900 µg/m³, so their own 13-hour baselines were already high and the ratio test alone missed it).
    `df` must be sorted by station and time without duplicates. Returns (spike mask, rescued count).
    """
    by_station = df.set_index("time_utc").groupby("station_id", sort=False)["pm25"]
    base = by_station.transform(lambda x: x.rolling(SPIKE_WINDOW, center=True, min_periods=5).median()).to_numpy(float)
    pm = df["pm25"].to_numpy(float)
    excess = pm / np.maximum(base, 1.0)
    spike = np.isfinite(base) & (pm >= ratio * base) & (pm - base >= min_jump)
    rescued = 0
    if stations is None or not spike.any():
        return spike, rescued

    from sklearn.neighbors import BallTree

    st = stations.drop_duplicates("station_id")
    ids = st["station_id"].astype(str).to_numpy()
    pts = np.radians(st[["lat", "lon"]].to_numpy(float))
    near = BallTree(pts, metric="haversine").query_radius(pts, r=radius_km / 6371.0088)
    neighbours = {ids[i]: [ids[j] for j in nb if j != i] for i, nb in enumerate(near)}

    cand = np.flatnonzero(spike)
    at_cand_times = df["time_utc"].isin(set(df["time_utc"].iloc[cand]))
    mask = at_cand_times.to_numpy()
    reading_at = dict(zip(zip(df["station_id"][mask], df["time_utc"][mask]), zip(excess[mask], pm[mask])))
    for k in cand:
        sid, t = df["station_id"].iat[k], df["time_utc"].iat[k]
        around = [reading_at[(n, t)] for n in neighbours.get(sid, ()) if (n, t) in reading_at]
        ratios = [r for r, _ in around if np.isfinite(r)]
        values = [v for _, v in around]
        if around and (np.median(ratios or [0]) >= neighbour_ratio or np.median(values) >= neighbour_share * pm[k]):
            spike[k] = False
            rescued += 1
    return spike, rescued


def qc_pm25(df: pd.DataFrame, flatline_hours: int = 6, stations: pd.DataFrame | None = None) -> tuple[pd.DataFrame, dict]:
    """Drop impossible, fill-like, stuck, PM2.5>PM10 and single-station spike values. Returns (clean, report).

    Pass `stations` (station_id, lat, lon) so spikes shared by nearby stations are kept as regional events.
    """
    df = df.sort_values(["station_id", "time_utc"]).drop_duplicates(["station_id", "time_utc"])
    report = {"input_rows": len(df)}
    bad_range = df["pm25"].isna() | (df["pm25"] <= 0) | (df["pm25"] >= 985)  # CPCB uses 985/999 as fill
    report["dropped_range_or_fill"] = int(bad_range.sum())
    df = df[~bad_range]

    if "pm10" in df:
        bad_ratio = df["pm10"].notna() & (df["pm25"] > df["pm10"] * 1.05)
        report["dropped_pm25_gt_pm10"] = int(bad_ratio.sum())
        df = df[~bad_ratio]

    # Stuck sensor: same value for >= flatline_hours consecutive hourly records
    run_id = (df["pm25"].diff() != 0) | (df["station_id"] != df["station_id"].shift())
    run_len = df.groupby(run_id.cumsum())["pm25"].transform("size")
    stuck = run_len >= flatline_hours
    report["dropped_flatline"] = int(stuck.sum())
    df = df[~stuck].reset_index(drop=True)

    spike, rescued = flag_spikes(df, stations)
    report["dropped_spike"] = int(spike.sum())
    report["spikes_kept_as_regional_events"] = rescued
    df = df[~spike]
    report["output_rows"] = len(df)
    return df.reset_index(drop=True), report


def load_stations(path: str | Path) -> pd.DataFrame:
    st = pd.read_csv(path)
    missing = {"station_id", "lat", "lon"} - set(st.columns)
    if missing:
        raise ValueError(f"{path}: missing columns {sorted(missing)}")
    st["station_id"] = st["station_id"].astype(str)
    st = st.dropna(subset=["lat", "lon"]).drop_duplicates("station_id").reset_index(drop=True)
    bad = ~st["lat"].between(-90, 90) | ~st["lon"].between(-180, 180)
    if bad.any():
        raise ValueError(f"{path}: {int(bad.sum())} stations have invalid coordinates")
    return st


def station_blocks(stations: pd.DataFrame, block_deg: float) -> pd.Series:
    """Spatial block id per station (lat/lon floored to block_deg) for grouped cross-validation."""
    by = np.floor(stations["lat"] / block_deg).astype(int)
    bx = np.floor(stations["lon"] / block_deg).astype(int)
    return pd.Series((by.astype(str) + "_" + bx.astype(str)).values, index=stations["station_id"].values)
