# Planner release and methods

The default app compares two lunar site/date scenarios (`Planner` and `Learner` modes, with `Minimal`, `Moderate`, and `Detailed` verbosity controls).

## Build the local data and app

Use the environment described in the README. With the NASA cache already populated:

```powershell
python pipeline/compile_horizons.py --grid expanded --output web/public/data/planner-release
python pipeline/compile_planner.py --output web/public/data/planner-release
cd web
npm ci
npm run dev -- --host 127.0.0.1 --port 5174
```

If remote range reads fail, download [the NASA regional TIFF](https://pgda.gsfc.nasa.gov/data/LOLA_80mpp/LDEM_80S_80MPP_ADJ.TIF) to `pipeline/cache/LDEM_80S_80MPP_ADJ.TIF` and rerun the second command. Use `--local-only` to build a preliminary bundle with regional search disabled. A production build copies the generated data into `dist`. Serve that directory via HTTPS on a static host, including the data files. Localhost is supported for development. The generated data and NASA cache are excluded from Git.

## System design

Python compiles the 20 m local LOLA profile and extends it with an 80 m raster out to 96 km, with a 48 km comparison profile. The regional algorithm samples great-circle rays and uses spherical rise and run. The two distances are a sensitivity check and do not establish convergence beyond available terrain. A coverage mask records rays that leave valid terrain. The local compiler retains its original angular and spatial sampling. The regional profile stores distances for occluders contributed by the regional raster.

DE440 kernels generate apparent (LT+S) Moon-relative Sun, Earth-center, and Goldstone `DSS-14` vectors in `MOON_ME_DE440_ME421` at five-minute UTC samples (`8,641` steps over 30 days). The browser derives topocentric directions per pad using exported latitude, longitude, elevation, and mast height, and evaluates geometric 3-complex NASA DSN elevation visibility (`DSS-14`, `DSS-65`, `DSS-43` with WGS84 surface normals and a `10°` elevation mask). RF link budgets, antenna scheduling, and multipath remain outside that screen; independent withheld-pad JPL Horizons validation ([pipeline/validate_ephemeris.py](pipeline/validate_ephemeris.py)) measures apparent (LT+S) residuals of `<= 0.000001°` (Sun) and `<= 0.000025°` (Earth) against `AIRLESS`.

The browser worker verifies binary SHA-256 hashes and caches datasets and comparison results. Fully sampled geometry is evaluated for the selected pads. Search scans hourly starts using backwards obstruction-run indexes, and reports geometry eligibility independently of power and pricing. The scene, horizon chart, and outage lanes share the same analysis state. The main 3D scene (`SceneCanvas`) is lazy-loaded so the intro screen, 2D charts, and planner telemetry stay fast to boot.

## Demonstration

Compare two UTC starts, switch between the two observers, and click a shaded interval. Open **From the pad** to see the Sun and Earth against the modeled skyline. Open **Recover Pads** to search for geometry- and power-feasible alternatives, then open **Power & Cost** to compare required usable storage, modeled mass, and optional delivery-rate sensitivity. Partial coverage is explicitly surfaced. Compare power and cost only with the same load and assumptions. The initial battery is full. PV power uses an ideal tracked array scaled by the visible solar disk. The magnitude of the estimated cost change depends on user-provided pricing.

Validation commands are `.\.venv\Scripts\python.exe -m pytest pipeline -q`, `npm --prefix web test`, `node --test server/research.test.mjs server/agent.test.mjs server/phase5.test.mjs`, `cargo test --locked --manifest-path rust/umbra-core/Cargo.toml`, `.\.venv\Scripts\python.exe pipeline/validate_ephemeris.py --offline`, `.\.venv\Scripts\python.exe pipeline/check_planner_release.py web/public/data/planner-release`, `node web/src/planner/release-evidence.mjs`, `node infra/scripts/verify_release_integrity.mjs`, and `npm --prefix web run build`. Each scenario classifies outputs into explicit confidence tiers (`Model-supported`, `Sensitive`, `Incomplete`, `Not modeled`). Independent observed-shadow imagery comparison, a participant study, and an operational RF station-link comparison remain open publication gates.

## Local benchmark

Run `python pipeline/benchmark_planner.py` after compiling regional data. For the November 2026 release, apparent airless (`LT+S`) comparison across `2,160` hourly epochs per site against JPL Horizons tables gives maximum angular differences of `0.000001°` (Sun) and `0.000025°` (Earth). Across the full candidate/mast/azimuth arrays, extending the horizon from the 5.12 km local tile to the 96 km profile increased the maximum elevation by 20.159 degrees at Shackleton, 18.338 degrees at Mons Mouton, and 23.089 degrees at Malapert. The maximum changes between 48 km and 96 km were 2.187, 1.332, and 6.154 degrees respectively. These are angular changes across all bins, including bins outside the relevant Sun and Earth tracks. They establish the importance of regional terrain while leaving convergence and independent observations for further validation.

## Design and demo evidence

The [Stitch project](https://stitch.withgoogle.com/projects/8575004067407376094) explored combined, comparison-first, and sky-first layouts. The [Figma design](https://www.figma.com/design/XyUuWXNUyZhhotmKI6ya9V) contains editable desktop and mobile frames. The implementation uses the combined layout and computed data.

In the opening Shackleton scenario (`2026-11-14 -> 2026-11-16`, `pad 481`), the 48-hour delay changes the longest continuous Earth-center obstruction from `103.7` to `55.7` hours; the low-light interval stays `52.25` (`52.3`) hours and the `20 m` coarse slope exceeds `5°` (`5.60°`). Across the corrected three-region bundle (`localOverlapM = 160`), the full-epoch (`0..360 h`) browser search identifies **`61,824`** eligible pad/start pairs at `5.0 m` mast / `0σ` (`4,510` Shackleton, `39,199` Mons Mouton, `18,115` Malapert; `169` pre-overlap Mons Mouton pairs removed, see [RELEASE.md](RELEASE.md)). Search eligibility covers geometry only, independent of power and cost.

Between `5-min` and `1-min` DE440 sampling across `43,201` epochs on 5 representative pads ([pipeline/benchmark_convergence.py](pipeline/benchmark_convergence.py)), total solar hours shift by `<= 0.083 h` and longest outages by `<= 0.067 h`; between `1.0°` and `0.25°` azimuth discretization, interpolated horizon elevation differences stay `<= 0.1014°`; between `96 km` and `144 km`, elevated rim pads (`shackleton pad 481`) change `<= 0.008°`, whereas lower/flank pads (`shackleton pad 181`) gain up to `3.560°` along distant ridges (`+85.2 h` Earth blackout), and pure `80 m` DEMs miss local ridges by up to `1.231°` (`malapert pad 481`). Independent observed-shadow imagery comparison remains open; see [docs/VALIDATION_MATRIX.md](docs/VALIDATION_MATRIX.md).

### Browser search, explanation, and live polar terrain benchmarks

- **Browser search (`web/src/planner/benchmark.mjs`):** across the 3-region search (`3 × 961` pads × 361 hourly starts across both `48 km` and `96 km` terrain profiles), baseline two-pass TypeScript (`searchObserver` × 2) ran at `15,746.9 ms` cold / `6,779.4 ms` warm p50 / `9,048.5 ms` warm p95. Single-pass zero-allocation TypeScript (`searchObserverDual`) ran at `8,034.7 ms` cold / `2,363.3 ms` warm p50 / `3,866.7 ms` warm p95 (`2.87×` warm p50 speedup). The dependency-free Rust-to-WASM kernel (`web/public/wasm/umbra_core.wasm`, `50,415` bytes raw, `19,429` bytes gzipped, `0.74 ms` init) ran at `3,994.3 ms` cold / `1,559.2 ms` warm p50 / `2,529.2 ms` warm p95 (`4.35×` vs baseline TS, `1.52×` vs opt TS), and **`WASM SitePack` (`searchSiteDual`) ran at `2,397.3 ms` cold / `1,311.0 ms` warm p50 / `1,855.5 ms` warm p95 (`5.17×` vs baseline TS, `1.80×` vs opt TS)** with 100% exact decision parity across `51,240` (`mast=1.5m`, `sigma=0`), `61,824` (`mast=5.0m`, `sigma=0`), `85,678` (`mast=20.0m`, `sigma=0`), `60,718` (`sigma=1`), `59,654` (`sigma=2`), and `58,502` (`sigma=3`) eligible pad/start pairs. The Web Worker uses WASM automatically and falls back to `searchObserverDual`.
- **Scenario-grounded explanation (`web/src/planner/explain.ts`, `explain.test.mjs`):** binds explanations and source citations strictly to a `ScenarioComparisonRecord` computed from the active scenario, passing a 22-case test suite covering date shifts, baseline/alternative swaps, unit conversions, Goldstone `DSS-14` geometry vs RF limits, mapped PSRs vs verified ice, and `-80°S` partial coverage flags.
- **Scoped live polar terrain (`pipeline/live_terrain.py`, `/api/polar-horizon`):** computes on-demand `48 km` and `96 km` LOLA horizons over `LDEM_80S_80MPP_ADJ.TIF` (`7600×7600`, `80 m/px`) with explicit `coverage[360]` masks (`36,434.56 ms` cold load + Numba JIT; `281.63 ms` warm p50, `355.51 ms` warm p95 for `96 km`). Sensitivity checks across `48 / 96 / 120 / 144 km` showed `360/360` covered azimuths at Shackleton and Malapert, `325/360` at `144 km` for Mons Mouton, and `201 / 177 / 169 / 161` of `360` covered azimuths near `-80.40°S`.

## Submission and portfolio checklist

- **Ready locally:** curated regional and Apollo comparison, two reproducible presets, station geometry, pad sky and WebGL-independent chart, explicit slope/outage limits, Rust/WASM (`SitePack` + per-pad) regional search with exact TS fallback, Pareto recovery & `Decision Certificate` export, versioned shares, CSV/JSON exports, two-pad power sensitivity model, RAG + agentic `Umbra Agent` drawer (`server/researchAgent.mjs`, 28-case `eval/run_eval.mjs` suite), `/api/polar-horizon` live 80 m LOLA service (`pipeline/terrain_server.py`) with static `501` fallback, Docker terrain+api+web deployment (`infra/docker-compose.yml`), release integrity verification (`infra/scripts/verify_release_integrity.mjs`), and Uncodixified workspace UI (`Recover Pads`, `Power & Cost`, `Methods & Data` drawers + Executive Verdict).
- **Bundle gate:** run `python pipeline/check_planner_release.py web/public/data/planner-release` before building. It requires all three regional manifests, expected sizes and hashes, a common ephemeris and kernel set, and matching start epochs. The regular CI suite can run without the compiled NASA data.
- **Numerical results:** the 2D solar disk benchmark found a worst difference of 1.51 percentage points in instantaneous disk exposure across the closest sampled crossings at the benchmark pads. It used the same 1-degree skyline as the app. It tests the disk approximation without establishing finer terrain or azimuth convergence.
- **Open:** external host selection and publication, recorded demo, 5-participant timed usability study, observed-shadow and finer terrain validation, station contact cross-check, and longer epochs.

### Recorded-demo script

1. Open **48-hour launch delay**. State the 48-hour low-light, 72-hour Earth obstruction, and 5-degree coarse slope example requirements.
2. Click an Earth obstruction interval and use **From the pad → Look at Earth**. Explain the 103.7 → 55.7 hour change and the remaining low-light and slope failures.
3. Open **Compare Shackleton and Mons Mouton**, then **Find geometry alternatives**. Explain that eligibility covers the geometry limits under two terrain extents.
4. Open **Power & Cost**, compare installed mass and unmet load, and enter a clearly identified example pricing assumption. Export the analysis or download the **Decision Certificate (JSON)** to reproduce the comparison.

### Participant study protocol

Recruit at least five consenting participants across technical and novice audiences. Ask each to compare the two dates, identify the longest Earth obstruction, and explain whether geometric visibility establishes a working link. Time the task without coaching. Record anonymous participant role, elapsed seconds, completion, interpretation, and one point of friction. Aim for four of five correct within two minutes. Record observed results and the changes they prompt. Follow with an optional timed comparison using the source tools. Participant results are pending.

See [Release evidence](RELEASE.md) for the corrected near-field overlap, final eligibility counts, replay cases, and new measurements. The older counts and benchmark timings above describe the pre-overlap bundle.
## Umbra Agent and Manual Workflow

The first screen presents a lazy-loaded 3D South Pole lunar preview alongside a compact launch bar (`Mode`: `Planner` or `Learner`; `Starting view`: `Orbit 3D`, `From the pad`, `360° Polar`, or `2D & chart`). Inside the workspace, **Umbra Agent** (`AgentDrawer.tsx` + `server/researchAgent.mjs`) provides a tool-using lunar mission research co-pilot grounded in local hybrid RAG documentation and deterministic physics computations—including workspace navigation actions (switching sites, pads, views, overlays, and running Pareto recovery) and inline SVG comparison charts—while also working in an offline scenario-grounded fallback mode when no remote model key is configured.

- Recovery & trade example: `Explain why Shackleton Pad 481 fails at +48h and find a nearby Pareto-optimal recovery pad.`
- Workspace action example: `Switch to Orbit 3D view and show the illumination overlay.`
- Chart comparison example: `Compare Shackleton Pad 481 and Pad 479 battery mass with an inline chart.`

The bundled release supports three terrain-backed search grids (`3 x 961` pads x `361` hourly starts, `20 m` local + `80 m` regional LOLA out to `96 km`) over the 30-day November 2026 JPL DE440 ephemeris window, plus live on-demand `80 m` LOLA horizon synthesis across `-90°` to `-80°` via `/api/polar-horizon`. Requests outside validated bounds trigger explicit confidence/coverage boundaries rather than extrapolation.
