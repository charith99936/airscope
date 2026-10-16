"""Join station-hour AOD with ground truth, ERA5 weather and CAMS, and engineer features."""
from __future__ import annotations

import numpy as np
import pandas as pd

KEYS = ["station_id", "time_utc"]

SAT_FEATURES = ["aod", "aod_nearest", "aod_std", "aod_frac_valid", "aod_over_blh", "aod_corr", "aod_minus_cams"]
MET_FEATURES = [
    "boundary_layer_height",
    "blh_min_12h",
    "relative_humidity_2m",
    "temperature_2m",
    "dew_point_2m",
    "surface_pressure",
    "cloud_cover",
    "u10",
    "v10",
    "wind_speed_10m",
    "wind_mean_6h",
    "precip_24h",
]
CAMS_FEATURES = ["cams_pm25", "cams_pm10", "cams_aod", "cams_dust"]
TIME_FEATURES = ["doy_sin", "doy_cos", "hour_ist"]
LOC_FEATURES = ["lat", "lon"]

CAMS_RENAME = {"pm2_5": "cams_pm25", "pm10": "cams_pm10", "aerosol_optical_depth": "cams_aod", "dust": "cams_dust"}


def humidity_growth(rh: pd.Series, gamma: float) -> pd.Series:
    """Hygroscopic growth factor f(RH) = (1 - RH/100)^-gamma, with RH capped at 95% so it stays finite."""
    return (1.0 - rh.clip(0, 95) / 100.0) ** (-gamma)


def add_physics(df: pd.DataFrame, gamma: float) -> pd.DataFrame:
    """AOD -> near-surface proxies: divide the column by the mixing height and the humidity swelling."""
    blh_km = df["boundary_layer_height"].clip(lower=50) / 1000.0
    df["aod_over_blh"] = df["aod"] / blh_km
    df["aod_corr"] = df["aod"] / (blh_km * humidity_growth(df["relative_humidity_2m"], gamma))
    df["aod_minus_cams"] = df["aod"] - df["cams_aod"]
    return df


def build_table(
    aod_hourly: pd.DataFrame,
    truth: pd.DataFrame,
    stations: pd.DataFrame,
    met: pd.DataFrame,
    cams: pd.DataFrame,
    gamma: float = 0.5,
) -> pd.DataFrame:
    """One row per station-hour that had a satellite scan and a QC'd PM2.5 value.

    Cloudy / bright-surface hours are kept with aod = NaN, so the model also learns a fallback.
    """
    df = aod_hourly.merge(truth[KEYS + ["pm25"]], on=KEYS, how="inner")
    df = df.merge(stations[["station_id", "lat", "lon"]], on="station_id", how="left")
    df = df.merge(met, on=KEYS, how="left")
    df = df.merge(cams.rename(columns=CAMS_RENAME), on=KEYS, how="left")
    df = add_time_features(add_physics(df, gamma))
    return df.sort_values(KEYS).reset_index(drop=True)


def build_baseline_table(truth: pd.DataFrame, stations, met, cams, gamma: float = 0.5) -> pd.DataFrame:
    """Every QC'd station-hour with weather + CAMS and empty satellite columns (no-satellite baseline)."""
    no_aod = truth[KEYS].copy()
    for col in ("aod", "aod_nearest", "aod_std", "aod_frac_valid"):
        no_aod[col] = np.nan
    return build_table(no_aod, truth, stations, met, cams, gamma=gamma)


def add_time_features(df: pd.DataFrame) -> pd.DataFrame:
    doy = df["time_utc"].dt.dayofyear
    df["doy_sin"] = np.sin(2 * np.pi * doy / 365.25)
    df["doy_cos"] = np.cos(2 * np.pi * doy / 365.25)
    ist = df["time_utc"] + pd.Timedelta(hours=5, minutes=30)
    df["hour_ist"] = ist.dt.hour + ist.dt.minute / 60.0
    return df


def aod_diagnostics(df: pd.DataFrame, gammas=(0.0, 0.25, 0.5, 0.75, 1.0)) -> pd.DataFrame:
    """How well each AOD-derived proxy tracks PM2.5 (log-log Pearson r), before any ML."""
    d = df[df["aod"].gt(0) & df["pm25"].gt(0)]
    y = np.log(d["pm25"])
    blh_km = d["boundary_layer_height"].clip(lower=50) / 1000.0
    rows = [
        ("AOD (raw INSAT)", np.log(d["aod"])),
        ("AOD / BLH", np.log(d["aod"] / blh_km)),
    ]
    for g in gammas:
        rows.append((f"AOD / (BLH x f(RH)), gamma={g}", np.log(d["aod"] / (blh_km * humidity_growth(d["relative_humidity_2m"], g)))))
    if d["cams_pm25"].notna().any():
        rows.append(("CAMS PM2.5 (model, for reference)", np.log(d["cams_pm25"].clip(lower=0.1))))
    out = []
    for name, x in rows:
        m = np.isfinite(x) & np.isfinite(y)
        out.append({"proxy": name, "n": int(m.sum()), "log_log_r": float(np.corrcoef(x[m], y[m])[0, 1]) if m.sum() > 2 else np.nan})
    return pd.DataFrame(out)
