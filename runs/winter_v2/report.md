# PM2.5 from INSAT AOD — training report

> Real INSAT-3DR L2G AOD, Oct 2025 to Jan 2026. v2: satellite context features, physics guardrails, larger trees.

## Model
- LightGBM on log1p(PM2.5), 900 trees, learning rate 0.03
- Monotone constraints (physics guardrails): cams_pm25 +, boundary_layer_height −, blh_min_12h −
- Satellite context features: aod_50km, aod_day, aod_clim, aod_anom (50 km, daily and seasonal AOD)

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
| INSAT AOD available | LightGBM: weather + CAMS, no satellite | 126477 | 0.270 | 47.6 | 27.4 | -14.3 |
| INSAT AOD available | LightGBM: weather + CAMS + INSAT AOD | 126477 | 0.373 | 44.1 | 26.3 | -11.8 |
| AOD missing (cloud / bright surface) | CAMS PM2.5 as-is (no training) | 55755 | 0.215 | 43.0 | 25.8 | -10.5 |
| AOD missing (cloud / bright surface) | LightGBM: weather + CAMS, no satellite | 55755 | 0.344 | 39.3 | 21.4 | -9.243 |
| AOD missing (cloud / bright surface) | LightGBM: weather + CAMS + INSAT AOD | 55755 | 0.361 | 38.8 | 21.7 | -8.784 |
| all scan hours | CAMS PM2.5 as-is (no training) | 182232 | 0.187 | 48.8 | 29.6 | -13.5 |
| all scan hours | LightGBM: weather + CAMS, no satellite | 182232 | 0.300 | 45.2 | 25.5 | -12.8 |
| all scan hours | LightGBM: weather + CAMS + INSAT AOD | 182232 | 0.380 | 42.6 | 24.9 | -10.9 |

## Temporal hold-out (train before 2025-12-31 07:00:00, test after)
| subset | model | n | r2 | rmse | mae | bias |
|---|---|---|---|---|---|---|
| INSAT AOD available | CAMS PM2.5 as-is (no training) | 26727 | 0.086 | 41.3 | 27.8 | -4.652 |
| INSAT AOD available | Linear fit: PM2.5 ~ INSAT AOD | 26727 | -0.031 | 43.8 | 31.2 | 7.766 |
| INSAT AOD available | LightGBM: weather + CAMS, no satellite | 26727 | 0.041 | 42.3 | 25.8 | -10.4 |
| INSAT AOD available | LightGBM: weather + CAMS + INSAT AOD | 26727 | 0.396 | 33.6 | 20.8 | -2.327 |
| AOD missing (cloud / bright surface) | CAMS PM2.5 as-is (no training) | 9928 | 0.040 | 50.2 | 34.9 | -9.522 |
| AOD missing (cloud / bright surface) | LightGBM: weather + CAMS, no satellite | 9928 | -0.166 | 55.4 | 35.6 | -22.9 |
| AOD missing (cloud / bright surface) | LightGBM: weather + CAMS + INSAT AOD | 9928 | 0.400 | 39.7 | 24.8 | -7.808 |
| all scan hours | CAMS PM2.5 as-is (no training) | 36655 | 0.080 | 43.9 | 29.7 | -5.971 |
| all scan hours | LightGBM: weather + CAMS, no satellite | 36655 | -0.019 | 46.2 | 28.5 | -13.7 |
| all scan hours | LightGBM: weather + CAMS + INSAT AOD | 36655 | 0.404 | 35.3 | 21.9 | -3.812 |

## Top drivers (mean |SHAP|, out-of-fold, LightGBM: weather + CAMS + INSAT AOD)
| feature | mean_abs_shap |
|---|---|
| cams_pm25 | 0.224 |
| aod_clim | 0.153 |
| surface_pressure | 0.086 |
| cams_pm10 | 0.061 |
| doy_sin | 0.060 |
| precip_24h | 0.049 |
| hour_ist | 0.031 |
| dew_point_2m | 0.030 |
| blh_min_12h | 0.028 |
| boundary_layer_height | 0.026 |
| doy_cos | 0.019 |
| temperature_2m | 0.018 |
| relative_humidity_2m | 0.017 |
| cloud_cover | 0.016 |
| u10 | 0.014 |

## Stations with the largest errors (check these sensors / sites first)
| station_id | n | rmse | bias | mean_pm25 |
|---|---|---|---|---|
| oaq3409348 | 30 | 131.0 | -48.1 | 62.1 |
| oaq5622 | 414 | 130.6 | -53.4 | 132.9 |
| oaq10831 | 414 | 129.5 | -101.8 | 167.5 |
| oaq8235 | 417 | 128.6 | -101.7 | 169.7 |
| oaq6936 | 298 | 127.8 | 10.1 | 140.6 |
| oaq11613 | 407 | 123.8 | -50.1 | 85.2 |
| oaq8915 | 423 | 122.6 | -91.0 | 177.5 |
| oaq60657 | 53 | 117.1 | -29.1 | 53.4 |
| oaq8917 | 422 | 116.8 | -81.6 | 168.3 |
| oaq6938 | 418 | 113.5 | -79.6 | 173.4 |

Files: `oof_scatter.png`, `model_comparison.png`, `shap_importance.png`, `oof_predictions.csv`, `station_errors.csv`, `metrics.json`, `lgbm_with_insat_aod.txt` (final model).
