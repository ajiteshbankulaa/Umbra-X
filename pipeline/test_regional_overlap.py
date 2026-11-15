import numpy as np
from rasterio.transform import from_origin

from compile_planner import calibrated_horizon_uncertainty, extend
from umbra_x.compiler import compile_horizons, compile_horizons_with_distance


def test_regional_ridge_between_tile_edge_and_old_start():
    # At 89°S, due north follows +y. Fine terrain ends ~450 m ahead.
    radius = 1737400
    y = 2 * radius * np.tan(np.deg2rad(0.5))
    top = y + 2400
    terrain = np.zeros((60, 60), dtype=np.float32)
    ridge = int((top - y - 1000) / 80)
    terrain[ridge - 1:ridge + 2, :] = 120
    local = np.zeros((1, 5, 360), dtype=np.float32)
    horizon, distance, covered = extend(
        local, terrain, np.array([[-89., 0., 0.]]), (-2400., top),
        2000, (-2000., y - 2000, 2000., y + 450),
    )
    assert covered[0, 0] == 1
    assert horizon[0, 2, 0] > 5
    assert 450 < distance[0, 2, 0] < 1800


def test_local_distance_preserved_and_uncertainty_calibrated():
    radius = 1737400
    y = 2 * radius * np.tan(np.deg2rad(0.5))
    top = y + 2400
    terrain = np.zeros((60, 60), dtype=np.float32)
    # Azimuth 0 is blocked regionally at ~1000m; azimuth 180 remains unobstructed regionally.
    ridge = int((top - y - 1000) / 80)
    terrain[ridge - 1:ridge + 2, :] = 200
    local = np.zeros((1, 5, 360), dtype=np.float32)
    local[0, :, 180] = 3.0
    local_dist = np.full((1, 5, 360), 220.0, dtype=np.float32)
    local_sigma = np.full((1, 5, 360), 1.4, dtype=np.float32)

    horizon, distance, _covered = extend(
        local, terrain, np.array([[-89., 0., 0.]]), (-2400., top),
        2000, (-2000., y - 2000, 2000., y + 450), local_dist,
    )
    assert 450 < distance[0, 2, 0] < 1800
    assert distance[0, 2, 180] == 220.0
    assert horizon[0, 2, 0] > horizon[0, 2, 180]

    calibrated = calibrated_horizon_uncertainty(distance, local_dist, local_sigma, np.array([1.5]))
    assert calibrated.shape == (1, 360)
    # Far-field occluder (~1 km) uses smaller angular error than preserved near-field 220m sigma.
    assert calibrated[0, 0] < 0.35
    assert np.isclose(calibrated[0, 180], 1.4, atol=1e-5)


def test_compile_horizons_with_distance_matches_compile_horizons():
    elev = np.zeros((256, 256), dtype=np.float32)
    elev[90, :] = 18.0
    err = np.full((256, 256), 1.5, dtype=np.float32)
    transform = from_origin(-2560, 2560, 20, 20)
    h1, u1 = compile_horizons(elev, err, transform)
    h2, u2, dist, mast_sigma = compile_horizons_with_distance(elev, err, transform)
    assert np.allclose(h1, h2)
    assert np.allclose(u1, u2)
    assert dist.shape == h1.shape
    assert mast_sigma.shape == h1.shape
    assert (dist > 0).all()
