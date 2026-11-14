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

Supply an elevation GeoTIFF and a height-sigma GeoTIFF in the same lunar ME/DE421 coordinate frame, with valid embedded lunar CRS definitions and coverage across the complete tile. Elevation must be relative to the 1,737,400 m reference sphere. The compiler applies source GDAL scale and offset. The [NASA Goddard south-polar LOLA archive](https://pgda.gsfc.nasa.gov/products/90) lists the `LDEM_80S_20MPP_ADJ.TIF` elevation and `LDEM_80S_20MPP_ADJ_ERR.TIF` height error products.

Place `de421.bsp`, `moon_080317.tf`, `pck00008.tpc` and `moon_pa_de421_1900-2050.bpc` in a local kernel directory. The [Skyfield lunar-frame guide](https://rhodesmill.org/skyfield/planetary.html) lists the JPL files. The complete mission period must fall within kernel coverage.

Use east-positive longitude in the range −180° to 180°. Here is a complete command with illustrative coordinates and local input paths:

```powershell
.\.venv\Scripts\umbra-compile.exe --site-id connecting-ridge --name "Connecting Ridge" --agency "NASA" --lat -89.45 --lon -137.3 --start-utc 2026-11-14T00:00:00Z --dem inputs/lola-elevation.tif --error inputs/lola-height-sigma.tif --kernels inputs/kernels --output web/public/data
```

Run the web dev server and enter the compiled site ID. Rebuild the web app after adding a bundle to include it in production output. The compiler publishes each bundle as a new directory and rejects existing IDs. See [SPEC.md](SPEC.md) for the byte layout, modeling limits and research sources.

Three-node microgrid optimization, rover routing and actuarial underwriting are project directions beyond this foundation.
