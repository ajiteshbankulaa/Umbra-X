# Scientific Method

Umbra-X is a lunar south pole **mission-screening** tool designed to compare candidate landing pads, mast heights, and launch windows from `2026-11-14T00:00:00Z` through `2026-12-14T00:00:00Z`. It is not a certified flight-operations system.

## 1. Geodetic Reference & Coordinate Frame

- **Body & Frame:** Spherical lunar datum `R = 1,737,400 m`, Mean Earth / Polar Axis frame `MOON_ME_DE440_ME421` (realized from NAIF `de440s.bsp`, `moon_pa_de440_200625.bpc`, `moon_de440_250416.tf`, and `pck00011.tpc`).
- **Map Projection:** South Polar Stereographic (`+proj=stere +lat_0=-90 +lon_0=0 +k=1 +x_0=0 +y_0=0 +R=1737400 +units=m +no_defs`).
- **Conformal Map Scale:** For planetocentric latitude $\phi$ (`lat_deg < 0`), polar stereographic map spacing $\Delta x_{\mathrm{map}}$ relates to true lunar surface arc spacing via
  $$\Delta x_{\mathrm{true}} = \Delta x_{\mathrm{map}} \cdot \frac{1 - \sin \phi}{2}.$$
  `umbra_x/compiler.py`, `pipeline/live_terrain.py`, and `pipeline/fetch_nasa_data.py` (`compute_geodetic_slope`) apply this factor when converting map finite differences to surface slope.

## 2. Terrain-Horizon Raymarching

- **Hybrid Compiled Model (`web/public/data/planner-release/`):** Combines `256 × 256` local `20 m/px` LOLA tiles (`LDEM_80S_20MPP_ADJ.TIF`) out to `1,800 m` with `80 m/px` regional LOLA (`LDEM_80S_80MPP_ADJ.TIF`) out to `96 km` (with a `48 km` comparison layer and `160 m` overlap (`localOverlapM = 160`) outside `(west+160, south+160, east-160, north-160)`).
- **Spherical Geodesic Geometry:** Along 360 true-north azimuths (`1.0°` step), rays advance along lunar great circles by central angle $\psi = d / R$. With observer radius $r_0 = R + z_{\mathrm{obs}} + h_{\mathrm{mast}}$ and terrain radius $r_p = R + z_p$, horizon sine elevation is
  $$\sin \alpha = \frac{r_p \cos \psi - r_0}{\sqrt{r_p^2 + r_0^2 - 2 r_p r_0 \cos \psi}},$$
  storing both horizon angle $\alpha$ and controlling occluder distance $d$.
- **Live On-Demand Queries (`pipeline/live_terrain.py`):** Queries outside the three curated regions evaluate `80 m/px` LOLA (`80°S–90°S`) directly, returning explicit per-azimuth coverage flags (`coverage[360]`) wherever rays exit the `LDEM_80S_80MPP_ADJ.TIF` footprint (`-80°S`).

## 3. Ephemeris & Topocentric Projection

- **5-Minute State Vectors (`vectors.bin`):** `pipeline/compile_planner.py` writes `8,641` UTC steps (`stepMinutes = 5`, `float64` `<f8`, shape `[8641, 12]`) containing instantaneous geometric Moon-center to Sun (`0:3`) and Earth-center (`3:6`) vectors in `MOON_ME_DE440_ME421`, plus Goldstone `DSS-14` (`ITRF = [-2353621.365667699, -4641341.49114994, 3677052.329319744]` m) Moon-relative position (`6:9`) and WGS84 surface normal (`9:12`).
- **Per-Pad Topocentric Basis (`web/src/planner/model.ts`):** For each pad (`961` nodes at `140 m` spacing across `31 × 31`), observer position $(R + h + h_{\mathrm{mast}})\,\hat{u}$ shifts parallax cleanly to every corner and flank pad, projecting relative vectors onto local East-North-Up `(east, north, up)` axes.
- **3-Complex NASA DSN Check (`model.ts` `evalDsnComplexes`):** Evaluates geometric Earth-station visibility simultaneously across `DSS-14` (Goldstone), `DSS-63` (Madrid: `[4849092.518, -360180.348, 4115109.251]` m), and `DSS-43` (Canberra: `[-4460894.92, 2682361.55, -3674748.58]` m) against a `10°` local station elevation mask using WGS84 normals. Geometric visibility is **not** an RF link budget or DSN schedule allocation.

## 4. Solar Disk, Power, & Uncertainty Models

- **Solar Visibility:** `diskFraction` models a `0.2665°` radius circular Sun above a locally flat interpolated skyline $h(\mathrm{az}) + \sigma \cdot \sigma_h(\mathrm{az})$. Default illumination threshold is `solarThreshold = 0.1` (`10%` disk).
- **Calibrated Horizon Uncertainty (`horizons_err.bin`):** Where distant regional terrain (`> local_distance`) controls the horizon, angular sigma combines observer uncertainty `dem_err` in quadrature with `2.5 m` regional 80 m error (`atan2(hypot(sigma_obs, 2.5), distance)`); otherwise it preserves local 20 m `atan2(sigma_p, d_p)` taking the max across the five mast heights (`1.5, 3.0, 5.0, 10.0, 20.0 m`).
- **Power & Battery Model (`web/src/planner/model.ts`):** Deterministic step energy balance with round-trip storage efficiency `0.95`, usable depth of discharge `0.8`, `300 W` charge/discharge inverter cap, and either horizontal or vertical tracked PV incidence. Viability (`feasible`) requires both zero unmet load (`unmetWh < 1e-6`) and `hardwareKg + batteryKg <= budgetKg`.

## 5. Epistemic Confidence Classification

`web/src/planner/confidence.ts` classifies each scenario domain cleanly across four explicit levels: `Model-supported`, `Sensitive`, `Incomplete`, and `Not modeled` (RF link margins/scheduling, sub-20 m boulder/slope hazards, regolith thermal transients, and PSR ice ground-truth).
