"""Read INSAT-3D / 3DR / 3DS Imager AOD products from MOSDAC HDF5 files.

Layout follows MOSDAC's "INSAT-3D Data Products Format Document" and the AOD ATBD (v3):
  * File name: SSIMG_DDMMMYYYY_HHMM_L2G_AOD.h5 (SS = 3D, 3R or 3S), time in GMT/UTC.
  * L2G products are gridded (0.1 deg, ~10 km) with 1-D latitude/longitude dimension scales;
    L2B products carry 2-D Latitude/Longitude datasets (often int16 with scale_factor).
  * Dataset "AOD", valid range 0-5, CF attributes _FillValue/scale_factor/add_offset. The ATBD (v3) says
    550 nm at 10 km; MOSDAC's catalog entry for 3RIMG/3SIMG_L2G_AOD says 650 nm at 4 km. Check a real file.
  * Real file names carry a version suffix, e.g. 3RIMG_01DEC2025_0845_L2G_AOD_V02R00.h5 (7 scans/day).
  * Retrievals exist only for cloud-free, daytime pixels over non-bright surfaces.

The reader does not hard-code dataset paths beyond these names: run `python -m aqpipe inspect FILE`
on a real file first and adjust AOD_NAMES / LAT_NAMES / LON_NAMES if MOSDAC has changed them.
"""
from __future__ import annotations

import re
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path

import h5py
import numpy as np
import pandas as pd

AOD_NAMES = ("AOD", "aod", "AOD_550", "Aerosol_Optical_Depth")
LAT_NAMES = ("latitude", "Latitude", "lat", "LAT")
LON_NAMES = ("longitude", "Longitude", "lon", "LON")
AOD_VALID_RANGE = (0.0, 5.0)

# lat_min, lat_max, lon_min, lon_max — mainland India plus a margin
INDIA_BBOX = (6.0, 38.5, 66.0, 99.0)

FILENAME_RE = re.compile(
    r"(?P<sat>3[A-Z])IMG_(?P<date>\d{2}[A-Z]{3}\d{4})_(?P<hhmm>\d{4})_(?P<level>L2[BG])_AOD",
    re.IGNORECASE,
)


@dataclass
class AODScene:
    path: Path
    time_utc: pd.Timestamp  # tz-naive UTC
    satellite: str  # "3D", "3R" or "3S"
    level: str  # "L2G" or "L2B"
    lat: np.ndarray  # 2-D degrees
    lon: np.ndarray  # 2-D degrees
    aod: np.ndarray  # 2-D float32, NaN where missing/invalid


def list_aod_files(directory: str | Path) -> list[Path]:
    files = [p for p in Path(directory).rglob("*") if p.suffix.lower() in (".h5", ".hdf5")]
    files = [p for p in files if FILENAME_RE.search(p.name)]
    return sorted(files, key=lambda p: (parse_filename(p)[0], p.name))


def parse_filename(path: str | Path) -> tuple[pd.Timestamp, str, str]:
    m = FILENAME_RE.search(Path(path).name)
    if not m:
        raise ValueError(f"Not a MOSDAC AOD file name: {Path(path).name}")
    t = datetime.strptime(m["date"].upper() + m["hhmm"], "%d%b%Y%H%M")
    return pd.Timestamp(t), m["sat"].upper(), m["level"].upper()


def _attr(obj, name, default=None):
    if name not in obj.attrs:
        return default
    v = obj.attrs[name]
    if isinstance(v, bytes):
        return v.decode()
    v = np.asarray(v)
    if v.dtype.kind in "SOU":
        v = v.ravel()[0]
        return v.decode() if isinstance(v, bytes) else str(v)
    return v.ravel()[0].item() if v.size == 1 else v


def _find(f: h5py.File, names) -> h5py.Dataset | None:
    found: dict[str, h5py.Dataset] = {}

    def visit(name, obj):
        if isinstance(obj, h5py.Dataset):
            found.setdefault(name.rsplit("/", 1)[-1], obj)

    f.visititems(visit)
    for n in names:
        if n in found:
            return found[n]
    lower = {k.lower(): v for k, v in found.items()}
    for n in names:
        if n.lower() in lower:
            return lower[n.lower()]
    return None


def _decode(ds: h5py.Dataset) -> np.ndarray:
    """Apply CF _FillValue / scale_factor / add_offset and return float array with NaNs."""
    raw = ds[()]
    out = raw.astype("f8")
    fill = _attr(ds, "_FillValue")
    if fill is not None:
        out[raw == fill] = np.nan
    out = out * float(_attr(ds, "scale_factor", 1.0)) + float(_attr(ds, "add_offset", 0.0))
    out[~np.isfinite(out)] = np.nan
    return out


def _scene_time(f: h5py.File, path: Path) -> pd.Timestamp:
    try:
        return parse_filename(path)[0]
    except ValueError:
        pass
    date, hhmm = _attr(f, "Acquisition_Date"), _attr(f, "Acquisition_Time_in_GMT")
    if date and hhmm:
        return pd.Timestamp(datetime.strptime(f"{date}{int(hhmm):04d}", "%d%b%Y%H%M"))
    raise ValueError(f"Cannot determine acquisition time for {path}")


def read_aod(path: str | Path, bbox=INDIA_BBOX) -> AODScene:
    path = Path(path)
    with h5py.File(path, "r") as f:
        ds = _find(f, AOD_NAMES)
        if ds is None:
            raise KeyError(f"No AOD dataset in {path.name}; run `python -m aqpipe inspect` on it")
        aod = np.squeeze(_decode(ds))
        lat_ds, lon_ds = _find(f, LAT_NAMES), _find(f, LON_NAMES)
        if lat_ds is None or lon_ds is None:
            raise KeyError(f"No latitude/longitude datasets in {path.name}")
        lat, lon = np.squeeze(_decode(lat_ds)), np.squeeze(_decode(lon_ds))
        time_utc = _scene_time(f, path)
    if aod.ndim != 2:
        raise ValueError(f"Expected a 2-D AOD field, got shape {aod.shape} in {path.name}")

    if lat.ndim == 1 and lon.ndim == 1:
        if aod.shape == (lon.size, lat.size) and lat.size != lon.size:
            aod = aod.T
        if aod.shape != (lat.size, lon.size):
            raise ValueError(f"AOD shape {aod.shape} does not match lat {lat.size} x lon {lon.size}")
        rows = np.flatnonzero((lat >= bbox[0]) & (lat <= bbox[1]))
        cols = np.flatnonzero((lon >= bbox[2]) & (lon <= bbox[3]))
        aod = aod[np.ix_(rows, cols)]
        lon, lat = np.meshgrid(lon[cols], lat[rows])
    else:
        if lat.shape != aod.shape or lon.shape != aod.shape:
            raise ValueError(f"2-D lat/lon shapes {lat.shape}/{lon.shape} differ from AOD {aod.shape}")
        inside = (lat >= bbox[0]) & (lat <= bbox[1]) & (lon >= bbox[2]) & (lon <= bbox[3])
        r, c = np.flatnonzero(inside.any(axis=1)), np.flatnonzero(inside.any(axis=0))
        if r.size == 0:
            raise ValueError(f"{path.name} does not cover the bounding box {bbox}")
        sl = (slice(r[0], r[-1] + 1), slice(c[0], c[-1] + 1))
        aod, lat, lon = aod[sl], lat[sl], lon[sl]

    lo, hi = AOD_VALID_RANGE
    aod = np.where((aod >= lo) & (aod <= hi), aod, np.nan).astype("f4")
    try:
        _, sat, level = parse_filename(path)
    except ValueError:
        sat, level = "?", "?"
    return AODScene(path, time_utc, sat, level, lat, lon, aod)


def describe(path: str | Path) -> str:
    """Human-readable dump of an HDF5 file: groups, datasets, shapes, dtypes and attributes."""
    lines = [f"File: {path}"]
    with h5py.File(path, "r") as f:
        for k in f.attrs:
            lines.append(f"  @{k} = {_attr(f, k)!r}")

        def visit(name, obj):
            if isinstance(obj, h5py.Dataset):
                lines.append(f"  /{name}  shape={obj.shape} dtype={obj.dtype}")
                for k in obj.attrs:
                    if k in ("DIMENSION_LIST", "REFERENCE_LIST"):
                        continue
                    lines.append(f"      @{k} = {_attr(obj, k)!r}")
            else:
                lines.append(f"  /{name}/  (group)")

        f.visititems(visit)
    try:
        s = read_aod(path, bbox=(-90, 90, -180, 180))
        valid = np.isfinite(s.aod)
        lines.append(
            f"\nDecoded: time={s.time_utc} UTC sat={s.satellite} level={s.level} grid={s.aod.shape} "
            f"lat {np.nanmin(s.lat):.2f}..{np.nanmax(s.lat):.2f} lon {np.nanmin(s.lon):.2f}..{np.nanmax(s.lon):.2f}"
        )
        if valid.any():
            q = np.nanpercentile(s.aod, [5, 50, 95])
            lines.append(
                f"AOD valid pixels: {valid.mean():.1%}  p5/p50/p95 = {q[0]:.3f}/{q[1]:.3f}/{q[2]:.3f}"
            )
        else:
            lines.append("AOD valid pixels: 0 (night, full cloud, or a fill value not declared)")
    except Exception as e:  # noqa: BLE001 — inspection must still print the tree
        lines.append(f"\nCould not decode with current settings: {e}")
    return "\n".join(lines)
