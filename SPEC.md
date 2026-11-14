# Umbra-X static site contract

Each bundle lives at `web/public/data/<site_id>/`. Vite serves it as `data/<site_id>/` relative to the app base URL. The site ID is a lowercase alphanumeric slug with optional hyphen-separated segments. A bundle consists of the seven files below.

## manifest.json

```ts
{
  site_id: string
  name: string
  subtitle: string
  mission_agency: string
  nssdca_reference: {
    apollo_baseline: {
      name: "Apollo 11 (Mare Tranquillitatis)"
      lat: 0.674
      lon: 23.473
      earth_el_deg: 66.2
    }
    clps_missions: string[]
  }
  citations: [
    "Barker, Mazarico et al. (2023) PSJ — LRO LOLA DEM & Error",
    "Gläser et al. (2018) PSS — Two-Site Shadow Complementarity",
    "Paige et al. (2010) Science & NASA ShadowCam (2025) — PSR Radiosity & Cold Traps",
    "Zimmerman, Farrell et al. (NASA GSFC) — Terminator Plasma Wake & Electrostatic Dust Lofting",
    "Hernandez et al. (2025) NASA Langley OPAL/Light Bender & Astrobotic LunaGrid"
  ]
  center_lat: number
  center_lon: number
  moon_trek_url: string
  proj_crs: "+proj=stere +lat_0=-90 +lon_0=0 +k=1 +x_0=0 +y_0=0 +R=1737400 +units=m +no_defs"
  dem_grid: { width: 256, height: 256, pixel_size_m: 20.0 }
  analysis_grid:
    | { rows: 31, cols: 31, spacing_m: 40.0, start_pixel: 98, step_pixel: 2 }
    | { rows: 31, cols: 31, spacing_m: 140.0, start_pixel: 23, step_pixel: 7 }
  mast_heights_m: [1.5, 3.0, 5.0, 10.0, 20.0]
  ephemeris: {
    start_utc: string
    step_hours: 1
    num_steps: 720
    timestamps: string[]
    sun_az_deg: number[]
    sun_el_deg: number[]
    earth_az_deg: number[]
    earth_el_deg: number[]
  }
}
```

Center coordinates are planetocentric latitude and east-positive longitude in lunar ME/DE421. The center projects to the midpoint of the 5.12 km × 5.12 km tile footprint. Columns increase with projected x and rows decrease with projected y. The upper-left pixel center is `(center_x - 2550, center_y + 2550)` in projected meters. Candidate `[r,c]` maps to DEM pixel `[23 + 7*r, 23 + 7*c]` for indices 0 through 30. The 961 samples span pixels 23 through 233, or 4.20 km between outer candidate centers on either axis.

The five ephemeris arrays have 720 elements each. UTC timestamps are ISO 8601 with a trailing `Z`, starting at `start_utc`. Positions are apparent, airless, topocentric disk-center angles at the site center. Azimuth is measured clockwise from true north in `[0,360)`. Elevation is in degrees above the local horizontal. The browser uses center ephemerides as a local approximation for the center candidate. For integer delay `d` from 0 to 15 Earth days, the nominal 15-day mission uses indices `24*d` through `24*d + 359`, inclusive. Counts represent hourly samples. Sub-hour transitions, finite disks, eclipses and radio link budgets need additional models.

## Binary payloads

Terrain and horizon values are finite little-endian IEEE-754 Float32. The PSR mask uses unsigned bytes. Files contain no headers or padding. Axes are zero-based, flattened in row-major order with the final axis contiguous.

| File | Shape | Bytes | Meaning |
| --- | --- | ---: | --- |
| `dem_elev.bin` | `[256,256]` | 262,144 | LOLA elevation in meters relative to the 1,737,400 m sphere |
| `dem_slope.bin` | `[256,256]` | 262,144 | Gradient-derived slope in degrees. Use strict `<5°` for the project screening rule |
| `dem_err.bin` | `[256,256]` | 262,144 | Input LOLA 1-sigma height uncertainty in meters, resampled to the export grid |
| `horizons.bin` | `[31,31,5,360]` | 6,919,200 | Terrain horizon elevation in degrees by candidate, mast and integer true azimuth |
| `horizons_err.bin` | `[31,31,360]` | 1,383,840 | Largest first-order angular sigma across the five mast-specific horizon samples |
| `psr_mask.bin` | `[256,256]` | 65,536 | `Uint8Array` with 1 for mapped permanent shadow and 0 elsewhere, aligned with the DEM |

The compact grid maps candidate `[r,c]` to pixel `[98 + 2*r, 98 + 2*c]` and spans 1.20 km on each axis. For either grid, a candidate's PSR classification is the byte at `(start_pixel + step_pixel*r) * 256 + start_pixel + step_pixel*c`. The classification preserves the NASA LOLA PSR map by nearest-neighbor resampling.

The horizon index is `(((r * 31 + c) * 5 + mast) * 360 + az)`. The error index is `((r * 31 + c) * 360 + az)`. Consumers can interpolate azimuth cyclically between bins 359 and 0. Rays convert each candidate's true-north azimuth to grid bearing and sample bilinear terrain every 20 m of local ground distance. They stop at the tile boundary and subtract the spherical curvature drop `d²/(2R)`. At each mast's highest-angle sample, angular uncertainty is `atan2(interpolated height sigma, distance)` in degrees. The shared error bin stores the maximum of those five values. Terrain beyond the tile, observer height error and changes in which terrain sample controls the horizon are outside this uncertainty model.

The radiosity solver accepts direct incident flux, patch albedo and view factors supplied by the caller. It solves diffuse shortwave interreflection using `B = ρ(E + FB)`. The bundle carries no radiosity output or thermal/ice predictions.

## Source verification

- NASA’s challenge asks for comparisons of landing sites and dates using terrain-relative Sun and Earth visibility. The current app displays the center candidate of one compiled site at a time. [2026 Lunar Landing Site Navigator](https://www.spaceappschallenge.org/2026/challenges/lunar-landing-site-navigator/)
- Barker et al. (2023) describe updated polar LOLA terrain, uncertainties and a 20 m PSR map. Their 2021 four-site study analyzes how height errors affect illumination. A raster’s sampling interval can be finer than the effective terrain resolution. Preserve product filenames, versions and units with each input. [Barker et al. 2023](https://doi.org/10.3847/PSJ/acf3e1), [Barker et al. 2021](https://doi.org/10.1016/j.pss.2020.105119), [NASA Goddard terrain products](https://pgda.gsfc.nasa.gov/products/90)
- Gläser et al. (2018) identify favorable locations on Shackleton rim and Connecting Ridge from simulations spanning 20 years. A proposed pair’s complementary coverage requires evaluating the union of its time-aligned illumination samples over the mission period. The 30-day bundle cannot establish permanent shadow. [Gläser et al. 2018](https://ntrs.nasa.gov/api/citations/20170007365/downloads/20170007365.pdf)
- Diviner identifies temperatures that can preserve volatiles. ShadowCam images use scattered light and their radiance also depends on surface reflectance and viewing geometry. Local ice abundance requires independent evidence. [Paige et al. 2010](https://doi.org/10.1126/science.1187726), [Li et al. 2026](https://doi.org/10.1126/sciadv.aec8211)
- Terminator wake and electrostatic charging studies describe potential dust transport mechanisms. The model supplies no site-specific dust hazard frequencies. [Farrell et al. 2007](https://doi.org/10.1029/2007GL029312), [Zimmerman et al. 2016](https://doi.org/10.1002/2016JE005049)
- Light Bender is a surface sunlight-redirection concept. OPAL is an orbital laser power-beaming concept with a 2026 NASA technical record. LunaGrid-Lite is a tethered lunar power demonstration project. The display citation strings above retain the requested wording. [NASA Light Bender](https://www.nasa.gov/general/light-bender/), [NASA OPAL](https://ntrs.nasa.gov/citations/20260000477), [NASA LunaGrid-Lite](https://techport.nasa.gov/projects/147018)
- NSSDCA lists Apollo 11 at 0.67416° N, 23.47314° E. The 66.2° manifest value is a project reference constant. Calculate epoch-specific Earth elevation with an ephemeris. The strict 5° slope rule is a project screening choice, and a 20 m raster cannot establish landing-gear-scale safety. [NSSDCA landing site coordinates](https://nssdc.gsfc.nasa.gov/planetary/lunar/lunar_sites.html), [Skyfield lunar frames](https://rhodesmill.org/skyfield/planetary.html)
