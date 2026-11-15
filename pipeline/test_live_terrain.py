"""Tests for scoped 80S-90S live polar terrain raytracing and boundary coverage masks."""
from pathlib import Path

import numpy as np
import pytest
import rasterio
from rasterio.transform import from_origin

from live_terrain import PolarTerrainService
from umbra_x.compiler import CRS_POLAR


def _synthetic_polar_dem(tmp_path: Path) -> Path:
    # Small synthetic south-polar stereographic TIFF spanning +-120 km around the South Pole.
    width = 300
    px = 800.0
    half = width * px / 2.0
    transform = from_origin(-half, half, px, px)
    x = np.linspace(-half + px / 2, half - px / 2, width, dtype=np.float32)
    y = np.linspace(half - px / 2, -half + px / 2, width, dtype=np.float32)
    xx, yy = np.meshgrid(x, y)
    # Add a ridge 20 km north of pole and crater walls elsewhere.
    dem = 500.0 * np.exp(-((xx**2 + (yy - 20_000.0) ** 2) / (12_000.0**2)))
    path = tmp_path / "synthetic_80s.tif"
    with rasterio.open(
        path,
        "w",
        driver="GTiff",
        height=width,
        width=width,
        count=1,
        dtype=np.float32,
        crs=CRS_POLAR.to_wkt(),
        transform=transform,
        nodata=np.nan,
    ) as dst:
        dst.write(dem.astype(np.float32), 1)
    return path


def test_polar_raytrace_coverage_and_boundary_clipping(tmp_path: Path):
    dem_path = _synthetic_polar_dem(tmp_path)
    svc = PolarTerrainService(dem_path, preload=True)

    # Interior coordinate near the South Pole has 360/360 rays inside bounds for 48 km.
    interior = svc.query(-89.8, 0.0, mast_m=5.0, max_dist_m=48_000)
    assert interior["complete"] is True
    assert interior["covered_azimuths"] == 360
    assert len(interior["horizon_96km"]) == 360
    assert interior["horizon_96km"][0] > -2.0

    # Coordinate close to the 80S / DEM edge loses coverage on northward rays (az ~ 0 deg).
    edge = svc.query(-86.5, 0.0, mast_m=5.0, max_dist_m=48_000)
    assert edge["complete"] is False
    assert edge["covered_azimuths"] < 360
    assert edge["coverage"][0] == 0

    # Latitude outside -90..-80 raises ValueError explicitly.
    with pytest.raises(ValueError, match="outside supported"):
        svc.query(-69.37, 32.32)
