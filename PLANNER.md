# Planner release and methods

The default app compares two lunar site/date scenarios. Add `?legacy=1` to open the experimental workstation.

## Build the local data and app

Use the environment described in the README. With the NASA cache already populated:

```powershell
python pipeline/compile_horizons.py --grid expanded --output web/public/data/planner-release
python pipeline/compile_planner.py --output web/public/data/planner-release
cd web
npm ci
npm run dev -- --host 127.0.0.1 --port 5174
```

If remote range reads fail, download [the NASA regional TIFF](https://pgda.gsfc.nasa.gov/data/LOLA_20mpp/LDEM_80S_80MPP_ADJ.TIF) to `pipeline/cache/LDEM_80S_80MPP_ADJ.TIF` and rerun the second command. Use `--local-only` to build a preliminary bundle with regional search disabled. A production build copies the generated data into `dist`. Serve that directory via HTTPS on a static host, including the data files. Localhost is supported for development. The generated data and NASA cache are excluded from Git.

## System design

Python compiles the 20 m local LOLA profile and extends it with an 80 m raster out to 96 km, with a 48 km comparison profile. The regional algorithm samples great-circle rays and uses spherical rise and run. The two distances are a sensitivity check and do not establish convergence beyond available terrain. A coverage mask records rays that leave valid terrain. The local compiler retains its original angular and spatial sampling. The regional profile stores distances for occluders contributed by the regional raster.

DE440 kernels generate geometric Moon-relative Sun, Earth-center, and DSS-14 vectors in `MOON_ME_DE440_ME421` at five-minute UTC samples. The browser derives topocentric directions per pad using exported latitude, longitude, elevation, and mast height. A fixed DSS-14 ITRF position and an assumed 10° station mask give a geometric screening example. Scheduling, link budget, aberration, and light-time corrections are outside that screen.

The browser worker checks binary hashes and caches datasets and comparison results. Fully sampled geometry is evaluated for the selected pads. Search scans hourly starts using backwards obstruction-run indexes, and reports geometry eligibility independently of power and pricing. The scene, horizon chart, and outage lanes use the same analysis state. The React entry point splits the 3D and legacy paths.

## Demonstration

Compare two UTC starts, switch between the two observers, and click a shaded interval. Open **From the pad** to see the Sun and Earth against the modeled skyline. Search for geometry alternatives, then open **Cost** to compare required usable storage, modeled mass, and optional delivery-rate sensitivity. Partial coverage is explicitly surfaced. Compare power and cost only with the same load and assumptions. The initial battery is full. PV power uses an ideal tracked array scaled by the visible solar disk. The magnitude of the estimated cost change depends on user-provided pricing.

Validation commands are `python -m pytest pipeline -q`, `npm test`, and `npm run build`. Independent observed-shadow validation, a participant study, and an operational station-link comparison remain publication gates.

## Local benchmark

Run `python pipeline/benchmark_planner.py` after compiling regional data. For the November 2026 cache, comparison with the hourly site-center Horizons tables gave a maximum direction component difference of 0.006 degrees. Across the full candidate/mast/azimuth arrays, extending the horizon from the 5.12 km local tile to the 96 km profile increased the maximum elevation by 20.159 degrees at Shackleton, 18.338 degrees at Mons Mouton, and 23.089 degrees at Malapert. The maximum changes between 48 km and 96 km were 2.187, 1.332, and 6.154 degrees respectively. These are angular changes across all bins, including bins outside the relevant Sun and Earth tracks. They establish the importance of regional terrain while leaving convergence and independent observations for further validation.

## Design and demo evidence

The [Stitch project](https://stitch.withgoogle.com/projects/8575004067407376094) explored combined, comparison-first, and sky-first layouts. The [Figma design](https://www.figma.com/design/XyUuWXNUyZhhotmKI6ya9V) contains editable desktop and mobile frames. The implementation uses the combined layout and computed data.

In the opening Shackleton scenario the 48-hour delay changed the longest continuous Earth-center obstruction from 103.7 to 55.7 hours. The low-light interval remained 52.8 hours, and the same pad still exceeded the 5-degree coarse slope limit. The local browser search found 61,971 pad/start pairs meeting the default geometry thresholds in both terrain profiles. Search eligibility does not include modeled power or cost.

The benchmark also compares five-minute and one-minute samples at pad 481 in each region, at the default date and 48 hours later. These six scenario checks used the same regional profile and found a maximum availability difference of 0.019 percentage points and maximum crossing shift of four minutes. This is a time-sampling check. Independent shadow observations and angular/disk convergence remain open.

### Browser search, explanation, and live polar terrain benchmarks

- **Browser search (`web/src/planner/benchmark.mjs`):** across the 3-region search (`3 × 961` pads × 720 hourly starts across both 5.12 km and 96 km terrain profiles), baseline two-pass TypeScript (`searchObserver` × 2) ran at `8,541.7 ms` cold / `6,828.2 ms` warm p50 / `14,258.1 ms` warm p95. Single-pass zero-allocation TypeScript (`searchObserverDual`) ran at `5,836.0 ms` cold / `3,300.4 ms` warm p50 / `5,284.2 ms` warm p95 (`2.07×` warm p50 speedup). The dependency-free Rust-to-WASM kernel (`web/public/wasm/umbra_core.wasm`, `45,051` bytes raw, `17,497` bytes gzipped, `0.66 ms` init) ran at `5,220.5 ms` cold / `2,438.6 ms` warm p50 / `4,885.6 ms` warm p95 (`2.80×` vs baseline TS, `1.35×` vs optimized TS) with 100% exact decision parity across `51,422` (`mast=1.5m`, `sigma=0`), `61,971` (`mast=5.0m`, `sigma=0`), `85,661` (`mast=20.0m`, `sigma=0`), `60,778` (`sigma=1`), `59,649` (`sigma=2`), and `58,462` (`sigma=3`) eligible pad/start pairs. The Web Worker uses WASM automatically and falls back to `searchObserverDual`.
- **Scenario-grounded explanation (`web/src/planner/explain.ts`, `explain.test.mjs`):** binds explanations and source citations strictly to a `ScenarioComparisonRecord` computed from the active scenario, passing a 22-case test suite covering date shifts, baseline/alternative swaps, unit conversions, Goldstone `DSS-14` geometry vs RF limits, mapped PSRs vs verified ice, and `-80°S` partial coverage flags.
- **Scoped live polar terrain (`pipeline/live_terrain.py`, `/api/polar-horizon`):** computes on-demand `48 km` and `96 km` LOLA horizons over `LDEM_80S_80MPP_ADJ.TIF` (`7600×7600`, `80 m/px`) with explicit `coverage[360]` masks (`36,434.56 ms` cold load + Numba JIT; `281.63 ms` warm p50, `355.51 ms` warm p95 for `96 km`). Sensitivity checks across `48 / 96 / 120 / 144 km` showed `360/360` covered azimuths at Shackleton and Malapert, `325/360` at `144 km` for Mons Mouton, and `201 / 177 / 169 / 161` of `360` covered azimuths near `-80.40°S`.

## Submission and portfolio checklist

- **Ready locally:** curated regional and Apollo comparison, two reproducible presets, station geometry, pad sky and WebGL-independent chart, explicit slope/outage limits, Rust/WASM regional search with exact TS fallback, versioned shares, CSV/JSON exports, two-pad power sensitivity model, scenario-bound `Ask Co-Pilot` explanation panel with 22-case eval suite, optional `/api/polar-horizon` dev/preview middleware returning `501` static fallback, and mission-control UI overhaul (`Overview`, `Ask Co-Pilot`, `Power & Cost`, `Methods & Data` tabs + Executive Verdict banner).
- **Bundle gate:** run `python pipeline/check_planner_release.py web/public/data/planner-release` before building. It requires all three regional manifests, expected sizes and hashes, a common ephemeris and kernel set, and matching start epochs. The regular CI suite can run without the compiled NASA data.
- **Numerical results:** the 2D solar disk benchmark found a worst difference of 1.51 percentage points in instantaneous disk exposure across the closest sampled crossings at the benchmark pads. It used the same 1-degree skyline as the app. It tests the disk approximation without establishing finer terrain or azimuth convergence.
- **Open:** external host selection and publication, recorded demo, 5-participant timed usability study, observed-shadow and finer terrain validation, station contact cross-check, longer epochs, and optional LLM-backed hybrid RAG.

### Recorded-demo script

1. Open **48-hour launch delay**. State the 48-hour low-light, 72-hour Earth obstruction, and 5-degree coarse slope example requirements.
2. Click an Earth obstruction interval and use **From the pad → Look at Earth**. Explain the 103.7 → 55.7 hour change and the remaining low-light and slope failures.
3. Open **Compare Shackleton and Mons Mouton**, then **Find geometry alternatives**. Explain that eligibility covers the geometry limits under two terrain extents.
4. Open **Cost**, compare installed mass and unmet load, and enter a clearly identified example pricing assumption. Export the analysis to reproduce the comparison.

### Participant study protocol

Recruit at least five consenting participants across technical and novice audiences. Ask each to compare the two dates, identify the longest Earth obstruction, and explain whether geometric visibility establishes a working link. Time the task without coaching. Record anonymous participant role, elapsed seconds, completion, interpretation, and one point of friction. Aim for four of five correct within two minutes. Record observed results and the changes they prompt. Follow with an optional timed comparison using the source tools. Participant results are pending.

See [Release evidence](RELEASE.md) for the corrected near-field overlap, final eligibility counts, replay cases, and new measurements. The older counts and benchmark timings above describe the pre-overlap bundle.
## Ask and Manual

The first screen offers **Ask Umbra-X** and **Manual**. Ask interprets a bounded set of site, date, terrain and constraint requests locally and previews the resolved parameters before running them. It uses the same planner and browser worker as the manual controls. Opening a result selects an existing diagram. Switching to Manual preserves the comparison and leaves all diagram selectors available.

- Finder example: `Search Mons Mouton from 2026-11-15 through 2026-11-17 for 15 days with low light <= 48 h and Earth obstruction <= 72 h.`
- Comparison example: `Compare 2026-11-15 and 2026-11-16 for 10 days.` This evaluates two starts at the current pad.
- Terrain example: `Compare the current pad with 48 km and 96 km terrain.` This changes terrain extent, rather than pixel resolution.

The bundled release supports three terrain-backed search grids within 30 days of ephemerides, with mission durations of one to 15 days. Ask provides a coverage response for requests such as a whole-year analysis. It uses deterministic request interpretation and does not call a language model. Its numerical results use the compiled NASA LRO LOLA terrain and JPL DE440 ephemerides checked against JPL Horizons.
