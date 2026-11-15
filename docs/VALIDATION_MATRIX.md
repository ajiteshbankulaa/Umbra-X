# Validation Matrix

All checks below reflect directly executed tests and machine-readable benchmark artifacts inside `pipeline/benchmarks/` and `web/public/`.

## 1. Independent Ephemeris & DSN Validation (`pipeline/validate_ephemeris.py`)

Evaluated across **15 targets × 6 epochs** (`90` Sun + `90` Earth topocentric checks spanning corners `node 0, 960`, ridges `node 180, 216`, `mons-mouton node 16`, center controls `node 480`, and a synthetic `-89.90°S, 45.0°E, 1500 m` polar extreme at `5.0 m` mast height across `2026-11-14T00:00Z`, `+5m`, `+56h`, midpoint, `2026-12-13T23:55Z`, and `2026-12-14T00:00Z`). Artifact: [`pipeline/benchmarks/ephemeris_validation.json`](../pipeline/benchmarks/ephemeris_validation.json).

| Check | Measured Max Error | Cause / Interpretation |
| --- | ---: | --- |
| `vectors.bin` vs Skyfield apparent (LT+S) Sun & Earth | `0.000e+00 m` | Exact bit-level agreement with DE440 kernels |
| `vectors.bin` Goldstone `DSS-14` pos & normal | `0.000e+00 m` / `0.0` | Exact ITRF->`MOON_ME_DE440_ME421` parity |
| Skyfield `.apparent()` vs JPL Horizons `AIRLESS` (Sun) | `0.000001°` | Sub-milliarcsecond independent agreement |
| Skyfield `.apparent()` vs JPL Horizons `AIRLESS` (Earth) | `0.000025°` | Sub-arcsecond independent agreement |
| `vectors.bin` (apparent LT+S) vs Horizons `AIRLESS` (Sun) | `0.000001°` | Light-time `0.000002°` + stellar aberration `0.005875°` (~21.1") corrected |
| `vectors.bin` (apparent LT+S) vs Horizons `AIRLESS` (Earth) | `0.000025°` | Light-time `0.003617°` + stellar aberration `0.003429°` match Horizons to sub-arcsecond |
| Site-center hourly Horizons check (`check_planner_release.py`) | `<= 0.000025°` | Matches withheld-pad apparent LT+S residual budget |

## 2. Numerical Convergence & Sensitivity (`pipeline/benchmark_convergence.py`)

Measured across 5 representative pads (`5.0 m` mast, 30-day catalog unless noted). Artifact: [`pipeline/benchmarks/convergence_benchmark.json`](../pipeline/benchmarks/convergence_benchmark.json).

| Sensitivity Axis | Shackleton Pad 481 | Shackleton Pad 181 | Mons Mouton Pad 17 | Mons Mouton Pad 481 | Malapert Pad 481 |
| --- | --- | --- | --- | --- | --- |
| Release vs benchmark raymarch MAE | `0.00134°` | `0.00299°` | `0.00470°` | `0.00835°` | `0.00823°` |
| Azimuth `1.0° -> 0.25°` max interp delta | `0.0572°` (`MAE 0.00377°`) | `0.1014°` (`MAE 0.00525°`) | `0.0440°` (`MAE 0.00302°`) | `0.0454°` (`MAE 0.00356°`) | `0.0389°` (`MAE 0.00172°`) |
| `1.0° -> 0.25°` longest dark / Earth shift | `52.333 -> 52.250 h` / `0 h` | `0 h` / `238.667 -> 239.000 h` | `0 h` / `143.083 -> 143.500 h` | `0 h` / `124.250 -> 124.750 h` | `0.0 -> 0.0 h` / `339.500 -> 339.583 h` |
| Extent `48 -> 96 km` max delta (bins >0.05°) | `1.4297°` (`47`) | `2.0533°` (`63`) | `0.0000°` (`0`) | `0.0000°` (`0`) | `0.0000°` (`0`) |
| Extent `96 -> 144 km` max delta (bins >0.05°) | `0.0080°` (`0`) | `3.5602°` (`65`) | `0.0000°` (`0`) | `0.0000°` (`0`) | `0.1251°` (`4`) |
| Extent `96 -> 144 km` Earth blackout shift | `345.667 -> 345.667 h` | **`238.667 -> 323.833 h`** | `143.083 -> 143.083 h` | `124.250 -> 124.250 h` | `339.500 -> 339.500 h` |
| Pure `80 m` vs `20 m + 80 m` hybrid max delta | `0.6020°` (`16` bins `>0.5°`) | `1.0687°` (`70` bins `>0.5°`) | `0.2155°` (`0` bins) | `0.1675°` (`0` bins) | `1.2309°` (`75` bins `>0.5°`) |
| Pure `80 m` longest dark impact | **`52.333 -> 0.000 h`** | `167.083 -> 153.750 h` | `341.917 -> 341.917 h` | `308.667 -> 308.333 h` | `0.000 -> 0.000 h` |
| `5-min` vs `1-min` (`43,201` epochs) ΔSun / ΔDark | `-0.083 h / +0.017 h` | `-0.033 h / -0.033 h` | `0.000 h / -0.017 h` | `+0.034 h / -0.034 h` | `-0.066 h / 0.000 h` |
| 1D chord vs 2D solar disk max frac diff (ΔDark) | `0.0280` (`-0.667 h`) | `0.0159` (`-0.166 h`) | `0.0290` (`0.000 h`) | `0.0235` (`0.000 h`) | `0.0000` (`0.000 h`) |
| Mast `1.5 m -> 20.0 m` longest dark | `279.333 -> 0.000 h` | `259.833 -> 107.250 h` | `344.167 -> 330.000 h` | `314.917 -> 296.500 h` | `306.417 -> 0.000 h` |
| Slope (`compiled / geodetic / PGDA LDSM`) | `5.601° / 5.601° / 5.659°` | `15.139° / 15.139° / 14.607°` | `5.709° / 5.721° / 5.741°` | `2.457° / 2.462° / 2.436°` | **`5.289° / 5.295° / 4.853°`** |
| Height error `0σ -> 3σ` longest dark | **`52.250 -> 73.833 h`** | `167.000 -> 183.167 h` | `341.583 -> 347.000 h` | `308.583 -> 310.833 h` | **`0.000 -> 8.000 h`** |

## 3. Automated Parity & Regression Suites

- **Python pipeline tests (`pipeline/`):** `test_ephemeris.py`, `test_horizons.py`, `test_live_terrain.py` (including stereographic scale-factor slope check), `test_regional_overlap.py`, `tests/test_compiler.py`, `tests/test_ephemeris_independent.py`, `tests/test_convergence.py`.
- **Bundle gate (`pipeline/check_planner_release.py`):** Verifies SHA-256 hashes, `localOverlapM = 160`, shared vector kernel digests, and site-center Horizons parity across all 3 regional bundles.
- **Rust / WASM parity (`rust/umbra-core/`):** `cargo test --locked`, `web/src/planner/benchmark.mjs`, and `web/src/planner/release-evidence.mjs` confirm exact bit-level eligibility parity across `61,824` total pairs (`5.0 m` mast, `0σ`) against `web/src/planner/model.ts`.
- **Web & Umbra Agent tests (`web/` & `server/`):** `model.test.mjs`, `explain.test.mjs`, `confidence.test.mjs`, `studyRequest.test.mjs`, `server/research.test.mjs`, `server/agent.test.mjs`, and `server/phase5.test.mjs`.

## 4. Known Open Publication Gates

1. **Independent observed-shadow cross-validation** against timestamped LROC NAC / ShadowCam imagery.
2. **Operational RF link budget & DSN schedule simulation** beyond geometric `10°` elevation masks.
3. **Human participant usability study** (`RELEASE.md` protocol, 0 participants recorded to date).
