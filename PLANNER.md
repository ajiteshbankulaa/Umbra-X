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

## Submission and portfolio checklist

- **Ready locally:** curated regional and Apollo comparison, two reproducible presets, station geometry, pad sky and WebGL-independent chart, explicit slope/outage limits, regional search, versioned shares, CSV/JSON exports, and a two-pad power sensitivity model.
- **Bundle gate:** run `python pipeline/check_planner_release.py web/public/data/planner-release` before building. It requires all three regional manifests, expected sizes and hashes, a common ephemeris and kernel set, and matching start epochs. The regular CI suite can run without the compiled NASA data.
- **Numerical results:** the 2D solar disk benchmark found a worst difference of 1.51 percentage points in instantaneous disk exposure across the closest sampled crossings at the benchmark pads. It used the same 1-degree skyline as the app. It tests the disk approximation without establishing finer terrain or azimuth convergence.
- **Open:** external host selection and publication, recorded demo, observed-shadow and finer terrain validation, station contact cross-check, longer epochs, and evaluated RAG. The app provides a deterministic explanation with source links.

### Recorded-demo script

1. Open **48-hour launch delay**. State the 48-hour low-light, 72-hour Earth obstruction, and 5-degree coarse slope example requirements.
2. Click an Earth obstruction interval and use **From the pad → Look at Earth**. Explain the 103.7 → 55.7 hour change and the remaining low-light and slope failures.
3. Open **Compare Shackleton and Mons Mouton**, then **Find geometry alternatives**. Explain that eligibility covers the geometry limits under two terrain extents.
4. Open **Cost**, compare installed mass and unmet load, and enter a clearly identified example pricing assumption. Export the analysis to reproduce the comparison.

### Participant study protocol

Recruit at least five consenting participants across technical and novice audiences. Ask each to compare the two dates, identify the longest Earth obstruction, and explain whether geometric visibility establishes a working link. Time the task without coaching. Record anonymous participant role, elapsed seconds, completion, interpretation, and one point of friction. Aim for four of five correct within two minutes. Record observed results and the changes they prompt. Follow with an optional timed comparison using the source tools. Participant results are pending.
