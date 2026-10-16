"""Train PM2.5 models and evaluate them on stations and on weeks they never saw.

Every model is scored on the same rows. The question the report answers:
does INSAT AOD add skill over weather + CAMS alone, at stations held out by spatial block?
"""
from __future__ import annotations

import json
from pathlib import Path

import lightgbm as lgb
import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt  # noqa: E402
import numpy as np  # noqa: E402
import pandas as pd  # noqa: E402
from matplotlib.colors import LinearSegmentedColormap, LogNorm  # noqa: E402
from sklearn.linear_model import LinearRegression  # noqa: E402
from sklearn.model_selection import GroupKFold  # noqa: E402

from .features import (  # noqa: E402
    CAMS_FEATURES,
    LOC_FEATURES,
    MET_FEATURES,
    SAT_FEATURES,
    TIME_FEATURES,
    aod_diagnostics,
)

LGB_PARAMS = dict(
    n_estimators=600,
    learning_rate=0.03,
    num_leaves=31,
    min_child_samples=30,
    subsample=0.8,
    subsample_freq=1,
    colsample_bytree=0.8,
    reg_lambda=1.0,
    verbose=-1,
)

NAMES = {
    "cams_raw": "CAMS PM2.5 as-is (no training)",
    "linear_aod": "Linear fit: PM2.5 ~ INSAT AOD",
    "lgbm_no_satellite": "LightGBM: weather + CAMS, no satellite",
    "lgbm_with_insat_aod": "LightGBM: weather + CAMS + INSAT AOD",
}

# Chart tokens (light surface) from the dataviz reference palette
SURFACE, INK, INK_2, GRID, SERIES = "#fcfcfb", "#0b0b0b", "#52514e", "#e4e3df", "#2a78d6"
SEQUENTIAL = LinearSegmentedColormap.from_list("blue", ["#cde2fb", "#86b6ef", "#2a78d6", "#184f95", "#0d366b"])


def feature_sets(use_latlon: bool) -> dict[str, list[str]]:
    base = MET_FEATURES + CAMS_FEATURES + TIME_FEATURES + (LOC_FEATURES if use_latlon else [])
    return {"lgbm_no_satellite": base, "lgbm_with_insat_aod": SAT_FEATURES + base}


def score(y: np.ndarray, p: np.ndarray) -> dict:
    m = np.isfinite(y) & np.isfinite(p)
    y, p = y[m], p[m]
    if len(y) < 10:
        return {"n": int(len(y))}
    resid = p - y
    return {
        "n": int(len(y)),
        "r2": float(1 - np.sum(resid**2) / np.sum((y - y.mean()) ** 2)),
        "rmse": float(np.sqrt(np.mean(resid**2))),
        "mae": float(np.mean(np.abs(resid))),
        "bias": float(np.mean(resid)),
        "pearson_r": float(np.corrcoef(y, p)[0, 1]),
    }


def spatial_groups(df: pd.DataFrame, block_deg: float) -> np.ndarray:
    by = np.floor(df["lat"] / block_deg).astype(int).astype(str)
    bx = np.floor(df["lon"] / block_deg).astype(int).astype(str)
    return (by + "_" + bx).to_numpy()


def _fit(X: pd.DataFrame, y: np.ndarray) -> lgb.LGBMRegressor:
    # log1p target: PM2.5 is heavy-tailed and errors scale with concentration
    return lgb.LGBMRegressor(**LGB_PARAMS).fit(X, np.log1p(y))


def _predict_all(df: pd.DataFrame, train_idx, test_idx, sets, oof: dict, contrib=None, primary: str = ""):
    y = df["pm25"].to_numpy()
    tr, te = df.iloc[train_idx], df.iloc[test_idx]
    for key, feats in sets.items():
        model = _fit(tr[feats], y[train_idx])
        oof[key][test_idx] = np.expm1(model.predict(te[feats]))
        if contrib is not None and key == primary:
            contrib[test_idx] = model.predict(te[feats], pred_contrib=True)
    has = tr["aod"].notna().to_numpy()
    if "linear_aod" in oof and has.sum() >= 10:
        lin = LinearRegression().fit(tr.loc[has, ["aod"]], y[train_idx][has])
        te_has = te["aod"].notna().to_numpy()
        if te_has.any():
            oof["linear_aod"][np.asarray(test_idx)[te_has]] = lin.predict(te.loc[te_has, ["aod"]])


def _subsets(df: pd.DataFrame) -> dict[str, np.ndarray]:
    cams_ok = df["cams_pm25"].notna().to_numpy() if df["cams_pm25"].notna().any() else np.ones(len(df), bool)
    has_aod = df["aod"].notna().to_numpy()
    if not has_aod.any():  # no-satellite baseline table
        out = {"all station-hours": cams_ok}
        scan = df["time_utc"].dt.hour.between(6, 9).to_numpy()
        if not scan.all():
            out["satellite scan hours (06-09 UTC)"] = cams_ok & scan
            out["night (18-00 UTC, 23:30-05:30 IST)"] = cams_ok & df["time_utc"].dt.hour.between(18, 23).to_numpy()
        return out
    return {
        "INSAT AOD available": cams_ok & has_aod,
        "AOD missing (cloud / bright surface)": cams_ok & ~has_aod,
        "all scan hours": cams_ok,
    }


def _score_table(df: pd.DataFrame, preds: dict[str, np.ndarray], rows: np.ndarray | None = None) -> list[dict]:
    y = df["pm25"].to_numpy()
    out = []
    for subset, mask in _subsets(df).items():
        if rows is not None:
            mask = mask & rows
        for key, p in preds.items():
            if key == "linear_aod" and not subset.startswith("INSAT AOD available"):
                continue
            if key == "cams_raw" and not df["cams_pm25"].notna().any():
                continue
            out.append({"subset": subset, "model": NAMES[key], **score(y[mask], p[mask])})
    return out


def _md_table(rows: list[dict], cols: list[str]) -> str:
    def fmt(v):
        if isinstance(v, float):
            return "" if np.isnan(v) else f"{v:.3f}" if abs(v) < 10 else f"{v:.1f}"
        return str(v)

    lines = ["| " + " | ".join(cols) + " |", "|" + "---|" * len(cols)]
    lines += ["| " + " | ".join(fmt(r.get(c, "")) for c in cols) + " |" for r in rows]
    return "\n".join(lines)


def _style(ax):
    ax.set_facecolor(SURFACE)
    for side in ("top", "right"):
        ax.spines[side].set_visible(False)
    for side in ("left", "bottom"):
        ax.spines[side].set_color(GRID)
    ax.tick_params(colors=INK_2, labelsize=9)
    ax.grid(color=GRID, linewidth=0.6)
    ax.set_axisbelow(True)


def _plot_scatter(y, p, title, path):
    m = np.isfinite(y) & np.isfinite(p) & (y > 0) & (p > 0)
    fig, ax = plt.subplots(figsize=(6, 5.4), facecolor=SURFACE)
    _style(ax)
    lo, hi = np.percentile(np.r_[y[m], p[m]], [0.5, 99.5])
    hb = ax.hexbin(y[m], p[m], gridsize=45, xscale="log", yscale="log", cmap=SEQUENTIAL, norm=LogNorm(), mincnt=1,
                   extent=(np.log10(lo), np.log10(hi), np.log10(lo), np.log10(hi)), linewidths=0)
    ax.plot([lo, hi], [lo, hi], color=INK_2, linewidth=1, linestyle="--")
    ax.text(hi * 0.97, hi * 0.8, "1:1", color=INK_2, fontsize=9, ha="right", va="top")
    ax.set_xlabel("Observed PM2.5 (µg/m³)", color=INK)
    ax.set_ylabel("Predicted PM2.5 (µg/m³)", color=INK)
    ax.set_title(title, color=INK, fontsize=11, loc="left")
    cb = fig.colorbar(hb, ax=ax, shrink=0.8)
    cb.set_label("station-hours per cell", color=INK_2, fontsize=9)
    cb.outline.set_visible(False)
    cb.ax.tick_params(colors=INK_2, labelsize=8)
    fig.tight_layout()
    fig.savefig(path, dpi=150, facecolor=SURFACE)
    plt.close(fig)


def _plot_importance(importance: pd.Series, path, title: str):
    top = importance.head(15)[::-1]
    fig, ax = plt.subplots(figsize=(7, 5.4), facecolor=SURFACE)
    _style(ax)
    ax.grid(axis="y", visible=False)
    ax.barh(top.index, top.values, color=SERIES, height=0.62)
    ax.set_xlabel("mean |SHAP| (log PM2.5 units), out-of-fold", color=INK)
    ax.set_title(title, color=INK, fontsize=11, loc="left")
    ax.tick_params(axis="y", colors=INK)
    fig.tight_layout()
    fig.savefig(path, dpi=150, facecolor=SURFACE)
    plt.close(fig)


def _plot_comparison(rows: list[dict], path, subset: str):
    sub = [r for r in rows if r["subset"] == subset and "rmse" in r]
    if not sub:
        return
    fig, ax = plt.subplots(figsize=(7, 0.6 * len(sub) + 1.4), facecolor=SURFACE)
    _style(ax)
    ax.grid(axis="y", visible=False)
    labels = [r["model"] for r in sub][::-1]
    vals = [r["rmse"] for r in sub][::-1]
    ax.barh(labels, vals, color=SERIES, height=0.55)
    for i, v in enumerate(vals):
        ax.text(v, i, f"  {v:.1f}", va="center", color=INK, fontsize=9)
    ax.set_xlim(0, max(vals) * 1.18)
    ax.set_xlabel("RMSE at held-out stations (µg/m³) — lower is better", color=INK)
    ax.tick_params(axis="y", colors=INK)
    ax.set_title(subset[0].upper() + subset[1:], color=INK, fontsize=11, loc="left")
    fig.tight_layout()
    fig.savefig(path, dpi=150, facecolor=SURFACE)
    plt.close(fig)


def run(
    table_path: str | Path,
    out_dir: str | Path,
    block_deg: float = 1.0,
    n_splits: int = 5,
    temporal_frac: float = 0.2,
    use_latlon: bool = False,
    extra_notes: list[str] | None = None,
    preprocessing: dict | None = None,
) -> dict:
    out_dir = Path(out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    df = pd.read_csv(table_path, parse_dates=["time_utc"])
    df = df[df["pm25"].notna()].reset_index(drop=True)
    y = df["pm25"].to_numpy()
    satellite = bool(df["aod"].notna().any())
    sets = feature_sets(use_latlon)
    if not satellite:
        sets = {"lgbm_no_satellite": sets["lgbm_no_satellite"]}
    primary = "lgbm_with_insat_aod" if satellite else "lgbm_no_satellite"
    full_feats = sets[primary]
    model_keys = ["cams_raw", *(["linear_aod"] if satellite else []), *sets]

    # ---- Spatial-block cross-validation: whole ~block_deg x block_deg areas are held out together
    groups = spatial_groups(df, block_deg)
    n_groups = len(np.unique(groups))
    k = min(n_splits, n_groups)
    if k < 2:
        raise ValueError(f"Only {n_groups} spatial block(s); use a smaller --block-deg or more stations")
    oof = {key: np.full(len(df), np.nan) for key in model_keys if key != "cams_raw"}
    contrib = np.full((len(df), len(full_feats) + 1), np.nan)
    for fold, (tr, te) in enumerate(GroupKFold(n_splits=k).split(df, y, groups), 1):
        _predict_all(df, tr, te, sets, oof, contrib, primary)
        print(f"  spatial fold {fold}/{k}: {len(np.unique(groups[te]))} blocks, {len(te)} rows held out")
    oof["cams_raw"] = df["cams_pm25"].to_numpy(dtype=float)
    preds = {k_: oof[k_] for k_ in model_keys}
    spatial_rows = _score_table(df, preds)

    # ---- Temporal hold-out: train on the first (1 - frac) of the period, test on the rest
    cutoff = df["time_utc"].quantile(1 - temporal_frac)
    tr_idx = np.flatnonzero(df["time_utc"] < cutoff)
    te_idx = np.flatnonzero(df["time_utc"] >= cutoff)
    temporal_rows = []
    if len(tr_idx) > 100 and len(te_idx) > 30:
        tp = {key: np.full(len(df), np.nan) for key in model_keys if key != "cams_raw"}
        _predict_all(df, tr_idx, te_idx, sets, tp)
        tp["cams_raw"] = df["cams_pm25"].to_numpy(dtype=float)
        in_test = np.zeros(len(df), bool)
        in_test[te_idx] = True
        temporal_rows = _score_table(df, {k_: tp[k_] for k_ in preds}, rows=in_test)

    # ---- Out-of-fold SHAP for the full model
    importance = (
        pd.Series(np.nanmean(np.abs(contrib[:, :-1]), axis=0), index=full_feats).sort_values(ascending=False)
    )

    # ---- Per-station error of the full model (large errors usually mean bad sensor data or siting)
    st = (
        df.assign(err=oof[primary] - y)
        .groupby("station_id")
        .agg(n=("err", "size"), rmse=("err", lambda e: float(np.sqrt(np.mean(e**2)))), bias=("err", "mean"),
             mean_pm25=("pm25", "mean"))
        .sort_values("rmse", ascending=False)
        .reset_index()
    )

    # ---- Final models on all data
    for key, feats in sets.items():
        _fit(df[feats], y).booster_.save_model(str(out_dir / f"{key}.txt"))

    diag = aod_diagnostics(df) if satellite else pd.DataFrame(columns=["proxy", "n", "log_log_r"])
    has_aod = df["aod"].notna()
    summary = {
        "rows": int(len(df)),
        "stations": int(df["station_id"].nunique()),
        "spatial_blocks": int(n_groups),
        "folds": int(k),
        "block_deg": block_deg,
        "period_utc": [str(df["time_utc"].min()), str(df["time_utc"].max())],
        "share_rows_with_aod": float(has_aod.mean()),
        "pm25_median": float(np.median(y)),
        "temporal_cutoff_utc": str(cutoff),
    }
    metrics = {"summary": summary, "spatial_cv": spatial_rows, "temporal_holdout": temporal_rows,
               "aod_diagnostics": diag.to_dict("records"), "shap_importance": importance.to_dict()}
    (out_dir / "metrics.json").write_text(json.dumps(metrics, indent=2))
    (out_dir / "features.json").write_text(json.dumps(
        {"feature_sets": sets, "lgb_params": LGB_PARAMS,
         "preprocessing": {"radius_km": 15.0, "gamma": 0.5, **(preprocessing or {})}}, indent=2))
    pd.DataFrame({"station_id": df["station_id"], "time_utc": df["time_utc"], "pm25": y,
                  **{f"pred_{k_}": v for k_, v in preds.items()}}).to_csv(out_dir / "oof_predictions.csv", index=False)
    st.to_csv(out_dir / "station_errors.csv", index=False)

    head_subset, m_head = next(iter(_subsets(df).items()))
    s_full = score(y[m_head], oof[primary][m_head])
    _plot_scatter(
        y[m_head], oof[primary][m_head],
        f"Held-out stations ({head_subset}): R² {s_full.get('r2', np.nan):.2f}, RMSE {s_full.get('rmse', np.nan):.1f}",
        out_dir / "oof_scatter.png",
    )
    _plot_importance(importance, out_dir / "shap_importance.png",
                     "What drives the satellite model's predictions" if satellite else "What drives the no-satellite baseline")
    _plot_comparison(spatial_rows, out_dir / "model_comparison.png", head_subset)

    cols = ["subset", "model", "n", "r2", "rmse", "mae", "bias"]
    data_lines = [
        f"- {summary['rows']:,} station-hours, {summary['stations']} stations, "
        f"{summary['period_utc'][0]} to {summary['period_utc'][1]} UTC (hours labelled by their centre)",
        f"- Median observed PM2.5: {summary['pm25_median']:.0f} µg/m³",
    ]
    if satellite:
        data_lines.insert(1, f"- {summary['share_rows_with_aod']:.0%} of those hours have a valid INSAT AOD retrieval near the station")
        diag_lines = ["## How well does each AOD proxy track PM2.5 before any ML? (log-log Pearson r)",
                      _md_table(diag.to_dict("records"), ["proxy", "n", "log_log_r"]), ""]
    else:
        diag_lines = ["No satellite AOD in this table: this is the weather + CAMS baseline the INSAT model has to beat.", ""]
    report = [
        "# PM2.5 from INSAT AOD — training report" if satellite else "# No-satellite baseline — weather + CAMS",
        "",
        *(extra_notes or []),
        "## Data",
        *data_lines,
        "",
        *diag_lines,
        f"## Spatial-block cross-validation ({k} folds, {block_deg}° blocks held out together)",
        "Stations in a held-out block are never seen during training. Same rows for every model in a subset.",
        "",
        _md_table(spatial_rows, cols),
        "",
        f"## Temporal hold-out (train before {cutoff}, test after)",
        _md_table(temporal_rows, cols) if temporal_rows else "_Not enough data for a temporal split._",
        "",
        f"## Top drivers (mean |SHAP|, out-of-fold, {NAMES[primary]})",
        _md_table([{"feature": f, "mean_abs_shap": v} for f, v in importance.head(15).items()],
                  ["feature", "mean_abs_shap"]),
        "",
        "## Stations with the largest errors (check these sensors / sites first)",
        _md_table(st.head(10).to_dict("records"), ["station_id", "n", "rmse", "bias", "mean_pm25"]),
        "",
        "Files: `oof_scatter.png`, `model_comparison.png`, `shap_importance.png`, `oof_predictions.csv`, "
        f"`station_errors.csv`, `metrics.json`, `{primary}.txt` (final model).",
    ]
    (out_dir / "report.md").write_text("\n".join(report) + "\n")
    return metrics
