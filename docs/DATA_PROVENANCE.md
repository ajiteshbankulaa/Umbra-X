# Data Provenance & Cryptographic Integrity

Every external terrain raster and planetary ephemeris kernel used in Umbra-X has been verified against upstream NASA GSFC PGDA and JPL NAIF endpoints.

## 1. NAIF SPICE / DE440 Kernels (`MOON_ME_DE440_ME421`)

Recorded and pinned in [`pipeline/fixtures/horizons-centers.json`](../pipeline/fixtures/horizons-centers.json) and each regional `planner.json`:

| File | Size (bytes) | SHA-256 Digest | Upstream NAIF URL |
| --- | ---: | --- | --- |
| `de440s.bsp` | `32,726,016` | `c1c7feeab882263fc93a9d5a5b2ddd71b54826cdf65d8d17a76126b260a49f2` | `https://naif.jpl.nasa.gov/pub/naif/generic_kernels/spk/planets/de440s.bsp` |
| `moon_de440_250416.tf` | `19,478` | `a47c71e9c9f33796bdafb2c9d69a7ee447b6016ecad80f71cd6f3e479f9cf768` | `https://naif.jpl.nasa.gov/pub/naif/generic_kernels/fk/satellites/moon_de440_250416.tf` |
| `moon_pa_de440_200625.bpc` | `12,863,488` | `60cd55aa401ea2ea97360636f567554bfe4e37bb829f901b4460a455dfaf783f` | `https://naif.jpl.nasa.gov/pub/naif/generic_kernels/pck/moon_pa_de440_200625.bpc` |
| `pck00011.tpc` | `131,226` | `3dff7b1dbeceaa01f25467767d3fa25816051c85d162d1edf04acb310ee28bb1` | `https://naif.jpl.nasa.gov/pub/naif/generic_kernels/pck/pck00011.tpc` |

## 2. NASA GSFC PGDA LRO LOLA Products

Citation: Barker et al. (2023), *Planetary Science Journal*, DOI [`10.3847/PSJ/acf3e1`](https://doi.org/10.3847/PSJ/acf3e1); Data DOI [`10.60903/gsfcpgda-lola-spole`](https://doi.org/10.60903/gsfcpgda-lola-spole); Catalog [`https://pgda.gsfc.nasa.gov/products/90`](https://pgda.gsfc.nasa.gov/products/90).

| Product | Upstream URL | Verified Size (bytes) | Role in Umbra-X |
| --- | --- | ---: | --- |
| `LDEM_80S_20MPP_ADJ.TIF` | `https://pgda.gsfc.nasa.gov/data/LOLA_20mpp/LDEM_80S_20MPP_ADJ.TIF` | `2,696,082,051` | Local `20 m/px` elevation (`5.12 km` tile + hybrid near-field) |
| `LDEM_80S_20MPP_ADJ_ERR.TIF` | `https://pgda.gsfc.nasa.gov/data/LOLA_20mpp/LDEM_80S_20MPP_ADJ_ERR.TIF` | `3,954,709,201` | Local `1σ` vertical uncertainty `dem_err.bin` & `horizons_err.bin` |
| `LDSM_80S_20MPP_ADJ.TIF` | `https://pgda.gsfc.nasa.gov/data/LOLA_20mpp/LDSM_80S_20MPP_ADJ.TIF` | `3,778,056,355` | Official PGDA slope reference (`lola_slope` benchmark comparison) |
| `LPSR_80S_20MPP_ADJ.TIF` | `https://pgda.gsfc.nasa.gov/data/LOLA_20mpp/LPSR_80S_20MPP_ADJ.TIF` | `154,221,202` | Persistent shadow classification mask (`psr_mask.bin`) |
| `LDEM_80S_80MPP_ADJ.TIF` | `https://pgda.gsfc.nasa.gov/data/LOLA_80mpp/LDEM_80S_80MPP_ADJ.TIF` | `189,158,392` | `80 m/px` south-polar regional extension (`sha256=82030dcbdd7c4bb0c7d858e9b4b293b9f2cda5a543ba31ec0f42784bd6beee5a`) |

*(Note: PGDA `LOLA_5mpp` (`5 m/px`) GeoTIFFs are published separately under the older **DE421 `MOON_ME`** frame for specific candidate sites and exclude Mons Mouton; Umbra-X retains consistent `DE440` `LOLA_20mpp` / `80mpp` products across all three regions.)*

## 3. Compiled Release Shared Content-Addressed Vectors

- **Common 5-Minute Ephemeris (`web/public/data/planner-release/planner/b7ca9394...bin`):**
  SHA-256 `b7ca9394446e781b5eaab0308b6e4ca58f471a41ac3eb115dc5e314926238321`, `8,641 × 12` `float64` (`829,536` bytes), apparent (LT+S) vectors covering `2026-11-14T00:00:00Z` through `2026-12-14T00:00:00Z`.
- **Site Centers:** `shackleton-ridge` (`-89.450°, 222.000°`), `mons-mouton` (`-84.790°, 29.200°` matching IM-2 Athena PDS rounded site), `malapert-massif` (`-86.040°, 2.700°`), and educator reference `apollo-11` (`0.674°, 23.473°`, NSSDCA).
- **DSN Complexes (`spkcpt.html` / ITRF):** `DSS-14` Goldstone, `DSS-65` Madrid, and `DSS-43` Canberra WGS84 coordinates encoded in `pipeline/compile_planner.py` and `web/src/planner/model.ts`.
- **PGDA Slope Cross-Check (`LDSM_80S_20MPP_ADJ.TIF`, `slopeBenchmark` across 961 pads/site):** Compiled `20 m` finite-difference slopes vs. official PGDA LDSM measure `median / p95` absolute differences of `0.1753° / 0.7066°` (`shackleton-ridge`), `0.0794° / 0.3111°` (`mons-mouton`), and `0.2196° / 0.8144°` (`malapert-massif`).
- **Optical Imagery Cross-Reference Boundary (LROC NAC & KPLO ShadowCam):** Geomorphic `LPSR_80S_20MPP_ADJ.TIF` masks and `20 m + 80 m` LOLA raymarch horizons identify geometric shadow candidates only; independent timestamped optical imagery verification (e.g., LROC NAC / ShadowCam DOI [`10.1126/sciadv.aec8211`](https://doi.org/10.1126/sciadv.aec8211)) remains an open external gate, and PSR labels do not verify surface water ice.
