# Umbra-X

Umbra-X is a lunar south pole terrain and visibility prototype for the 2026 NASA Space Apps Challenge. The Python pipeline compiles terrain and hourly ephemerides. The browser loads static site bundles, displays the elevation mesh and evaluates Sun and Earth visibility across a 15-day window.

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
- QuickMap and Moon Trek provide interactive map references. CSA's Moon Exploration portal provides partner mission context. [QuickMap](https://quickmap.lroc.asu.edu/) · [Moon Trek](https://trek.nasa.gov/moon/) · [CSA Moon Exploration](https://www.asc-csa.gc.ca/eng/astronomy/moon-exploration/)
- Mons Mouton's center matches NASA PDS's rounded IM-2 Athena landing coordinates. Malapert Massif is a regional benchmark, with IM-1's landing site in the Malapert A region farther north. A mapped PSR indicates terrain classified as persistently shadowed. Ice presence requires independent evidence. [NASA PDS Athena record](https://pds.nasa.gov/ds-view/pds/viewContext.jsp?identifier=urn%3Anasa%3Apds%3Acontext%3Ainstrument_host%3Aspacecraft.clps_to_prime1_athena&version=1.0) · [NASA CLPS deliveries](https://www.nasa.gov/commercial-lunar-payload-services/clps-providers/)

### Build a web bundle

To rebuild all three browser bundles with the compact 40 m candidate grid and PSR mask after fetching:

```powershell
.\.venv\Scripts\python.exe pipeline/compile_horizons.py
```

Pass `--grid expanded` to use 140 m candidate spacing. The verification plot from the fetcher shows the expanded footprint.

Supply an elevation GeoTIFF and a height-sigma GeoTIFF in the same lunar ME/DE421 coordinate frame, with valid embedded lunar CRS definitions and coverage across the complete tile. Elevation must be relative to the 1,737,400 m reference sphere. The compiler applies source GDAL scale and offset. The [NASA Goddard south-polar LOLA archive](https://pgda.gsfc.nasa.gov/products/90) lists the `LDEM_80S_20MPP_ADJ.TIF` elevation and `LDEM_80S_20MPP_ADJ_ERR.TIF` height error products.

Place `de421.bsp`, `moon_080317.tf`, `pck00008.tpc` and `moon_pa_de421_1900-2050.bpc` in a local kernel directory. The [Skyfield lunar-frame guide](https://rhodesmill.org/skyfield/planetary.html) lists the JPL files. The complete mission period must fall within kernel coverage.

Use east-positive longitude in the range −180° to 180°. Here is a complete command with illustrative coordinates and local input paths:

```powershell
.\.venv\Scripts\umbra-compile.exe --site-id connecting-ridge --name "Connecting Ridge" --agency "NASA" --lat -89.45 --lon -137.3 --start-utc 2026-11-14T00:00:00Z --dem inputs/lola-elevation.tif --error inputs/lola-height-sigma.tif --psr inputs/lola-psr.tif --kernels inputs/kernels --output web/public/data
```

Run the web dev server and enter the compiled site ID. Rebuild the web app after adding a bundle to include it in production output. The compiler publishes each bundle as a new directory and rejects existing IDs. See [SPEC.md](SPEC.md) for the byte layout, modeling limits and research sources.

## Client scientific engine

`web/src/engine/heliosEngine.ts` takes a loaded `SiteData` bundle. Call `simulateGridWindow` and `computeTerminatorPlasmaRisk`, then pass those results to the network, route, and commercial functions. Hourly arrays use `hour * nodeCount + node`. Run `npm test` from `web` with Node 22.12+.

- The solar disk calculation integrates the circular segment above a locally straight horizon. Bearings apply local meridian convergence to site-center ephemerides. Thermal equilibrium uses a fourth-power blend between configurable shadow and grazing-sun endpoints, with 65 K and 225 K defaults. Thermal inertia, terrain incidence, and local ephemeris parallax are outside this model. [Diviner cold-trap observations](https://pubmed.ncbi.nlm.nih.gov/20966246/)
- The plasma and dust outputs are sensitivity scenarios. The default 165 V potential contrast and illustrative 4 m transition width set the subgrid field scale. Dust deposition, optical extinction, and ESD thresholds are configurable proxies. [NASA lunar plasma wake study](https://ntrs.nasa.gov/citations/20110013543)
- Network ranking minimizes joint darkness first and uses Earth blackout hours as the tie-breaker. The receiver requires a mapped PSR, mean temperature below 110 K, and a downward terrain LOS. Passive flux uses one diffuse bounce from visible terrain facets and reports the hourly samples with positive flux. Active delivery uses an assumed efficiency and modeled surplus. [ShadowCam ice study](https://doi.org/10.1126/sciadv.aec8211) · [NASA Light Bender](https://www.nasa.gov/general/light-bender/)
- Rover routing minimizes weighted hourly costs with cardinal moves of one candidate cell, or 40 m and 140 m for the compact and expanded grids. It checks the slope of intervening DEM pixels. The result reports residual darkness and hazard hours.
- The commercial scenario sizes initially full batteries from the maximum cumulative net energy deficit. LCOE covers modeled battery and incremental hardware delivery capital divided by served energy over repeated mission windows. Extraction requires caller-supplied ice inventory. The underwriting output is a uniform spatial scenario across an axis-aligned landing ellipse with binary mission-loss VaR. The cost, failure thresholds, and insurance tiers are model inputs and outputs rather than NASA rates or insurance quotes.

The decision planner and the reproducible NASA release-data build are documented in [PLANNER.md](PLANNER.md).
