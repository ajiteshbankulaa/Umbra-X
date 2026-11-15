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

The refreshed [machine-readable convergence benchmark](../pipeline/benchmarks/convergence_benchmark.json) uses the same pinned apparent DE440 Sun and Earth vectors as the browser. The 1-minute series is checked against all matching 5-minute timestamps. The numerical benchmark uses a fixed solar disk with no eclipse attenuation; exact operational replay values come from [the browser solver and release evidence](../web/public/release-evidence.json). Neither test observes real lunar shadows.

| Sensitivity | What this release checked |
| --- | --- |
| Spatial sampling | Across six site/pad cases, changing 1° to 0.25° skyline sampling changed interpolated elevations by up to 0.1014°. |
| 5-minute vs 1-minute | The machine-readable report compares solar and Earth durations and longest events on identical horizons and ephemeris conventions. |
| Regional extent | More distant terrain can matter. Full-catalog Shackleton Pad #181 changes in longest Earth obstruction by about 85 h from 96 to 144 km. That is a catalog result, not the 15-day demo. |
| Pad #479 replay | At the delayed start, 4.833 h in the browser; 4.917 h in the independent 96 km raymarch, 17.583 h at 144 km, and 8.750 h with the 2σ height margin. The numerical 144 km result does not certify complete coverage. |
| Coarse slope | Shackleton Pad #481: 5.6005° compiled, 5.6006° geodetic-scale check, 5.6592° archived LDSM. Pad #479: 0.9413°, 0.9414°, 0.9039°. Pad #181: 4.5363°, 4.5364°, 4.7363°. |
| Finer terrain and uncertainty | A regional 80 m grid can smooth a local ridge. Height perturbations can change low-light durations; the 2σ and 3σ cases are sensitivity tests, not failure probabilities or worst-case bounds. |

## 3. Automated Parity & Regression Suites

- **Python pipeline tests (`pipeline/`):** `test_ephemeris.py`, `test_horizons.py`, `test_live_terrain.py` (including stereographic scale-factor slope check), `test_regional_overlap.py`, `tests/test_compiler.py`, `tests/test_ephemeris_independent.py`, `tests/test_convergence.py`.
- **Bundle gate (`pipeline/check_planner_release.py`):** Verifies SHA-256 hashes, `localOverlapM = 160`, shared vector kernel digests, and site-center Horizons parity across all 3 regional bundles.
- **Rust / WASM parity (`rust/umbra-core/`):** `cargo test --locked`, `web/src/planner/benchmark.mjs`, and `web/src/planner/release-evidence.mjs` confirm exact bit-level eligibility parity across `61,824` total pairs (`5.0 m` mast, `0σ`) against `web/src/planner/model.ts`.
- **Web & Umbra Agent tests (`web/` & `server/`):** `model.test.mjs`, `explain.test.mjs`, `confidence.test.mjs`, `studyRequest.test.mjs`, `server/research.test.mjs`, `server/agent.test.mjs`, and `server/phase5.test.mjs`.

## 4. Known Open Publication Gates

1. **Independent observed-shadow cross-validation** against timestamped LROC NAC / ShadowCam imagery.
2. **Operational RF link budget & DSN schedule simulation** beyond geometric `10°` elevation masks.
3. **Human participant usability study** (`RELEASE.md` protocol, 0 participants recorded to date).
