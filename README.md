# Umbra-X · Lunar Landing Site Navigator

At the Moon’s south pole, a landing site can spend days in shadow or lose its line of sight to Earth. Umbra-X lets you compare where and when to land, see what changes, and look for alternatives when a plan exceeds your limits. We built it for the **2026 NASA Space Apps Challenge**.

**[Open the live app](https://umbra-x.mbra.workers.dev/?intro=1)** · [Watch the 30-second demo](https://drive.google.com/file/d/1cpj0_d-CM5Xud4Ygjr8SgGVeh15giEzl/view?usp=sharing) · [Space Apps submission](https://www.spaceappschallenge.org/2026/find-a-team/team-trace/?tab=project)

## Try a landing comparison

1. **[Change the date](https://umbra-x.mbra.workers.dev/?replay=delay).** At Shackleton Ridge Pad #481, shifting the landing by 48 hours cuts the longest modeled Earth obstruction from **103.7 to 55.7 hours**. Low light and coarse slope still exceed the study limits.
2. **[Change the pad](https://umbra-x.mbra.workers.dev/?replay=nearby).** Keep the later date and move **280 meters** to Pad #479. In this study, the longest Earth obstruction falls to **4.8 hours**, with **0 hours** below the low-light threshold and a **0.94°** coarse slope.

Use the **Study** menu to switch comparisons. Move through the **Mission Timeline** and switch between the 3D terrain, pad view, polar sky plot, and horizon chart to see when sunlight or Earth visibility changes.

## What you can do

- Compare **2,883 sampled sites** across Shackleton Ridge, Malapert Massif, and Mons Mouton. Change the pad, start date, or mast height and compare two scenarios side by side.
- Use **Recover Pads** to search other pads and start times within your constraints. Compare trade-offs in darkness, Earth visibility, slope, battery mass, relocation distance, schedule shift, and sensitivity.
- Open **Power & Cost** to estimate battery mass and compare delivery costs using your own price per kilogram.
- Ask **Umbra Agent** about the results, inspect assumptions in **Methods & Data**, or export events and analysis.

## Data and model limits

The planner combines NASA LRO LOLA elevation data at **20 m locally and 80 m regionally** with JPL DE440 Sun and Earth positions at **five-minute intervals**. The terrain model traces the horizon in every direction, out to 96 km for the compiled studies. The catalog spans 30 days and supports mission windows of 1–15 days. An optional terrain service supports on-demand polar queries.

Umbra-X supports early mission screening, research, and teaching. Earth visibility is geometric line of sight. Radio performance and station scheduling require separate analysis. Grid-scale slope helps compare terrain, while individual landing hazards require finer measurements.

[Scientific method](docs/SCIENTIFIC_METHOD.md) · [Validation](docs/VALIDATION_MATRIX.md) · [Data provenance](docs/DATA_PROVENANCE.md) · [Uncertainty and limitations](docs/UNCERTAINTY_AND_LIMITATIONS.md) · [Reproducibility](docs/REPRODUCIBILITY.md)

## Setup and verification

From the repository root on Windows with Python 3.11+ and Node 20.19+ or 22.12+ installed:

```powershell
python -m venv .venv
.\.venv\Scripts\python.exe -m pip install -e ./pipeline
Push-Location pipeline
..\.venv\Scripts\python.exe -m pytest
Pop-Location
Push-Location web
npm.cmd ci
npm.cmd run build
npm.cmd run dev
```

## Compile a site

### Fetch and verify NASA inputs

From the repository root, with the pipeline installed:

```powershell
.\.venv\Scripts\python.exe pipeline/fetch_nasa_data.py
.\.venv\Scripts\python.exe -m pytest pipeline
```

The fetcher defaults to 2026-11-14 00:00 UTC. Pass `--start-utc` to choose another epoch. It caches raw JPL Horizons responses, four site ephemeris JSON files, four DE440 kernels, three georeferenced terrain arrays in NPZ files, source URLs and PSR coverage in `provenance.json`, and `verify_dem_and_slope.png`. Terrain outputs include elevation, height uncertainty, the archived and gradient-derived slopes, and the mapped PSR mask. Use `--raster-dir` for local copies of the four named GeoTIFFs if remote range reads fail.

The fetcher uses Horizons `CENTER='coord@301'` with geodetic `SITE_COORD` for the Moon. It requests 720 samples including the start timestamp, with the final sample at start + 719 hours. Apollo 11 is an ephemeris-only educator reference. The comparison checks both Sun and Earth apparent airless azimuth and elevation at every epoch against Skyfield's DE440 solution.

Sources for submission credits:

- NASA GSFC PGDA / LRO LOLA supplies elevation, height uncertainty, archived slope and the PSR classification. Umbra-X also derives slope independently from the 20 m elevation gradient. [Data DOI](https://doi.org/10.60903/gsfcpgda-lola-spole) · [Barker et al.](https://doi.org/10.3847/PSJ/acf3e1)
- NASA/JPL Horizons supplies observer tables and JPL NAIF supplies the DE440 SPK and lunar orientation kernels. NSSDCA supplies the Apollo 11 reference coordinates. [Horizons API](https://ssd-api.jpl.nasa.gov/doc/horizons.html) · [NAIF kernels](https://naif.jpl.nasa.gov/pub/naif/generic_kernels/) · [NSSDCA](https://nssdc.gsfc.nasa.gov/planetary/lunar/lunar_sites.html)
- QuickMap and Moon Trek provide interactive map references. CSA's Moon Exploration portal provides partner mission context. [QuickMap](https://quickmap.lroc.im-ldi.com/) · [Moon Trek](https://trek.nasa.gov/moon/) · [CSA Moon Exploration](https://www.asc-csa.gc.ca/eng/astronomy/moon-exploration/)
- Mons Mouton's center matches NASA PDS's rounded IM-2 Athena landing coordinates. Malapert Massif is a regional benchmark, with IM-1's landing site in the Malapert A region farther north. A mapped PSR indicates terrain classified as persistently shadowed. Ice presence requires independent evidence. [NASA PDS Athena record](https://pds.nasa.gov/ds-view/pds/viewContext.jsp?identifier=urn%3Anasa%3Apds%3Acontext%3Ainstrument_host%3Aspacecraft.clps_to_prime1_athena&version=1.0) · [NASA CLPS deliveries](https://www.nasa.gov/commercial-lunar-payload-services/clps-providers/)

### Build a web bundle

To rebuild all three browser bundles with the compact 40 m candidate grid and PSR mask after fetching:

```powershell
.\.venv\Scripts\python.exe pipeline/compile_horizons.py
```

Pass `--grid expanded` to use 140 m candidate spacing. The verification plot from the fetcher shows the expanded footprint.

Supply an elevation GeoTIFF and a height-sigma GeoTIFF in the same lunar ME/DE421 coordinate frame, with valid embedded lunar CRS definitions and coverage across the complete tile. Elevation must be relative to the 1,737,400 m reference sphere. The compiler applies source GDAL scale and offset. The [NASA Goddard south-polar LOLA archive](https://pgda.gsfc.nasa.gov/products/90) lists the `LDEM_80S_20MPP_ADJ.TIF` elevation and `LDEM_80S_20MPP_ADJ_ERR.TIF` height error products.

For the 5-minute Planner Release (`compile_planner.py`), use the DE440/ME421 kernel set: `de440s.bsp`, `moon_de440_250416.tf`, `moon_pa_de440_200625.bpc`, and `pck00011.tpc` (`MOON_ME_DE440_ME421`, checked in [docs/DATA_PROVENANCE.md](docs/DATA_PROVENANCE.md)). The complete mission period must fall within kernel coverage.

## Client engine, backend services, & live terrain

- **Client Scientific & Recovery Engine (`web/src/planner/`):** `model.ts` (`analyze`, `searchObserverDual`), `recovery.ts` (7-objective Pareto frontier + `buildDecisionCertificate`), `recoverySearch.ts`, `confidence.ts`, `planner.worker.ts`, and `wasmSearch.ts` (backed by `web/public/wasm/umbra_core.wasm`, built from `rust/umbra-core/` with `SitePack` batch scanning). Run `npm.cmd --prefix web test` and `npm.cmd --prefix web run build`.
- **Interactive UI (`web/src/planner/`):** Modular React + Three.js workspace (`Planner.tsx`, `IntroOverlay.tsx`, `IntroScene.tsx`, `ScenarioBar.tsx`, `TelemetryPanel.tsx`, `TelemetryCharts.tsx`, `SkyScene.tsx`, `terrainOverlay.ts`, `AgentDrawer.tsx`, `RecoveryDrawer.tsx`, `PowerMethodsDrawers.tsx`). Supports `Planner` / `Learner` modes, `Minimal` / `Moderate` / `Detailed` verbosity, and 7 terrain overlays (`relief`, `viable`, `illumination`, `earth`, `solar_hours`, `slope`, `psr`).
- **API, Worker Queue & Live Terrain (`server/`, `pipeline/terrain_server.py`):** Optional Node HTTP server (`server/server.mjs`, port `8787`) provides `Umbra Agent` (`researchAgent.mjs` + BM25/vector RAG over `research/rag/`), Prometheus/OTLP metrics, and durable `node:sqlite` WAL `StudyQueueStore` jobs. `pipeline/terrain_server.py` (port `8788`) serves on-demand `80 m/px` LOLA horizons (`/api/polar-horizon`). See `infra/docker-compose.yml` for the containerized `web` / `api` / `worker` / `terrain` / `prometheus` / `grafana` stack.

The decision planner and the reproducible NASA release-data build are documented in [PLANNER.md](PLANNER.md).
