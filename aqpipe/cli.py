"""Command line: python -m aqpipe <command> --help"""
from __future__ import annotations

import argparse
import json
import os
from pathlib import Path

import pandas as pd


def cmd_inspect(a):
    from .mosdac import describe

    for f in a.files:
        print(describe(f), end="\n\n")


def cmd_synthetic(a):
    from .synthetic import make

    make(a.out, start=a.start, days=a.days)


def _meta_path(csv_path) -> Path:
    return Path(csv_path).with_suffix(".meta.json")


def _api_key() -> str:
    """OPENAQ_API_KEY from the environment, or the first line of openaq_key.txt in the project folder."""
    key = os.environ.get("OPENAQ_API_KEY", "").strip()
    key_file = Path(__file__).resolve().parent.parent / "openaq_key.txt"
    if not key and key_file.exists():
        lines = key_file.read_text().split()
        key = lines[0] if lines else ""
    if not key:
        raise SystemExit("No OpenAQ key: put it in openaq_key.txt in the project folder, or set OPENAQ_API_KEY "
                         "(free key from https://explore.openaq.org/register)")
    return key


def cmd_openaq_stations(a):
    from .ground import fetch_openaq_stations

    st = fetch_openaq_stations(_api_key(), iso=a.iso, monitors_only=not a.include_low_cost)
    Path(a.out).parent.mkdir(parents=True, exist_ok=True)
    st.to_csv(a.out, index=False)
    print(f"{len(st)} PM2.5 stations -> {a.out}")
    print(st["provider"].value_counts().head(10).to_string())


def cmd_openaq_fetch(a):
    from .ground import fetch_openaq_hours

    st = pd.read_csv(a.stations)
    truth = fetch_openaq_hours(_api_key(), st, a.start, a.end, a.cache, workers=a.workers)
    truth.to_csv(a.out, index=False)
    print(f"{len(truth):,} station-hours -> {a.out}")


def cmd_match(a):
    from .ground import load_stations
    from .match import match_files, to_hourly
    from .mosdac import list_aod_files, parse_filename

    files = list_aod_files(a.aod_dir)
    if a.satellite:
        files = [f for f in files if parse_filename(f)[1] == a.satellite.upper()]
    if not files:
        raise SystemExit(f"No *_L2G_AOD.h5 / *_L2B_AOD.h5 files under {a.aod_dir}")
    print(f"Matching {len(files)} AOD files to stations within {a.radius_km} km...")
    samples = match_files(files, load_stations(a.stations), radius_km=a.radius_km)
    hourly = to_hourly(samples)
    Path(a.out).parent.mkdir(parents=True, exist_ok=True)
    hourly.to_csv(a.out, index=False)
    _meta_path(a.out).write_text(json.dumps({"radius_km": a.radius_km, "satellite": a.satellite}, indent=2))
    print(f"{len(hourly):,} station-hours ({hourly['aod'].notna().mean():.0%} with valid AOD) -> {a.out}")


def cmd_build(a):
    from .features import build_table
    from .ground import label_by_centre, load_stations, load_truth_csv, qc_pm25
    from .openmeteo import add_met_derived, fetch_points

    stations = load_stations(a.stations)
    aod = pd.read_csv(a.aod_hourly, parse_dates=["time_utc"])
    aod["station_id"] = aod["station_id"].astype(str)
    truth, qc = qc_pm25(load_truth_csv(a.truth), stations=stations)
    truth = label_by_centre(truth)
    print("PM2.5 QC:", json.dumps(qc))
    used = stations[stations["station_id"].isin(aod["station_id"].unique())]
    # One extra day before the first scan so 24 h rolling features are complete
    start = (aod["time_utc"].min() - pd.Timedelta(days=1)).strftime("%Y-%m-%d")
    end = aod["time_utc"].max().strftime("%Y-%m-%d")
    print(f"Fetching ERA5 weather and CAMS for {len(used)} stations, {start}..{end}")
    met = add_met_derived(fetch_points("era5", used, start, end, a.cache))
    cams = fetch_points("cams", used, start, end, a.cache)
    table = build_table(aod, truth, stations, met, cams, gamma=a.gamma)
    Path(a.out).parent.mkdir(parents=True, exist_ok=True)
    table.to_csv(a.out, index=False)
    (Path(a.out).with_suffix(".qc.json")).write_text(json.dumps(qc, indent=2))
    meta = json.loads(_meta_path(a.aod_hourly).read_text()) if _meta_path(a.aod_hourly).exists() else {}
    _meta_path(a.out).write_text(json.dumps({**meta, "gamma": a.gamma}, indent=2))
    print(f"{len(table):,} training rows, {table['station_id'].nunique()} stations -> {a.out}")


def cmd_context(a):
    from .context import station_context
    from .ground import load_stations
    from .mosdac import list_aod_files, parse_filename

    files = list_aod_files(a.aod_dir)
    if a.satellite:
        files = [f for f in files if parse_filename(f)[1] == a.satellite.upper()]
    stations = load_stations(a.stations)
    table = pd.read_csv(a.table, parse_dates=["time_utc"])
    hourly = pd.read_csv(a.aod_hourly, parse_dates=["time_utc"])
    for df in (table, hourly):
        df["station_id"] = df["station_id"].astype(str)
    used = stations[stations["station_id"].isin(table["station_id"].unique())]
    out = station_context(files, used, table, hourly, cache_dir=a.cache)
    out.to_csv(a.out, index=False)
    if _meta_path(a.table).exists():
        _meta_path(a.out).write_text(_meta_path(a.table).read_text())
    print(f"{len(out):,} rows; with aod_50km {out['aod_50km'].notna().mean():.0%}, aod_day {out['aod_day'].notna().mean():.0%}, "
          f"aod_clim {out['aod_clim'].notna().mean():.0%} -> {a.out}")


def cmd_baseline(a):
    from .features import build_baseline_table
    from .ground import label_by_centre, load_stations, load_truth_csv, qc_pm25
    from .openmeteo import add_met_derived, fetch_points
    from .train import run

    stations = load_stations(a.stations)
    truth, qc = qc_pm25(load_truth_csv(a.truth), stations=stations)
    truth = label_by_centre(truth)
    lo, hi = pd.Timestamp(a.start), pd.Timestamp(a.end) + pd.Timedelta(hours=23)
    truth = truth[truth["time_utc"].between(lo, hi)]
    if not a.all_hours:
        truth = truth[truth["time_utc"].dt.hour.between(6, 9)]  # when INSAT AOD exists
    used = stations[stations["station_id"].isin(truth["station_id"].unique())]
    start = (lo - pd.Timedelta(days=1)).strftime("%Y-%m-%d")
    print(f"PM2.5 QC: {json.dumps(qc)}; {len(truth):,} station-hours at {len(used)} stations")
    met = add_met_derived(fetch_points("era5", used, start, a.end, a.cache))
    cams = fetch_points("cams", used, start, a.end, a.cache)
    table = build_baseline_table(truth, stations, met, cams)
    out = Path(a.out)
    out.mkdir(parents=True, exist_ok=True)
    table.to_csv(out / "table.csv", index=False)
    notes = ["## Ground-truth QC", *[f"- {k}: {v:,}" for k, v in qc.items()], ""]
    run(out / "table.csv", out, block_deg=a.block_deg, n_splits=a.folds, temporal_frac=a.temporal_frac,
        use_latlon=a.latlon, extra_notes=notes)
    print()
    print((out / "report.md").read_text())


def cmd_train(a):
    from .train import run

    notes = []
    qc_path = Path(a.table).with_suffix(".qc.json")
    if qc_path.exists():
        qc = json.loads(qc_path.read_text())
        notes = ["## Ground-truth QC", *[f"- {k}: {v:,}" for k, v in qc.items()], ""]
    if a.note:
        notes = [f"> {a.note}", ""] + notes
    meta = json.loads(_meta_path(a.table).read_text()) if _meta_path(a.table).exists() else {}
    m = run(a.table, a.out, block_deg=a.block_deg, n_splits=a.folds, temporal_frac=a.temporal_frac,
            use_latlon=a.latlon, extra_notes=notes, preprocessing=meta)
    print()
    print(Path(a.out, "report.md").read_text())
    return m


def cmd_predict(a):
    from .predict import predict_maps

    hours = [h.strip() for h in a.hours.split(",")] if a.hours else None
    predict_maps(a.aod_dir, a.model, a.out, hours=hours, step=a.step, weather_step=a.weather_step,
                 satellite=a.satellite, cache_dir=a.cache, note=a.note or "")


def cmd_serve(a):
    import uvicorn

    from .webapp import create_app

    app = create_app(a.maps, a.model, stations_csv=a.stations, truth_csv=a.truth)
    print(f"Open http://{a.host}:{a.port}")
    uvicorn.run(app, host=a.host, port=a.port, log_level="warning")


def main(argv=None):
    p = argparse.ArgumentParser(prog="aqpipe", description="INSAT AOD + weather -> surface PM2.5")
    sub = p.add_subparsers(dest="cmd", required=True)

    s = sub.add_parser("inspect", help="Print the structure of MOSDAC HDF5 file(s) and decoded AOD stats")
    s.add_argument("files", nargs="+")
    s.set_defaults(fn=cmd_inspect)

    s = sub.add_parser("synthetic", help="Write SIMULATED MOSDAC-format files + station PM2.5 for testing")
    s.add_argument("--out", default="data/synthetic")
    s.add_argument("--start", default="2025-11-01")
    s.add_argument("--days", type=int, default=21)
    s.set_defaults(fn=cmd_synthetic)

    s = sub.add_parser("openaq-stations", help="List reference PM2.5 monitors in India from OpenAQ")
    s.add_argument("--out", default="data/stations.csv")
    s.add_argument("--iso", default="IN")
    s.add_argument("--include-low-cost", action="store_true", help="Also keep non-reference sensors")
    s.set_defaults(fn=cmd_openaq_stations)

    s = sub.add_parser("openaq-fetch", help="Download hourly PM2.5 for the listed stations")
    s.add_argument("--stations", default="data/stations.csv")
    s.add_argument("--start", required=True, help="YYYY-MM-DD")
    s.add_argument("--end", required=True, help="YYYY-MM-DD")
    s.add_argument("--out", default="data/pm25_truth.csv")
    s.add_argument("--cache", default="data/cache")
    s.add_argument("--workers", type=int, default=10,
                   help="Parallel requests; responses take ~15 s, the shared rate limit still applies")
    s.set_defaults(fn=cmd_openaq_fetch)

    s = sub.add_parser("match", help="Sample AOD around each station for every MOSDAC file")
    s.add_argument("--aod-dir", required=True)
    s.add_argument("--stations", default="data/stations.csv")
    s.add_argument("--out", default="data/aod_hourly.csv")
    s.add_argument("--radius-km", type=float, default=15.0, help="Window radius; 15 km ~ 3x3 L2G pixels")
    s.add_argument("--satellite", help="Only use one satellite: 3R (INSAT-3DR) or 3S (INSAT-3DS)")
    s.set_defaults(fn=cmd_match)

    s = sub.add_parser("build", help="QC PM2.5, fetch ERA5 + CAMS, write the training table")
    s.add_argument("--aod-hourly", default="data/aod_hourly.csv")
    s.add_argument("--truth", default="data/pm25_truth.csv")
    s.add_argument("--stations", default="data/stations.csv")
    s.add_argument("--out", default="data/train_table.csv")
    s.add_argument("--cache", default="data/cache")
    s.add_argument("--gamma", type=float, default=0.5, help="Hygroscopic growth exponent in f(RH)")
    s.set_defaults(fn=cmd_build)

    s = sub.add_parser("context", help="Add satellite context features (50 km, daily, seasonal AOD) to a training table")
    s.add_argument("--aod-dir", required=True)
    s.add_argument("--stations", default="data/stations.csv")
    s.add_argument("--table", default="data/train_table.csv")
    s.add_argument("--aod-hourly", default="data/aod_hourly.csv")
    s.add_argument("--out", default="data/train_table_context.csv")
    s.add_argument("--satellite", help="3R or 3S")
    s.add_argument("--cache", default="data/cache")
    s.set_defaults(fn=cmd_context)

    s = sub.add_parser("train", help="Spatial-block CV + temporal hold-out, baselines, SHAP, final model")
    s.add_argument("--table", default="data/train_table.csv")
    s.add_argument("--out", default="runs/latest")
    s.add_argument("--block-deg", type=float, default=1.0, help="Spatial block size held out together")
    s.add_argument("--folds", type=int, default=5)
    s.add_argument("--temporal-frac", type=float, default=0.2)
    s.add_argument("--latlon", action="store_true",
                   help="Add raw lat/lon features (ablation; tree splits on them paint rectangles on maps)")
    s.add_argument("--note", help="Line added to the top of the report")
    s.set_defaults(fn=cmd_train)

    s = sub.add_parser("baseline", help="Weather + CAMS model on real stations, no satellite (the bar to beat)")
    s.add_argument("--truth", default="data/pm25_truth.csv")
    s.add_argument("--stations", default="data/stations.csv")
    s.add_argument("--start", default="2025-10-01")
    s.add_argument("--end", default="2026-01-31")
    s.add_argument("--all-hours", action="store_true", help="Use all 24 hours, not only 06-09 UTC scan hours")
    s.add_argument("--out", default="runs/baseline_no_satellite")
    s.add_argument("--cache", default="data/cache")
    s.add_argument("--block-deg", type=float, default=1.0)
    s.add_argument("--folds", type=int, default=5)
    s.add_argument("--temporal-frac", type=float, default=0.2)
    s.add_argument("--latlon", action="store_true")
    s.set_defaults(fn=cmd_baseline)

    s = sub.add_parser("predict", help="All-India PM2.5 maps for satellite scan hours")
    s.add_argument("--aod-dir", required=True)
    s.add_argument("--model", default="runs/latest", help="A train --out folder")
    s.add_argument("--out", default="maps")
    s.add_argument("--hours", help="Comma-separated UTC hours, e.g. 2025-11-05T07,2025-11-05T08 (default: all)")
    s.add_argument("--step", type=float, default=0.1, help="Output grid spacing in degrees")
    s.add_argument("--weather-step", type=float, default=1.0,
                   help="Weather grid spacing; 1.0 deg = ~1,100 Open-Meteo calls per source")
    s.add_argument("--satellite", help="3R or 3S")
    s.add_argument("--cache", default="data/cache")
    s.add_argument("--note", help="Banner text shown in the map (e.g. a data caveat)")
    s.set_defaults(fn=cmd_predict)

    s = sub.add_parser("serve", help="Run the map web app")
    s.add_argument("--maps", default="maps")
    s.add_argument("--model", default="runs/latest")
    s.add_argument("--stations", help="stations.csv for ground-station dots")
    s.add_argument("--truth", help="PM2.5 CSV to show observed values on the dots")
    s.add_argument("--host", default="127.0.0.1")
    s.add_argument("--port", type=int, default=8000)
    s.set_defaults(fn=cmd_serve)

    a = p.parse_args(argv)
    a.fn(a)
