import numpy as np
import rasterio
from rasterio.transform import from_origin

from umbra_x.compiler import CRS_POLAR, MASTS, PIXEL, RADIUS, WIDTH, march, read_tile
from umbra_x.radiosity import solve_radiosity


def test_read_tile_applies_gdal_scale_and_offset(tmp_path):
    path = tmp_path / "terrain.tif"
    transform = from_origin(-2560, 2560, PIXEL, PIXEL)
    with rasterio.open(
        path, "w", driver="GTiff", count=1, width=WIDTH, height=WIDTH,
        dtype="int16", crs=CRS_POLAR.to_wkt(), transform=transform,
    ) as raster:
        raster.write(np.full((WIDTH, WIDTH), 24, dtype=np.int16), 1)
        raster.scales = (0.5,)
        raster.offsets = (-2.0,)
    np.testing.assert_allclose(read_tile(path, transform), 10)


def test_horizons_include_curvature_and_mast_height():
    flat = np.zeros((WIDTH, WIDTH))
    longitudes = np.zeros((31, 31))
    horizon, sigma = march(flat, flat, longitudes, np.full_like(longitudes, PIXEL))
    assert horizon.shape == (31, 31, 5, 360)
    assert sigma.shape == (31, 31, 360)
    assert np.all(horizon < 0)
    assert np.all(np.diff(horizon, axis=2) < 0)
    assert not np.any(sigma)
    distances = np.arange(20, 2560 + 10, 10)
    expected = np.max(-MASTS[:, None] / distances - distances / (2 * RADIUS), axis=1)
    np.testing.assert_allclose(horizon[15, 15, :, 0], np.rad2deg(np.arctan(expected)), atol=1e-6)


def test_radiosity_reflects_flux_into_shadow():
    result = solve_radiosity([1000, 0], [0.1, 0.2], [[0, 0.5], [0.5, 0]])
    expected_lit = 100 / (1 - 0.05 * 0.1)
    np.testing.assert_allclose(result, [expected_lit, expected_lit * 0.1])
