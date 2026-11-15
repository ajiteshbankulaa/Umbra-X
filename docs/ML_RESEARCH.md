# ML Surrogate Research: Lunar Horizon Screening & Generalization Boundaries

**Experiment Report:** [`research/benchmarks/ml_surrogate_report.json`](../research/benchmarks/ml_surrogate_report.json)  
**Reproducible Scripts:** [`research/ml/export_dataset.mjs`](../research/ml/export_dataset.mjs), [`research/ml/train_and_eval.py`](../research/ml/train_and_eval.py)

## 1. Scientific Motivation & Exact Problem Formulation

Evaluating every candidate `(site, pad, start, mast)` tuple across full `96 km` LOLA terrain + `2-sigma` elevation uncertainty across large regional sweeps takes minutes in pure JS (`17,334` 10-day triples required `399.8 s` to export). We investigate whether ML surrogates trained on physical terrain/ephemeris features can:

1. Predict continuous `2-sigma / 96 km` longest low-light duration (`sig2_96DarkH` in hours), and
2. Score binary mission robustness (`viable96Sig2`: dark `<= 48 h`, Earth outage `<= 72 h`, slope `<= 5 deg`) to prioritize top-K% candidates for exact verification without missing true feasible sites.

By policy, ML surrogates **never replace** exact ephemeris/horizon physics in candidate certification; at most they reorder candidate queues prior to deterministic verification.

## 2. Dataset & Anti-Leakage Experimental Protocol

We exported **17,334 exact ground-truth samples** (`research/ml/surrogate_dataset.csv`) using Umbra-X's production solver (`web/src/planner/model.ts`) across all 3 compiled polar regions (`shackleton-ridge`, `mons-mouton`, `malapert-massif`), uniform `1`-of-`3` grid sampling across `31x31` pads, 3 mast heights (`1.5, 5, 20 m`), and 6 non-overlapping 10-day launch starts (`0, 48, 96 h` early half vs `360, 408, 456 h` late half). Across this 10-day dataset, `viable96Sig2` positive prevalence is `10.74%`, `extentSensitiveDarkCount` (48 km vs 96 km shift `> 0.25 h`) is `155` (`0.89%`), and `sigma2FlipFailCount` is `0`.

To eliminate spatial or temporal autocorrelation leakage, we evaluated every model under **three strict out-of-distribution splits**:

| Split | Holdout Mechanism | Train Count | Test Count | Test Positive Rate |
| :--- | :--- | :---: | :---: | :---: |
| `spatial_block_holdout` | Holds out entire SE map quadrant (`row >= 15, col >= 15`) | 12,690 | 4,644 | 4.59% |
| `temporal_window_holdout` | Trains on `[0..336 h]`, tests on non-overlapping `[360..696 h]` | 8,667 | 8,667 | 0.36% |
| `cross_region_loso_malapert` | Leave-One-Site-Out: trains on Shackleton + Mons Mouton, tests Malapert | 11,556 | 5,778 | 8.05% |

All experiments ran on CPU (`torch 2.15.0+cpu`, total runtime `189.67 s`) comparing two feature sets:
- **Tier 1 (`30` static features):** Coordinates, slope, PSR, mast height, static `48 km`/`96 km`/LOLA-error directional sector summaries, and window-level Sun/Earth elevation statistics (zero ray-marching).
- **Tier 2 (`34` features):** Adds fast `48 km` nominal simulation metrics (`ref48DarkH`, `ref48EarthH`, `ref48SolarH`, `ref48EarthVisH`).

## 3. Tier 1 Results (Static Horizon Summaries Only — Zero Time-Stepping)

| Split | Model | Dark MAE (h) | AUROC | PR-AUC | F1 | Calibrated ECE | Top-10% Screen Recall |
| :--- | :--- | :---: | :---: | :---: | :---: | :---: | :---: |
| **Spatial Block** | `analytical_baseline` (Ridge + rule) | 75.169 | 0.9431 | 0.3339 | 0.2953 | 0.03190 | 0.6948 |
| **Spatial Block** | `hist_gbdt` (`scikit-learn`) | **27.539** | **1.0000** | 0.9996 | 0.9816 | **0.00236** | **1.0000** |
| **Spatial Block** | `random_forest` (`scikit-learn`) | 27.539 | **1.0000** | **1.0000** | **0.9976** | 0.02246 | **1.0000** |
| **Spatial Block** | `pytorch_res_mlp` (22,178 params) | 29.163 | 0.9993 | 0.9873 | 0.9263 | 0.00377 | **1.0000** |
| **Temporal Holdout** | `analytical_baseline` | 129.822 | **0.9718** | **0.1020** | 0.0214 | 0.32375 | **0.9355** |
| **Temporal Holdout** | `hist_gbdt` | 135.843 | 0.8804 | 0.0141 | 0.0346 | 0.19941 | 0.2581 |
| **Temporal Holdout** | `random_forest` | 135.843 | 0.8851 | 0.0147 | 0.0335 | 0.20404 | 0.3871 |
| **Temporal Holdout** | `pytorch_res_mlp` | **121.587** | 0.9240 | 0.0223 | **0.0462** | **0.14827** | 0.6774 |
| **LOSO Malapert** | `analytical_baseline` | **91.954** | 0.9478 | 0.6239 | 0.5408 | 0.09251 | 0.6645 |
| **LOSO Malapert** | `hist_gbdt` | 109.099 | **0.9935** | **0.9157** | **0.7694** | **0.02499** | **0.9505** |
| **LOSO Malapert** | `random_forest` | 109.099 | 0.9907 | 0.8865 | 0.6506 | 0.04747 | 0.9441 |
| **LOSO Malapert** | `pytorch_res_mlp` | 98.786 | 0.9785 | 0.8359 | 0.7391 | 0.04864 | 0.8860 |

## 4. Tier 2 Ablation (Adding Fast 48 km Nominal Screen)

| Split | Model | Dark MAE (h) | Cls Accuracy | AUROC | ECE | Top-10% Recall |
| :--- | :--- | :---: | :---: | :---: | :---: | :---: |
| **Spatial Block** | `analytical_48km_nominal` | **0.005** | **1.0000** | **1.0000** | 0.01678 | 1.0000 |
| **Spatial Block** | `hist_gbdt` | 0.384 | **1.0000** | **1.0000** | **0.00010** | 1.0000 |
| **Spatial Block** | `pytorch_res_mlp` (22,562 params) | 5.414 | 0.9963 | 0.9997 | 0.00269 | 1.0000 |
| **Temporal Holdout** | `analytical_48km_nominal` | **0.151** | **1.0000** | **1.0000** | 0.00079 | 1.0000 |
| **Temporal Holdout** | `hist_gbdt` | 0.435 | **1.0000** | **1.0000** | **0.00030** | 1.0000 |
| **Temporal Holdout** | `pytorch_res_mlp` | 18.778 | 0.9978 | 0.9996 | 0.00213 | 1.0000 |
| **LOSO Malapert** | `analytical_48km_nominal` | **0.000** | **1.0000** | **1.0000** | 0.02133 | 1.0000 |
| **LOSO Malapert** | `hist_gbdt` | 0.357 | 0.9995 | **1.0000** | **0.00041** | 1.0000 |
| **LOSO Malapert** | `pytorch_res_mlp` | 39.314 | 0.9656 | 0.9917 | 0.02520 | 0.8968 |

## 5. Calibration, Failure Modes, and Honest Conclusions

1. **Where Static ML Wins (10x Spatial Screening Compute Savings):** Under `spatial_block_holdout` (predicting unseen terrain pads within the same planning epoch) and `cross_region_loso_malapert` (transferring across polar landing regions), `HistGradientBoosting` achieves `100.0%` (`spatial`) and `95.05%` (`LOSO`, `100%` at top-20%) recall of truly robust pads while evaluating only `10%–20%` of candidates — outperforming the analytical baseline (`69.48%` / `66.45%`) with tight calibration (`ECE = 0.00236` / `0.02499`).
2. **Where Neural Smoothness Helps vs Hurts:** On tabular terrain data (`<13k` training rows), `HistGradientBoosting` (`~1.6–2.3 s` CPU train time) beats `PyTorch Residual MLP` (`17–36 s` train time) on in-epoch spatial accuracy and Tier-2 precision. Conversely, on **out-of-epoch temporal extrapolation** (`Tier 1`, `temporal_window_holdout`), `PyTorch MLP` degraded more smoothly than axis-aligned trees (`AUROC 0.9240` vs `0.8804`, `top-10% recall 0.6774` vs `0.2581`, `MAE 121.6 h` vs `135.8 h`).
3. **Where Static ML Fails Honestly:** Static horizon summary statistics cannot resolve continuous eclipse timing under unseen solar phase shifts (`Tier 1 temporal_window_holdout` MAE rises to `121.6–135.8 h` across all ML models, and `slope 4–6 deg` boundary accuracy falls to `59.72%`; far-field ridge shadow error rises to `47.65 h` in spatial block and `124.98 h` in LOSO).
4. **Tier 2 Analytical Parity:** When the cheap `48 km` nominal simulation is available, trusting `ref48DarkH` directly achieves `MAE = 0.000–0.151 h` vs `0.357–0.435 h` for `HistGBDT` and `5.4–39.3 h` for `PyTorch MLP`, proving that **neural/GBDT surrogates must not displace analytical physics once fast nominal visibility has been computed**, though calibrated GBDT still offers sharper uncertainty probabilities (`ECE = 0.0001–0.0004` vs `0.0168–0.0213`).
5. **MC Dropout & Temperature Scaling:** On `PyTorch MLP`, internal validation temperature scaling adjusted `T` between `0.7334` (`LOSO`) and `1.2280` (`Temporal Tier 2`), while 16-pass MC Dropout surfaced explicit predictive standard deviations (`10.6–20.7 h` on Tier 1 regression; elevated `prob std = 0.0234` during cross-region OOD shift on Malapert Massif).
