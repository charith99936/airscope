"""Synthetic test data in the documented MOSDAC L2G AOD layout, for checking the pipeline end to end.

Satellite AOD fields and station PM2.5 here are SIMULATED. Weather and CAMS come from the real
Open-Meteo APIs at real city coordinates. Never report metrics from this data as results.
"""
from __future__ import annotations

from pathlib import Path

import h5py
import numpy as np
import pandas as pd
from scipy.ndimage import gaussian_filter

from .match import scan_hour
from .mosdac import INDIA_BBOX
from .openmeteo import fetch_points

# Approximate city-centre coordinates (not exact CPCB station locations)
CITIES = [
    ("Delhi", 28.61, 77.21), ("Noida", 28.54, 77.39), ("Gurugram", 28.46, 77.03), ("Ghaziabad", 28.67, 77.45),
    ("Faridabad", 28.41, 77.32), ("Chandigarh", 30.73, 76.78), ("Ludhiana", 30.90, 75.86), ("Amritsar", 31.63, 74.87),
    ("Jaipur", 26.91, 75.79), ("Jodhpur", 26.24, 73.02), ("Agra", 27.18, 78.01), ("Lucknow", 26.85, 80.95),
    ("Kanpur", 26.45, 80.33), ("Varanasi", 25.32, 82.97), ("Prayagraj", 25.44, 81.85), ("Patna", 25.59, 85.14),
    ("Gaya", 24.79, 85.00), ("Kolkata", 22.57, 88.36), ("Asansol", 23.68, 86.98), ("Dhanbad", 23.80, 86.43),
    ("Ranchi", 23.34, 85.31), ("Bhubaneswar", 20.30, 85.82), ("Raipur", 21.25, 81.63), ("Bhopal", 23.26, 77.41),
    ("Indore", 22.72, 75.86), ("Gwalior", 26.22, 78.18), ("Ahmedabad", 23.02, 72.57), ("Surat", 21.17, 72.83),
    ("Vadodara", 22.31, 73.18), ("Mumbai", 19.08, 72.88), ("Pune", 18.52, 73.86), ("Nagpur", 21.15, 79.09),
    ("Hyderabad", 17.39, 78.49), ("Visakhapatnam", 17.69, 83.22), ("Bengaluru", 12.97, 77.59),
    ("Chennai", 13.08, 80.27), ("Kochi", 9.93, 76.27), ("Thiruvananthapuram", 8.52, 76.94), ("Guwahati", 26.14, 91.74),
    ("Dehradun", 30.32, 78.03),
]
SCAN_TIMES_UTC = ["0600", "0630", "0700", "0730", "0800", "0830"]  # per the AOD ATBD
GRID_STEP = 0.1


def _smooth_noise(rng, shape, sigma, lo, hi):
    f = gaussian_filter(rng.standard_normal(shape), sigma)
    f = (f - f.min()) / (np.ptp(f) + 1e-9)
    return lo + (hi - lo) * f


def _write_l2g(path: Path, lat, lon, aod, when: pd.Timestamp):
    with h5py.File(path, "w") as f:
        f.attrs["conventions"] = "CF-1.6"
        f.attrs["title"] = path.stem
        f.attrs["source"] = "SYNTHETIC test file in INSAT-3DR Imager L2G AOD layout"
        f.attrs["Acquisition_Date"] = when.strftime("%d%b%Y").upper()
        f.attrs["Acquisition_Time_in_GMT"] = when.strftime("%H%M")
        f.attrs["Processing_Level"] = "L2G"
        f.attrs["Satellite_Name"] = "INSAT-3DR"
        t = f.create_dataset("time", data=[(when - pd.Timestamp("2000-01-01")).total_seconds() / 60.0])
        t.attrs["units"] = "minutes since 2000-01-01 00:00:00"
        la = f.create_dataset("latitude", data=lat.astype("f4"))
        la.attrs["units"] = "degrees_north"
        lo = f.create_dataset("longitude", data=lon.astype("f4"))
        lo.attrs["units"] = "degrees_east"
        for d in (t, la, lo):
            d.make_scale(d.name.strip("/"))
        a = f.create_dataset("AOD", data=aod[None].astype("f4"), compression="gzip", compression_opts=4)
        a.attrs["long_name"] = "Aerosol Optical Depth at 550 nm"
        a.attrs["units"] = "1"
        a.attrs["_FillValue"] = np.float32(-999.0)
        a.dims[0].attach_scale(t)
        a.dims[1].attach_scale(la)
        a.dims[2].attach_scale(lo)


def make(out_dir: str | Path, start: str = "2025-11-01", days: int = 21, seed: int = 7) -> None:
    out_dir = Path(out_dir)
    (out_dir / "mosdac").mkdir(parents=True, exist_ok=True)
    rng = np.random.default_rng(seed)
    stations = pd.DataFrame(
        [{"station_id": f"syn{i:02d}", "name": n, "lat": la, "lon": lo} for i, (n, la, lo) in enumerate(CITIES)]
    )
    stations.to_csv(out_dir / "stations.csv", index=False)

    lat = np.round(np.arange(INDIA_BBOX[0], INDIA_BBOX[1] + 1e-6, GRID_STEP), 2)
    lon = np.round(np.arange(INDIA_BBOX[2], INDIA_BBOX[3] + 1e-6, GRID_STEP), 2)
    LON, LAT = np.meshgrid(lon, lat)
    # Winter pattern: haze over the Indo-Gangetic Plain, cleaner peninsula and coasts
    igp = np.exp(-(((LAT - 26.5) / 3.0) ** 2) - (((LON - 81.0) / 9.0) ** 2))
    base = 0.25 + 1.1 * igp
    thar = (LAT > 24) & (LAT < 29.5) & (LON > 69) & (LON < 73.5)  # bright desert: no retrieval (ATBD)

    end = (pd.Timestamp(start) + pd.Timedelta(days=days - 1)).strftime("%Y-%m-%d")
    print("Fetching real ERA5 weather for synthetic stations (Open-Meteo)...")
    met = fetch_points("era5", stations, start, end, out_dir / "cache")
    met = met.set_index(["station_id", "time_utc"])

    ii = np.clip(np.round((stations["lat"].to_numpy() - lat[0]) / GRID_STEP).astype(int), 0, lat.size - 1)
    jj = np.clip(np.round((stations["lon"].to_numpy() - lon[0]) / GRID_STEP).astype(int), 0, lon.size - 1)
    local = rng.uniform(0, 35, len(stations))  # unresolved local emissions per station
    truth_rows = []
    day_factor = np.exp(np.cumsum(rng.normal(0, 0.12, days)))
    for d in range(days):
        day = pd.Timestamp(start) + pd.Timedelta(days=d)
        spatial = base * _smooth_noise(rng, (lat.size, lon.size), 25, 0.75, 1.3)
        hourly_true: dict[pd.Timestamp, list[np.ndarray]] = {}
        for hhmm in SCAN_TIMES_UTC:
            when = day + pd.Timedelta(hours=int(hhmm[:2]), minutes=int(hhmm[2:]))
            aod_true = spatial * day_factor[d] * (1 + 0.05 * rng.standard_normal())
            hourly_true.setdefault(scan_hour(when), []).append(aod_true[ii, jj])
            # Observed: 15-20% retrieval error (ATBD), clouds, desert mask
            obs = aod_true * (1 + 0.15 * rng.standard_normal(aod_true.shape)) + 0.03 * rng.standard_normal(aod_true.shape)
            c = gaussian_filter(rng.standard_normal((lat.size, lon.size)), 12)
            cloud = c > 0.6 * c.std()  # ~27% cloud cover
            obs = np.where(cloud | thar | (obs < 0), -999.0, np.clip(obs, 0, 5))
            _write_l2g(out_dir / "mosdac" / f"3RIMG_{when.strftime('%d%b%Y').upper()}_{hhmm}_L2G_AOD.h5", lat, lon, obs, when)
        # Like CPCB: averages over IST clock hours, stored by their start (hh:30 UTC); t is the centre hour
        for t, vals in hourly_true.items():
            a = np.mean(vals, axis=0)
            m = met.xs(t, level="time_utc").reindex(stations["station_id"])
            blh_km = np.clip(m["boundary_layer_height"].to_numpy(), 50, None) / 1000.0
            f_rh = (1 - np.clip(m["relative_humidity_2m"].to_numpy(), 0, 95) / 100) ** -0.6
            pm = 95 * a / (blh_km**0.7 * f_rh) * np.exp(rng.normal(0, 0.18, len(a))) + local
            for sid, v in zip(stations["station_id"], pm):
                truth_rows.append({"station_id": sid, "time_utc": t - pd.Timedelta(minutes=30), "pm25": round(float(v), 1)})
        print(f"  day {d + 1}/{days} written")

    truth = pd.DataFrame(truth_rows)
    # Realistic faults for QC to catch: a stuck sensor and CPCB-style fill values
    stuck = truth["station_id"].eq("syn05")
    truth.loc[stuck, "pm25"] = 112.0
    truth.loc[truth.sample(frac=0.01, random_state=seed).index, "pm25"] = 999.0
    truth.to_csv(out_dir / "pm25_truth.csv", index=False)
    print(f"Synthetic data in {out_dir}: {len(stations)} stations, {days * len(SCAN_TIMES_UTC)} AOD files")
