import assert from 'node:assert/strict'
import test from 'node:test'
import {
  checkLineOfSight, computeCommercialMetrics, computeTerminatorPlasmaRisk, requiredStorageWh,
  simulateGridWindow, solarDiskFraction, solveLightToIceNetwork, solveShadowSurfingPath,
} from './heliosEngine.ts'

function fixture(rows = 3, cols = 3) {
  const n = rows * cols
  const hours = value => Array(720).fill(value)
  return {
    manifest: {
      center_lat: -89, center_lon: 0, mast_heights_m: [1.5, 3, 5, 10, 20],
      dem_grid: { width: 256, height: 256, pixel_size_m: 20 },
      analysis_grid: { rows, cols, start_pixel: 98, step_pixel: 2, spacing_m: 40 },
      ephemeris: {
        timestamps: Array.from({ length: 720 }, (_, i) => String(i)),
        sun_az_deg: hours(359.9), sun_el_deg: hours(0), earth_az_deg: hours(0), earth_el_deg: hours(1),
      },
    },
    dem_elev: new Float32Array(256 ** 2), dem_slope: new Float32Array(256 ** 2),
    dem_err: new Float32Array(256 ** 2), psr_mask: new Uint8Array(256 ** 2),
    horizons: new Float32Array(n * 5 * 360), horizons_err: new Float32Array(n * 360),
  }
}

test('analytic disk, hour 360 boundary, horizon uncertainty and radiative equilibrium', () => {
  assert.equal(solarDiskFraction(0), 0.5)
  assert.equal(solarDiskFraction(-0.2665), 0)
  assert.equal(solarDiskFraction(0.2665), 1)
  assert.ok(Math.abs(solarDiskFraction(0.13325) + solarDiskFraction(-0.13325) - 1) < 1e-15)
  const site = fixture()
  let window = simulateGridWindow(site, { launchDelayHours: 360 })
  assert.deepEqual([window.timestamps[0], window.timestamps.at(-1)], ['360', '719'])
  assert.equal(window.pointSun[0], 0)
  assert.equal(window.pointSourceMeanAbsoluteError, 0.5)
  assert.ok(Math.abs(window.surfaceTemperatureK[0] - ((225 ** 4 + 65 ** 4) / 2) ** 0.25) < 1e-5)
  site.horizons_err.fill(0.3)
  window = simulateGridWindow(site, { sigma: 1 })
  assert.equal(window.solarFraction[0], 0)
  assert.equal(window.surfaceTemperatureK[0], 65)
  assert.equal(window.heaterW[0], 94)
  assert.throws(() => simulateGridWindow(site, { launchDelayHours: 361 }), RangeError)
})

test('terminator crossing produces a field, dust accumulation and ESD hours', () => {
  const window = simulateGridWindow(fixture())
  window.solarFraction.fill(0)
  window.solarFraction[1] = 1
  window.solarFraction[window.nodeCount] = 1
  const risk = computeTerminatorPlasmaRisk(window)
  assert.equal(risk.potentialV[1], 15)
  assert.equal(risk.potentialV[0], -150)
  assert.ok(Math.abs(risk.gradientPerM[0] - 1 / 40) < 1e-8)
  assert.equal(risk.electricFieldVm[window.nodeCount], 41.25)
  assert.equal(risk.esdHazardHours[0], 2)
  assert.ok(risk.dustPowerLossPct[window.nodeCount] > risk.dustPowerLossPct[0])
})

test('terrain obstruction, pad snapping, complementary twin and mapped PSR receiver', () => {
  const site = fixture()
  const midpoint = 98 * 256 + 99
  site.dem_elev[midpoint] = 50
  assert.equal(checkLineOfSight(site, 0, 1, 20), false)
  site.dem_elev[midpoint] = 0
  const window = simulateGridWindow(site)
  window.solarFraction.fill(0)
  window.earthVisible.fill(0)
  for (let h = 0; h < 360; h++) {
    const node = h < 180 ? 0 : 1
    window.solarFraction[h * 9 + node] = 1
    window.earthVisible[h * 9 + node] = 1
  }
  site.psr_mask[98 * 256 + 102] = 1
  site.dem_elev[98 * 256 + 102] = -2
  window.meanTemperatureK[2] = 65
  const network = solveLightToIceNetwork(window, { primaryNode: 0 })
  assert.equal(network.twin, 1)
  assert.equal(network.iceTarget, 2)
  assert.deepEqual(network.beamSources, [0, 1])
  assert.equal(network.simultaneousDarknessHours, 0)
  assert.equal(network.combinedEarthBlackoutHours, 0)
  site.dem_slope[98 * 256 + 98] = 5
  assert.equal(solveLightToIceNetwork(window, { primaryNode: 0, autoSnap: false }), null)
  assert.equal(solveLightToIceNetwork(window, { primaryNode: 0 }).primary, 1)
})

test('DP moves one safe cardinal cell and charges drive energy', () => {
  const window = simulateGridWindow(fixture())
  window.solarFraction.fill(0)
  window.earthVisible.fill(1)
  for (let h = 0; h < 360; h++) window.solarFraction[h * 9 + (h === 0 ? 0 : 1)] = 1
  const risk = computeTerminatorPlasmaRisk(window)
  const route = solveShadowSurfingPath(window, risk, { startNode: 0, plasmaPenalty: 0 })
  assert.equal(route.path[0], 0)
  assert.equal(route.path[359], 1)
  assert.equal(route.darkHours, 0)
  assert.equal(route.driveEnergyWh, 8)
  window.site.dem_slope[98 * 256 + 99] = 12
  const blocked = solveShadowSurfingPath(window, risk, { startNode: 0, plasmaPenalty: 0 })
  assert.notEqual(blocked.path[1], 1)
})

test('visible wall reflects only during lit hours and beaming stops at inventory', () => {
  const site = fixture()
  const targetPixel = 98 * 256 + 102
  site.psr_mask[targetPixel] = 1
  site.dem_elev[targetPixel] = -4
  site.dem_elev[targetPixel - 1] = -3.9
  site.dem_elev[targetPixel - 3] = 1
  const window = simulateGridWindow(site)
  window.solarFraction.fill(0)
  window.solarFraction[1] = 1
  window.meanTemperatureK[2] = 65
  window.heaterW.fill(0)
  const network = solveLightToIceNetwork(window, { primaryNode: 1 })
  assert.equal(network.iceTarget, 2)
  assert.deepEqual(network.reflectedLightHours, [0])
  const result = computeCommercialMetrics(window, computeTerminatorPlasmaRisk(window), network, null, {
    arrayPeakW: 1000, baseLoadW: 0, beamEfficiency: 0.5,
    iceInventoryKg: 0.1, iceRecoveryKgPerKWh: 0.5,
  })
  assert.ok(Math.abs(result.grid.beamDeliveredKWh - 0.2) < 1e-12)
  assert.equal(result.grid.psrIceExtractedKg, 0.1)
})

test('storage uses cumulative deficit; underwriting reports binary-loss VaR', () => {
  assert.equal(requiredStorageWh([-40, -30, 60, -80]), 90)
  const site = fixture()
  const window = simulateGridWindow(site)
  window.solarFraction.fill(0)
  window.heaterW.fill(0)
  const risk = computeTerminatorPlasmaRisk(window)
  const network = solveLightToIceNetwork(window)
  let result = computeCommercialMetrics(window, risk, network, null)
  assert.equal(result.standalone.requiredBatteryMassKg, 360)
  assert.equal(result.standalone.deliveredKWh, 43.2)
  assert.equal(result.grid.psrIceExtractedKg, 0)
  assert.equal(result.mobile, null)
  assert.equal(result.actuarialUnderwriting.survivalProbPct, 100)
  assert.equal(result.actuarialUnderwriting.valueAtRisk95USD, 0)
  window.heaterW.fill(1)
  result = computeCommercialMetrics(window, risk, network, null, { availableBatteryKg: 0 })
  assert.equal(result.actuarialUnderwriting.survivalProbPct, 0)
  assert.equal(result.actuarialUnderwriting.valueAtRisk95USD, 110e6)
})
