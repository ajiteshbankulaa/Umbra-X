# Umbra-X · Lunar Landing Site Navigator

Umbra-X is a browser-based tool for comparing lunar landing plans. Explore a site in 3D, compare two landing dates or pads, and see how the terrain affects sunlight, Earth visibility, and battery requirements. We built it for the **2026 NASA Space Apps Challenge — Lunar Landing Site Navigator**.

**[Live app](https://umbra-x.mbra.workers.dev/?intro=1)** · [30-second demo](https://drive.google.com/file/d/1cpj0_d-CM5Xud4Ygjr8SgGVeh15giEzl/view?usp=sharing) · [Space Apps project](https://www.spaceappschallenge.org/2026/find-a-team/team-trace/?tab=project)

## Try it

1. **[Change the date](https://umbra-x.mbra.workers.dev/?replay=delay).** At Shackleton Ridge Pad #481, shifting the landing by 48 hours cuts the longest modeled Earth obstruction from **103.7 to 55.7 hours**. Low light and coarse slope still exceed the example limits.
2. **[Change the pad](https://umbra-x.mbra.workers.dev/?replay=nearby).** Hold the later date fixed and move **280 meters** to Pad #479. This study reports **4.8 hours** of Earth obstruction, **0 hours** below the low-light threshold, and a **0.94°** coarse slope.

These results apply to the illustrated 15-day window and model settings. [Scenario validation](docs/DELAY_SCENARIO_VALIDATION.md)

## Tools

| Tool | What it does |
| --- | --- |
| **Study and scenario controls** | Compare a baseline and an alternative by changing the pad, landing date, mast height, or mission limits. The compiled catalog covers 2,883 sampled pads across Shackleton Ridge, Malapert Massif, and Mons Mouton. |
| **Terrain, sky views, and Mission Timeline** | Switch between 3D orbit, a view from the pad, a polar sky plot, and a 2D horizon chart. Use map overlays and move through the timeline to see when the terrain blocks sunlight or the view of Earth. |
| **Recover Pads** | Search alternate pads and start times, then compare trade-offs in darkness, Earth obstruction, slope, battery mass, relocation, schedule shift, and sensitivity. |
| **Power & Cost** | Adjust the electrical load, array assumptions, and mass budget. Compare estimated battery mass and use your own delivery price per kilogram. |
| **Umbra Agent** | Ask questions about the active comparison. The agent can use scientific analysis tools and retrieve source passages to explain results. |
| **Methods & Data and exports** | Inspect data sources, modeling assumptions, and coverage. Export events or analysis for further review. |

## Run locally

The live site is the quickest way to try Umbra-X. A local checkout needs the **generated NASA planner data**, which is excluded from Git. A build can succeed without those files, so check that the data is available before testing a landing comparison.

Install **Node.js 24+** and **Python 3.11+**. Run the following from the repository root in PowerShell. If you already have the compiled data, place it under `web/public/data/planner-release/` and skip the fetch and compile commands after installing the Python dependencies.

```powershell
git clone https://github.com/ajiteshbankulaa/Umbra-X.git
cd Umbra-X

python -m venv .venv
.\.venv\Scripts\python.exe -m pip install -e ./pipeline
.\.venv\Scripts\python.exe pipeline/fetch_nasa_data.py
.\.venv\Scripts\python.exe pipeline/compile_horizons.py --grid expanded --output web/public/data/planner-release
.\.venv\Scripts\python.exe pipeline/compile_planner.py --output web/public/data/planner-release
```

The upstream terrain products are large. The [planner guide](PLANNER.md) explains what to do if remote raster reads fail. After the data is in place, validate it and start Vite.

```powershell
.\.venv\Scripts\python.exe pipeline/check_planner_release.py web/public/data/planner-release
npm.cmd --prefix web ci
npm.cmd --prefix web run dev -- --host 127.0.0.1 --port 5174
```

Open [the local app](http://127.0.0.1:5174/). The compiled comparisons run in the browser. Optional services provide the research API and on-demand polar terrain. See the [service configuration](infra/docker-compose.yml) for running those services.

## Architecture and technology

| Layer | Implementation |
| --- | --- |
| **Data preparation** | Python, Rasterio, NumPy, pyproj, and Skyfield process LOLA terrain and JPL kernels. The pipeline builds horizon profiles in 360 directions using 20 m local and 80 m regional elevations, and prepares Sun and Earth positions at five-minute intervals. |
| **Simulation and search** | A TypeScript Web Worker runs the scenario calculations. A Rust kernel compiled to WebAssembly accelerates pad searches, with a TypeScript fallback. Recovery ranks alternatives across seven objectives. |
| **Interface** | React and TypeScript handle the scenario controls, timeline, and analysis panels. Three.js and React Three Fiber render the lunar terrain. Vite handles development and builds. |
| **Optional services** | A Node.js API supports Umbra Agent and study jobs. The agent combines deterministic analysis tools with research retrieval over a local corpus. A Python terrain service provides on-demand horizons where supported. |

The model treats Earth visibility as geometric line of sight. Radio performance and ground-station scheduling require separate analysis. Grid-scale slope helps compare sites, while individual landing hazards require finer measurements. Mapped permanently shadowed regions indicate shadow classification. Confirming ice requires separate evidence.

## Verification

With the required dependencies and data in place, run these from the repository root.

```powershell
npm.cmd --prefix web test
npm.cmd --prefix web run build
.\.venv\Scripts\python.exe -m pytest pipeline -q
cargo test --locked --manifest-path rust/umbra-core/Cargo.toml
```

[Scientific method](docs/SCIENTIFIC_METHOD.md) · [Validation matrix](docs/VALIDATION_MATRIX.md) · [Reproducibility guide](docs/REPRODUCIBILITY.md) · [Release notes](RELEASE.md)

## Sources and citations

| Source | Use in Umbra-X |
| --- | --- |
| [NASA GSFC / LRO LOLA south-pole products](https://pgda.gsfc.nasa.gov/products/90) | Elevation, elevation uncertainty, published slopes for comparison, and permanently shadowed region classification. |
| [NASA/JPL NAIF SPICE kernels](https://naif.jpl.nasa.gov/pub/naif/generic_kernels/) and [JPL DE440 documentation](https://ssd.jpl.nasa.gov/doc/de440_de441.html) | Sun and Earth positions and lunar orientation. |
| [NASA/JPL Horizons](https://ssd-api.jpl.nasa.gov/doc/horizons.html) | Independent reference for checking apparent Sun and Earth directions. |
| [NASA/JPL Deep Space Network Coverage and Geometry](https://deepspace.jpl.nasa.gov/dsndocs/810-005/301/301M.pdf) | Station coordinates and geometry reference. |
| [NASA NSSDCA Apollo landing coordinates](https://nssdc.gsfc.nasa.gov/planetary/lunar/lunar_sites.html) and [NASA PDS IM-2 Athena record](https://pds.nasa.gov/ds-view/pds/viewContext.jsp?identifier=urn%3Anasa%3Apds%3Acontext%3Ainstrument_host%3Aspacecraft.clps_to_prime1_athena&version=1.0) | Location references for Apollo and Mons Mouton. |
| [Mazarico et al., lunar polar illumination](https://ntrs.nasa.gov/citations/20120010094) | Research behind the use of horizon profiles to estimate illumination. |
| [Barker et al., LOLA elevation uncertainty](https://ntrs.nasa.gov/citations/20205009660) | How elevation errors can affect predicted lighting. |
| [Fincannon, lunar polar illumination for power analysis](https://ntrs.nasa.gov/citations/20080045536) | Research context for connecting illumination and shade duration to energy storage. |
| [LROC QuickMap](https://quickmap.lroc.im-ldi.com/), [NASA Moon Trek](https://trek.nasa.gov/moon/), and [Canadian Space Agency Moon Exploration](https://www.asc-csa.gc.ca/eng/astronomy/moon-exploration/) | Map references and mission context. |

See [data provenance](docs/DATA_PROVENANCE.md) for the input filenames, kernel hashes, and release sources, and [uncertainty and limitations](docs/UNCERTAINTY_AND_LIMITATIONS.md) for the scope of the model. Library versions are recorded in the [web dependencies](web/package.json), [API dependencies](server/package.json), and [Python dependencies](pipeline/pyproject.toml).

## AI disclosure

We used AI tools during development to help write boilerplate code, draft and revise text, and debug issues. Umbra Agent also uses research retrieval and can use a configured language model to help explain results. The geometry, power estimates, and recovery search are computed by the simulation and search code.

## License

Umbra-X source code is licensed under the [Apache License 2.0](LICENSE). External datasets and research retain their original terms.
