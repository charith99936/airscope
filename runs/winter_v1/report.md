# PM2.5 from INSAT AOD — training report

> Real INSAT-3DR L2G AOD, Oct 2025 to Jan 2026

## Ground-truth QC
- input_rows: 1,160,641
- dropped_range_or_fill: 27,702
- dropped_flatline: 10,548
- dropped_spike: 1,748
- spikes_kept_as_regional_events: 217
- output_rows: 1,120,643

## Data
- 182,232 station-hours, 505 stations, 2025-10-01 06:00:00 to 2026-01-31 09:00:00 UTC (hours labelled by their centre)
- 69% of those hours have a valid INSAT AOD retrieval near the station
- Median observed PM2.5: 47 µg/m³

## How well does each AOD proxy track PM2.5 before any ML? (log-log Pearson r)
| proxy | n | log_log_r |
|---|---|---|
| AOD (raw INSAT) | 126477 | 0.167 |
| AOD / BLH | 126477 | 0.243 |
| AOD / (BLH x f(RH)), gamma=0.0 | 126477 | 0.243 |
| AOD / (BLH x f(RH)), gamma=0.25 | 126477 | 0.250 |
| AOD / (BLH x f(RH)), gamma=0.5 | 126477 | 0.255 |
| AOD / (BLH x f(RH)), gamma=0.75 | 126477 | 0.258 |
| AOD / (BLH x f(RH)), gamma=1.0 | 126477 | 0.260 |
| CAMS PM2.5 (model, for reference) | 126477 | 0.461 |

## Spatial-block cross-validation (5 folds, 1.0° blocks held out together)
Stations in a held-out block are never seen during training. Same rows for every model in a subset.

| subset | model | n | r2 | rmse | mae | bias |
|---|---|---|---|---|---|---|
| INSAT AOD available | CAMS PM2.5 as-is (no training) | 126477 | 0.159 | 51.1 | 31.3 | -14.9 |
| INSAT AOD available | Linear fit: PM2.5 ~ INSAT AOD | 126477 | -0.116 | 58.9 | 38.1 | -0.479 |
| INSAT AOD available | LightGBM: weather + CAMS, no satellite | 126477 | 0.200 | 49.8 | 28.5 | -14.6 |
| INSAT AOD available | LightGBM: weather + CAMS + INSAT AOD | 126477 | 0.218 | 49.3 | 28.1 | -14.5 |
| AOD missing (cloud / bright surface) | CAMS PM2.5 as-is (no training) | 55755 | 0.215 | 43.0 | 25.8 | -10.5 |
| AOD missing (cloud / bright surface) | LightGBM: weather + CAMS, no satellite | 55755 | 0.283 | 41.1 | 22.4 | -9.411 |
| AOD missing (cloud / bright surface) | LightGBM: weather + CAMS + INSAT AOD | 55755 | 0.294 | 40.8 | 22.1 | -9.865 |
| all scan hours | CAMS PM2.5 as-is (no training) | 182232 | 0.187 | 48.8 | 29.6 | -13.5 |
| all scan hours | LightGBM: weather + CAMS, no satellite | 182232 | 0.233 | 47.3 | 26.6 | -13.0 |
| all scan hours | LightGBM: weather + CAMS + INSAT AOD | 182232 | 0.249 | 46.9 | 26.3 | -13.1 |

## Temporal hold-out (train before 2025-12-31 07:00:00, test after)
| subset | model | n | r2 | rmse | mae | bias |
|---|---|---|---|---|---|---|
| INSAT AOD available | CAMS PM2.5 as-is (no training) | 26727 | 0.086 | 41.3 | 27.8 | -4.652 |
| INSAT AOD available | Linear fit: PM2.5 ~ INSAT AOD | 26727 | -0.031 | 43.8 | 31.2 | 7.766 |
| INSAT AOD available | LightGBM: weather + CAMS, no satellite | 26727 | 0.130 | 40.3 | 24.7 | -7.751 |
| INSAT AOD available | LightGBM: weather + CAMS + INSAT AOD | 26727 | 0.159 | 39.6 | 24.4 | -6.472 |
| AOD missing (cloud / bright surface) | CAMS PM2.5 as-is (no training) | 9928 | 0.040 | 50.2 | 34.9 | -9.522 |
| AOD missing (cloud / bright surface) | LightGBM: weather + CAMS, no satellite | 9928 | -0.034 | 52.1 | 33.4 | -17.6 |
| AOD missing (cloud / bright surface) | LightGBM: weather + CAMS + INSAT AOD | 9928 | -0.027 | 52.0 | 32.7 | -18.7 |
| all scan hours | CAMS PM2.5 as-is (no training) | 36655 | 0.080 | 43.9 | 29.7 | -5.971 |
| all scan hours | LightGBM: weather + CAMS, no satellite | 36655 | 0.084 | 43.8 | 27.1 | -10.4 |
| all scan hours | LightGBM: weather + CAMS + INSAT AOD | 36655 | 0.105 | 43.3 | 26.6 | -9.785 |

## Top drivers (mean |SHAP|, out-of-fold, LightGBM: weather + CAMS + INSAT AOD)
| feature | mean_abs_shap |
|---|---|
| cams_pm25 | 0.213 |
| surface_pressure | 0.094 |
| cams_pm10 | 0.073 |
| doy_sin | 0.055 |
| precip_24h | 0.044 |
| hour_ist | 0.028 |
| dew_point_2m | 0.028 |
| blh_min_12h | 0.025 |
| temperature_2m | 0.024 |
| v10 | 0.023 |
| u10 | 0.021 |
| aod_corr | 0.020 |
| relative_humidity_2m | 0.016 |
| cams_dust | 0.016 |
| cloud_cover | 0.014 |

## Stations with the largest errors (check these sensors / sites first)
| station_id | n | rmse | bias | mean_pm25 |
|---|---|---|---|---|
| oaq8475 | 421 | 151.6 | -113.2 | 179.0 |
| oaq8915 | 423 | 141.7 | -111.3 | 177.5 |
| oaq6938 | 418 | 140.9 | -108.0 | 173.4 |
| oaq8917 | 422 | 135.7 | -101.9 | 168.3 |
| oaq5622 | 414 | 134.6 | -63.0 | 132.9 |
| oaq8235 | 417 | 132.9 | -103.6 | 169.7 |
| oaq6936 | 298 | 131.2 | -25.0 | 140.6 |
| oaq235 | 423 | 130.4 | -104.2 | 169.8 |
| oaq10831 | 414 | 129.8 | -98.7 | 167.5 |
| oaq3409348 | 30 | 129.3 | -44.4 | 62.1 |

Files: `oof_scatter.png`, `model_comparison.png`, `shap_importance.png`, `oof_predictions.csv`, `station_errors.csv`, `metrics.json`, `lgbm_with_insat_aod.txt` (final model).
