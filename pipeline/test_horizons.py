"""Validate horizon geometry and terrain-only visibility in the compiled sites."""

import json

import numpy as np
from pyproj import Transformer
import pytest
from scipy.ndimage import map_coordinates

from fetch_nasa_data import CACHE, POLAR_SITES
from umbra_x.compiler import CRS_POLAR, MASTS, PIXEL, RADIUS, WIDTH, march


def test_horizon_azimuth_uncertainty_and_mast_order():
    elevation = np.zeros((WIDTH, WIDTH))
    error = np.zeros_like(elevation)
    elevation[126, 128] = 100
    error[126, 128] = 5
    horizon, uncertainty = march(
        elevation, error, np.zeros((31, 31)), np.full((31, 31), PIXEL), 98, 2,
    )
    assert np.all(np.diff(horizon, axis=2) <= 0)
    assert np.all(np.diff(horizon[15, 15, :, 0]) < 0)
    assert horizon[15, 15, 0, 180] < 0
    expected = np.rad2deg(np.arctan2(100 - MASTS - 40**2 / (2 * RADIUS), 40))
    np.testing.assert_allclose(horizon[15, 15, :, 0], expected, atol=1e-5)
    assert uncertainty[15, 15, 0] == pytest.approx(np.rad2deg(np.arctan2(5, 40)))


def line_of_sight(elevation, a, b, ground_distance, height_a, height_b):
    # Straight segment between endpoints, sampling terrain in both directions
    # along one reciprocal path. Spherical bulge is relative to the endpoint chord.
    fractions = np.linspace(0, 1, int(np.ceil(ground_distance / (PIXEL / 2))) + 1)[1:-1]
    pixels = a[:, None] + (b - a)[:, None] * fractions
    surface = map_coordinates(elevation, pixels, order=1)
    bulge = ground_distance**2 * fractions * (1 - fractions) / (2 * RADIUS)
    beam = height_a + (height_b - height_a) * fractions
    return bool(np.all(beam > surface + bulge))


@pytest.fixture(scope="module")
def site_visibility():
    root = CACHE.parent.parent / "web" / "public" / "data"
    results = {}
    for site in POLAR_SITES:
        tile = root / site.id.replace("_", "-")
        if not (tile / "manifest.json").exists():
            pytest.skip("Run compile_horizons.py to generate the NASA site packs")
        manifest = json.loads((tile / "manifest.json").read_text(encoding="utf-8"))
        grid = manifest["analysis_grid"]
        samples = grid["start_pixel"] + np.arange(grid["rows"]) * grid["step_pixel"]
        rows, cols = np.meshgrid(samples, samples, indexing="ij")
        points = np.stack((rows.ravel(), cols.ravel()), axis=1)
        horizon = np.fromfile(tile / "horizons.bin", dtype="<f4").reshape(-1, len(MASTS), 360)
        assert np.isfinite(horizon).all() and np.all(np.diff(horizon, axis=1) <= 0)
        elevation = np.fromfile(tile / "dem_elev.bin", dtype="<f4").reshape(WIDTH, WIDTH).astype(float)
        mask = np.fromfile(tile / "psr_mask.bin", dtype=np.uint8).reshape(WIDTH, WIDTH)
        forward = Transformer.from_crs(CRS_POLAR.geodetic_crs, CRS_POLAR, always_xy=True)
        inverse = Transformer.from_crs(CRS_POLAR, CRS_POLAR.geodetic_crs, always_xy=True)
        x, y = forward.transform(site.lon, site.lat)
        longitude, _ = inverse.transform(x + (cols.ravel() - 127.5) * PIXEL, y - (rows.ravel() - 127.5) * PIXEL)
        ephem = manifest["ephemeris"]
        # Apply local meridian convergence to the site-center Sun direction.
        az = (np.asarray(ephem["sun_az_deg"]) + site.lon - longitude[:, None]) % 360
        bins = np.floor(az).astype(int)
        node = np.arange(len(points))[:, None]
        ridge_horizon = horizon[node, -1, bins]
        ridge_horizon += (horizon[node, -1, (bins + 1) % 360] - ridge_horizon) * (az - bins)
        low_horizon = horizon[node, 0, bins]
        low_horizon += (horizon[node, 0, (bins + 1) % 360] - low_horizon) * (az - bins)
        sun = np.asarray(ephem["sun_el_deg"])
        ground_pixel = PIXEL * (1 - np.sin(np.deg2rad(site.lat))) / 2
        results[site.id] = elevation, mask[rows, cols].ravel(), points, sun > ridge_horizon, sun > low_horizon, ground_pixel
    return results


def test_complementary_ridges(site_visibility):
    # Compare the pair against the better single ridge over the same 720 hours.
    for site, (elevation, mask, points, lit, _, ground_pixel) in site_visibility.items():
        ridges = np.flatnonzero(~mask.astype(bool) & (lit.mean(axis=1) > 0.5))
        dark = (~lit[ridges]).astype(np.int32)
        hours = dark.sum(axis=1)
        joint = dark @ dark.T
        a_indices, b_indices = np.where(np.triu(5 * joint < 2 * np.minimum.outer(hours, hours), k=1))
        for ai, bi in zip(a_indices, b_indices, strict=True):
            a, b = points[ridges[ai]], points[ridges[bi]]
            distance = np.linalg.norm(b - a) * ground_pixel
            if line_of_sight(elevation, a, b, distance, elevation[tuple(a)] + MASTS[-1],
                             elevation[tuple(b)] + MASTS[-1]):
                baseline = min(hours[ai], hours[bi])
                print(f"{site}: ridge pixels {a.tolist()} and {b.tolist()}, {baseline} to {joint[ai, bi]} dark hours")
                return
    pytest.fail("No mutually visible ridge pair reduces joint solar outage by more than 60%")


def test_cold_trap_has_downward_rim_link(site_visibility):
    for site, (elevation, mask, points, lit, low_lit, ground_pixel) in site_visibility.items():
        fractions = low_lit.mean(axis=1)
        targets = np.flatnonzero((mask == 1) & (fractions < 0.1))
        rims = points[(mask == 0) & (lit.mean(axis=1) > 0.5)]
        for index in targets:
            target = points[index]
            target_ground = elevation[tuple(target)]
            for rim in rims:
                rim_ground = elevation[tuple(rim)]
                distance = np.linalg.norm(rim - target) * ground_pixel
                if rim_ground > target_ground and line_of_sight(
                    elevation, rim, target, distance, rim_ground + MASTS[-1], target_ground + MASTS[0],
                ):
                    print(f"{site}: rim pixel {rim.tolist()} sees PSR pixel {target.tolist()} with {fractions[index]:.1%} illumination")
                    return
    pytest.fail("No mapped PSR candidate below 10% illumination has a downward line of sight from a sunlit rim")
