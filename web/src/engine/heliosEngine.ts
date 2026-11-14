import type { SiteData } from '../types/helios'

export const MISSION_HOURS = 360
export const SOLAR_RADIUS_DEG = 0.2665
const RADIUS_M = 1_737_400
const RAD = Math.PI / 180
const STEFAN_BOLTZMANN = 5.670374419e-8

export interface WindowOptions {
  launchDelayHours?: number
  mastIndex?: number
  sigma?: number
  shadowTemperatureK?: number
  sunTemperatureK?: number
  heaterSetpointK?: number
  heaterConductanceWPerK?: number
}

export interface GridWindow {
  site: SiteData
  launchDelayHours: number
  mastHeightM: number
  timestamps: string[]
  /** Hour-major fields indexed by hour * nodeCount + node. */
  solarFraction: Float32Array
  pointSun: Uint8Array
  earthVisible: Uint8Array
  surfaceTemperatureK: Float32Array
  heaterW: Float32Array
  meanTemperatureK: Float64Array
  coldTrap: Uint8Array
  grazingFluxWm2: number
  pointSourceMeanAbsoluteError: number
  nodeCount: number
}

export function solarDiskFraction(clearanceDeg: number): number {
  const x = clearanceDeg / SOLAR_RADIUS_DEG
  if (x <= -1) return 0
  if (x >= 1) return 1
  return (Math.acos(-x) + x * Math.sqrt(1 - x * x)) / Math.PI
}

function pixelIndex(site: SiteData, node: number) {
  const { cols, start_pixel, step_pixel } = site.manifest.analysis_grid
  const row = start_pixel + Math.floor(node / cols) * step_pixel
  const col = start_pixel + node % cols * step_pixel
  return row * site.manifest.dem_grid.width + col
}

function convergence(site: SiteData, node: number) {
  const { width, pixel_size_m } = site.manifest.dem_grid
  const { center_lon, center_lat } = site.manifest
  const rho = 2 * RADIUS_M * Math.tan((90 + center_lat) * RAD / 2)
  const pixel = pixelIndex(site, node)
  const x = rho * Math.sin(center_lon * RAD) + (pixel % width - (width - 1) / 2) * pixel_size_m
  const y = rho * Math.cos(center_lon * RAD) - (Math.floor(pixel / width) - (width - 1) / 2) * pixel_size_m
  return center_lon - Math.atan2(x, y) / RAD
}

export function simulateGridWindow(site: SiteData, options: WindowOptions = {}): GridWindow {
  const {
    launchDelayHours = 0, mastIndex = 4, sigma = 0, shadowTemperatureK = 65,
    sunTemperatureK = 225, heaterSetpointK = 253, heaterConductanceWPerK = 0.5,
  } = options
  if (!Number.isInteger(launchDelayHours) || launchDelayHours < 0 || launchDelayHours > 360) {
    throw new RangeError('Launch delay must be an integer from 0 to 360 hours')
  }
  const mastHeightM = site.manifest.mast_heights_m[mastIndex]
  if (!Number.isInteger(mastIndex) || mastHeightM === undefined ||
      ![sigma, shadowTemperatureK, sunTemperatureK, heaterSetpointK, heaterConductanceWPerK]
        .every(value => Number.isFinite(value) && value >= 0) ||
      sunTemperatureK < shadowTemperatureK) throw new RangeError('Invalid thermal or mast settings')

  const { rows, cols } = site.manifest.analysis_grid
  const nodeCount = rows * cols
  const samples = nodeCount * MISSION_HOURS
  const solarFraction = new Float32Array(samples)
  const pointSun = new Uint8Array(samples)
  const earthVisible = new Uint8Array(samples)
  const surfaceTemperatureK = new Float32Array(samples)
  const heaterW = new Float32Array(samples)
  const meanTemperatureK = new Float64Array(nodeCount)
  const shadowFourth = shadowTemperatureK ** 4
  const solarFourth = sunTemperatureK ** 4 - shadowFourth
  const ephem = site.manifest.ephemeris
  const offsets = Float64Array.from({ length: nodeCount }, (_, node) => convergence(site, node))
  const horizons = site.horizons
  const error = site.horizons_err
  const mastCount = site.manifest.mast_heights_m.length
  let pointError = 0

  for (let hour = 0; hour < MISSION_HOURS; hour++) {
    const time = launchDelayHours + hour
    const sunEl = ephem.sun_el_deg[time]
    const earthEl = ephem.earth_el_deg[time]
    const sunBearing = ephem.sun_az_deg[time]
    const earthBearing = ephem.earth_az_deg[time]
    for (let node = 0; node < nodeCount; node++) {
      const i = hour * nodeCount + node
      const base = (node * mastCount + mastIndex) * 360
      const sunAz = wrapAzimuth(sunBearing + offsets[node])
      const earthAz = wrapAzimuth(earthBearing + offsets[node])
      const a = sunAz | 0
      const b = a === 359 ? 0 : a + 1
      const c = earthAz | 0
      const d = c === 359 ? 0 : c + 1
      const sunH = horizons[base + a] + (horizons[base + b] - horizons[base + a]) * (sunAz - a)
      const earthH = horizons[base + c] + (horizons[base + d] - horizons[base + c]) * (earthAz - c)
      let clearance = sunEl - sunH
      if (sigma) {
        const errA = error[node * 360 + a]
        clearance -= sigma * (errA + (error[node * 360 + b] - errA) * (sunAz - a))
      }
      const fraction = solarDiskFraction(clearance)
      const temperature = Math.sqrt(Math.sqrt(shadowFourth + solarFourth * fraction))
      const binary = +(sunEl > sunH)
      solarFraction[i] = fraction
      pointSun[i] = binary
      earthVisible[i] = +(earthEl > earthH)
      surfaceTemperatureK[i] = temperature
      heaterW[i] = Math.max(0, heaterSetpointK - temperature) * heaterConductanceWPerK
      meanTemperatureK[node] += temperature
      pointError += Math.abs(fraction - binary)
    }
  }
  for (let node = 0; node < nodeCount; node++) meanTemperatureK[node] /= MISSION_HOURS
  return {
    site, launchDelayHours, mastHeightM, nodeCount, solarFraction, pointSun, earthVisible,
    surfaceTemperatureK, heaterW, meanTemperatureK,
    coldTrap: Uint8Array.from(meanTemperatureK, temperature => +(temperature < 110)),
    grazingFluxWm2: STEFAN_BOLTZMANN * solarFourth,
    pointSourceMeanAbsoluteError: pointError / samples,
    timestamps: ephem.timestamps.slice(launchDelayHours, launchDelayHours + MISSION_HOURS),
  }
}

function wrapAzimuth(degrees: number) {
  return degrees < 0 ? degrees + 360 : degrees >= 360 ? degrees - 360 : degrees
}

export interface PlasmaOptions {
  /** Unresolved transition width for the subgrid boundary scenario. */
  boundaryWidthM?: number
  dustFluxScaleKgM2H?: number
  dustExtinctionM2Kg?: number
  esdThresholdVm?: number
}

export function computeTerminatorPlasmaRisk(window: GridWindow, options: PlasmaOptions = {}) {
  const { boundaryWidthM = 4, dustFluxScaleKgM2H = 1e-7, dustExtinctionM2Kg = 1000, esdThresholdVm = 15 } = options
  if (!Number.isFinite(boundaryWidthM) || boundaryWidthM <= 0 ||
      ![dustFluxScaleKgM2H, dustExtinctionM2Kg, esdThresholdVm].every(x => Number.isFinite(x) && x >= 0)) {
    throw new RangeError('Invalid plasma scenario settings')
  }
  const { rows, cols, spacing_m } = window.site.manifest.analysis_grid
  const { nodeCount, solarFraction } = window
  const gradientPerM = new Float32Array(solarFraction.length)
  const potentialV = new Float32Array(solarFraction.length)
  const electricFieldVm = new Float32Array(solarFraction.length)
  const dustFluxKgM2H = new Float32Array(solarFraction.length)
  const dustPowerLossPct = new Float32Array(solarFraction.length)
  const esdHazard = new Uint8Array(solarFraction.length)
  const esdHazardHours = new Uint16Array(nodeCount)
  const deposited = new Float64Array(nodeCount)
  const fluxCoefficient = dustFluxScaleKgM2H / (esdThresholdVm || 15) ** 2
  const neighbors = new Int16Array(nodeCount * 4)
  const invDx = new Float64Array(nodeCount), invDy = new Float64Array(nodeCount)
  for (let node = 0; node < nodeCount; node++) {
    const r = Math.floor(node / cols), c = node % cols
    const k = node * 4
    neighbors[k] = c ? node - 1 : node
    neighbors[k + 1] = c < cols - 1 ? node + 1 : node
    neighbors[k + 2] = r ? node - cols : node
    neighbors[k + 3] = r < rows - 1 ? node + cols : node
    const spanX = neighbors[k + 1] - neighbors[k]
    const spanY = (neighbors[k + 3] - neighbors[k + 2]) / cols
    invDx[node] = spanX ? 1 / (spacing_m * spanX) : 0
    invDy[node] = spanY ? 1 / (spacing_m * spanY) : 0
  }
  const boundaryField = 165 / boundaryWidthM
  for (let hour = 0; hour < MISSION_HOURS; hour++) {
    const base = hour * nodeCount
    for (let node = 0; node < nodeCount; node++) {
      const i = base + node
      const k = node * 4
      const dx = (solarFraction[base + neighbors[k + 1]] - solarFraction[base + neighbors[k]]) * invDx[node]
      const dy = (solarFraction[base + neighbors[k + 3]] - solarFraction[base + neighbors[k + 2]]) * invDy[node]
      const gradient = Math.sqrt(dx * dx + dy * dy)
      const fraction = solarFraction[i]
      const rate = hour ? Math.abs(fraction - solarFraction[i - nodeCount]) : 0
      const contrast = Math.min(1, Math.max(gradient * spacing_m, rate))
      const field = Math.max(165 * gradient, boundaryField * contrast)
      const flux = fluxCoefficient * field * field
      const arc = +(field > esdThresholdVm && rate > 0.1)
      deposited[node] += flux
      potentialV[i] = -150 + 165 * fraction
      gradientPerM[i] = gradient
      electricFieldVm[i] = field
      dustFluxKgM2H[i] = flux
      dustPowerLossPct[i] = deposited[node] ? -100 * Math.expm1(-dustExtinctionM2Kg * deposited[node]) : 0
      esdHazard[i] = arc
      esdHazardHours[node] += arc
    }
  }
  return { potentialV, gradientPerM, electricFieldVm, dustFluxKgM2H, dustPowerLossPct, esdHazard, esdHazardHours }
}

export type PlasmaRisk = ReturnType<typeof computeTerminatorPlasmaRisk>

function sampleHeight(site: SiteData, row: number, col: number) {
  const width = site.manifest.dem_grid.width
  const r = Math.min(Math.floor(row), width - 2)
  const c = Math.min(Math.floor(col), width - 2)
  const j = r * width + c
  const u = col - c, v = row - r
  const e = site.dem_elev
  return (e[j] * (1 - u) + e[j + 1] * u) * (1 - v) +
    (e[j + width] * (1 - u) + e[j + width + 1] * u) * v
}

export function checkLineOfSight(site: SiteData, from: number, to: number, fromMastM: number, toMastM = fromMastM) {
  const width = site.manifest.dem_grid.width
  const a = pixelIndex(site, from), b = pixelIndex(site, to)
  if (a === b) return true
  const r = Math.floor(a / width), c = a % width
  const dy = Math.floor(b / width) - r, dx = b % width - c
  const length = Math.hypot(dx, dy) * site.manifest.dem_grid.pixel_size_m
  const bulge = length * length / (2 * RADIUS_M)
  const start = site.dem_elev[a] + fromMastM
  const end = site.dem_elev[b] + toMastM
  const rowStep = dy ? 1 / Math.abs(dy) : Infinity
  const colStep = dx ? 1 / Math.abs(dx) : Infinity
  let nextRow = rowStep, nextCol = colStep
  function clearance(t: number) {
    return start + (end - start) * t - bulge * t * (1 - t) - sampleHeight(site, r + dy * t, c + dx * t)
  }
  let low = 0, left = fromMastM
  // Clearance is quadratic inside each bilinear DEM cell. Check its interior minimum.
  while (low < 1) {
    const high = Math.min(1, nextRow, nextCol)
    const right = high === 1 ? toMastM : clearance(high)
    if (right < -1e-7) return false
    const middle = clearance((low + high) / 2)
    const quadratic = 2 * (left + right - 2 * middle)
    const linear = right - left - quadratic
    if (quadratic > 0 && linear < 0 && -linear < 2 * quadratic &&
        left - linear * linear / (4 * quadratic) < -1e-7) return false
    if (nextRow <= high) nextRow += rowStep
    if (nextCol <= high) nextCol += colStep
    left = right
    low = high
  }
  return true
}

function nearestSafeNode(site: SiteData, requested: number, limit: number) {
  const { rows, cols } = site.manifest.analysis_grid
  if (!Number.isInteger(requested) || requested < 0 || requested >= rows * cols) throw new RangeError('Invalid landing node')
  let best = -1, distance = Infinity
  for (let node = 0; node < rows * cols; node++) {
    const d = (Math.floor(node / cols) - Math.floor(requested / cols)) ** 2 + (node % cols - requested % cols) ** 2
    if (d < distance && site.dem_slope[pixelIndex(site, node)] < limit) {
      best = node
      distance = d
    }
  }
  return best
}

export interface NetworkOptions {
  primaryNode?: number
  autoSnap?: boolean
  /** Receiver above terrain and passive reflector albedo. */
  receiverHeightM?: number
  albedo?: number
}

export function solveLightToIceNetwork(window: GridWindow, options: NetworkOptions = {}) {
  const { site, nodeCount: n, solarFraction, earthVisible, mastHeightM } = window
  const { primaryNode = n >> 1, autoSnap = true, receiverHeightM = 1.5, albedo = 0.12 } = options
  if (!Number.isFinite(receiverHeightM) || receiverHeightM <= 0 ||
      !Number.isFinite(albedo) || albedo < 0 || albedo > 1) throw new RangeError('Invalid receiver or albedo')
  const safe = nearestSafeNode(site, primaryNode, 5)
  const primary = autoSnap ? safe : safe === primaryNode ? safe : -1
  if (primary < 0) return null
  const dark = new Uint16Array(n)
  const blackout = new Uint16Array(n)
  for (let h = 0; h < MISSION_HOURS; h++) {
    const base = h * n
    const primaryDark = solarFraction[base + primary] < 0.1
    const primaryBlackout = !earthVisible[base + primary]
    if (!primaryDark && !primaryBlackout) continue
    for (let node = 0; node < n; node++) {
      if (primaryDark && solarFraction[base + node] < 0.1) dark[node]++
      if (primaryBlackout && !earthVisible[base + node]) blackout[node]++
    }
  }
  let twin: number | null = null
  let bestScore = Infinity
  for (let node = 0; node < n; node++) {
    const score = dark[node] * (MISSION_HOURS + 1) + blackout[node]
    if (node !== primary && score < bestScore && checkLineOfSight(site, primary, node, mastHeightM)) {
      twin = node
      bestScore = score
    }
  }

  const sources = twin === null ? [primary] : [primary, twin]
  let iceTarget: number | null = null
  let beamSources: number[] = []
  for (let node = 0; node < n; node++) {
    if (!site.psr_mask[pixelIndex(site, node)] || sources.includes(node) ||
        window.meanTemperatureK[node] >= (iceTarget === null ? 110 : window.meanTemperatureK[iceTarget])) continue
    const targetHeight = site.dem_elev[pixelIndex(site, node)] + receiverHeightM
    const links = sources.filter(from => site.dem_elev[pixelIndex(site, from)] > site.dem_elev[pixelIndex(site, node)] &&
      site.dem_elev[pixelIndex(site, from)] + mastHeightM > targetHeight &&
      checkLineOfSight(site, from, node, mastHeightM, receiverHeightM))
    if (links.length) {
      iceTarget = node
      beamSources = links
    }
  }

  const passiveRadiosityWm2 = new Float32Array(MISSION_HOURS)
  const reflectionFacets: { node: number; factor: number }[] = []
  if (iceTarget !== null) {
    const target = pixelIndex(site, iceTarget)
    const { width, pixel_size_m: pixelM } = site.manifest.dem_grid
    const { spacing_m: spacing } = site.manifest.analysis_grid
    let sum = 0
    const elevation = site.dem_elev
    for (let node = 0; node < n; node++) {
      const facet = pixelIndex(site, node)
      const dz = elevation[facet] - elevation[target]
      if (dz <= 0) continue
      const dx = (facet % width - target % width) * pixelM
      const dy = (Math.floor(facet / width) - Math.floor(target / width)) * pixelM
      const d = Math.hypot(dx, dy, dz)
      const sx = (elevation[facet + 1] - elevation[facet - 1]) / (2 * pixelM)
      const sy = (elevation[facet + width] - elevation[facet - width]) / (2 * pixelM)
      const emitter = (sx * dx + sy * dy - dz) / (d * Math.hypot(sx, sy, 1))
      if (emitter <= 0 || !checkLineOfSight(site, node, iceTarget, 0.01, 0.01)) continue
      const factor = emitter * (dz / d) * spacing ** 2 * Math.hypot(sx, sy, 1) / (Math.PI * d * d)
      reflectionFacets.push({ node, factor })
      sum += factor
    }
    // Single diffuse bounce with the same grazing-equilibrium flux scale as the thermal model.
    const outgoingScale = albedo * window.grazingFluxWm2 / Math.max(sum, 1)
    for (const { node, factor } of reflectionFacets) {
      for (let h = 0; h < MISSION_HOURS; h++) {
        passiveRadiosityWm2[h] += outgoingScale * factor * solarFraction[h * n + node]
      }
    }
  }
  return {
    primary, twin, iceTarget, beamSources, reflectionFacets,
    simultaneousDarknessHours: dark[twin ?? primary],
    combinedEarthBlackoutHours: blackout[twin ?? primary],
    passiveRadiosityWm2,
    reflectedLightHours: Array.from(passiveRadiosityWm2.keys()).filter(hour => passiveRadiosityWm2[hour] > 0),
  }
}

export type LightToIceNetwork = NonNullable<ReturnType<typeof solveLightToIceNetwork>>

export interface RouteOptions {
  startNode?: number
  driveWhPerM?: number
  darknessPenalty?: number
  plasmaPenalty?: number
  commsPenalty?: number
  drivePenaltyPerWh?: number
}

export function solveShadowSurfingPath(window: GridWindow, plasma: PlasmaRisk, options: RouteOptions = {}) {
  const { site, nodeCount: n, solarFraction, earthVisible } = window
  const { cols, spacing_m: spacing } = site.manifest.analysis_grid
  const {
    startNode, driveWhPerM = 0.2, darknessPenalty = 10, plasmaPenalty = 5,
    commsPenalty = 2, drivePenaltyPerWh = 0.02,
  } = options
  if (![driveWhPerM, darknessPenalty, plasmaPenalty, commsPenalty, drivePenaltyPerWh]
    .every(value => Number.isFinite(value) && value >= 0) ||
    (startNode !== undefined && (!Number.isInteger(startNode) || startNode < 0 || startNode >= n))) {
    throw new RangeError('Invalid route settings')
  }
  const safe = new Uint8Array(n)
  const neighbors = new Int16Array(n * 4).fill(-1)
  const { width } = site.manifest.dem_grid
  const step = site.manifest.analysis_grid.step_pixel
  for (let node = 0; node < n; node++) safe[node] = +(site.dem_slope[pixelIndex(site, node)] < 12)
  for (let node = 0; node < n; node++) {
    if (!safe[node]) continue
    const adjacent = [node >= cols ? node - cols : -1, node % cols ? node - 1 : -1,
      node % cols < cols - 1 ? node + 1 : -1, node + cols < n ? node + cols : -1]
    const pixel = pixelIndex(site, node)
    for (let k = 0; k < 4; k++) {
      const other = adjacent[k]
      if (other < 0 || !safe[other]) continue
      const stride = other - node === cols ? width : other - node === -cols ? -width : other - node
      let clear = true
      for (let j = 1; j < step; j++) clear &&= site.dem_slope[pixel + stride * j] < 12
      if (clear) neighbors[node * 4 + k] = other
    }
  }
  const movePenalty = spacing * driveWhPerM * drivePenaltyPerWh
  const back = new Int16Array(n * MISSION_HOURS)
  let previous = new Float64Array(n).fill(Infinity), next = new Float64Array(n)
  const cost = (i: number) => darknessPenalty * (1 - solarFraction[i]) +
    plasmaPenalty * +(plasma.electricFieldVm[i] > 15) + commsPenalty * (1 - earthVisible[i])
  for (let node = 0; node < n; node++) {
    if (safe[node] && (startNode === undefined || node === startNode)) previous[node] = cost(node)
  }
  for (let h = 1; h < MISSION_HOURS; h++) {
    const base = h * n
    for (let node = 0; node < n; node++) {
      let best = previous[node], parent = node
      for (let k = 0; k < 4; k++) {
        const neighbor = neighbors[node * 4 + k]
        if (neighbor >= 0 && previous[neighbor] + movePenalty < best) {
          best = previous[neighbor] + movePenalty
          parent = neighbor
        }
      }
      next[node] = best + cost(base + node)
      back[base + node] = parent
    }
    const swap = previous
    previous = next
    next = swap
  }
  let end = 0
  for (let node = 1; node < n; node++) if (previous[node] < previous[end]) end = node
  const totalCost = previous[end]
  if (!Number.isFinite(totalCost)) return null
  const path = new Uint16Array(MISSION_HOURS)
  let distanceM = 0, darkHours = 0, plasmaHours = 0, commsBlackoutHours = 0
  for (let h = MISSION_HOURS - 1; h >= 0; h--) {
    path[h] = end
    const i = h * n + end
    darkHours += +(solarFraction[i] < 0.1)
    plasmaHours += +(plasma.electricFieldVm[i] > 15)
    commsBlackoutHours += 1 - earthVisible[i]
    const parent = back[i]
    if (h > 0 && parent !== end) distanceM += spacing
    end = parent
  }
  return { path, totalCost, distanceM, driveWhPerM, driveEnergyWh: distanceM * driveWhPerM,
    darkHours, plasmaHours, commsBlackoutHours }
}

export type ShadowSurfingPath = NonNullable<ReturnType<typeof solveShadowSurfingPath>>

export interface CommercialOptions {
  arrayPeakW?: number
  baseLoadW?: number
  beamEfficiency?: number
  iceRecoveryKgPerKWh?: number
  propellantYieldKgPerKgIce?: number
  propellantPriceUSDPerKg?: number
  iceInventoryKg?: number
  batterySpecificEnergyWhPerKg?: number
  batteryDepthOfDischarge?: number
  deliveryUSDPerKg?: number
  missionValueUSD?: number
  gridHardwareKg?: number
  roverHardwareKg?: number
  availableBatteryKg?: number
  dustFailureLossPct?: number
  lifetimeWindows?: number
  dispersionSemiMajorM?: number
  dispersionSemiMinorM?: number
}

export function requiredStorageWh(netWh: ArrayLike<number>) {
  let deficit = 0, maximum = 0
  for (let hour = 0; hour < netWh.length; hour++) {
    deficit = Math.max(0, deficit - netWh[hour])
    maximum = Math.max(maximum, deficit)
  }
  return maximum
}

export function computeCommercialMetrics(
  window: GridWindow, plasma: PlasmaRisk, network: LightToIceNetwork,
  route: ShadowSurfingPath | null, options: CommercialOptions = {},
) {
  const {
    arrayPeakW = 400, baseLoadW = 120, beamEfficiency = 0.4, iceRecoveryKgPerKWh = 0.2,
    propellantYieldKgPerKgIce = 0.8, propellantPriceUSDPerKg = 10000, iceInventoryKg = 0,
    batterySpecificEnergyWhPerKg = 150, batteryDepthOfDischarge = 0.8,
    deliveryUSDPerKg = 750000, missionValueUSD = 110e6, gridHardwareKg = 40,
    roverHardwareKg = 30, availableBatteryKg = 100, dustFailureLossPct = 30,
    lifetimeWindows = 1, dispersionSemiMajorM = 100, dispersionSemiMinorM = 100,
  } = options
  if (![arrayPeakW, baseLoadW, beamEfficiency, iceRecoveryKgPerKWh, propellantYieldKgPerKgIce,
    propellantPriceUSDPerKg, iceInventoryKg, batterySpecificEnergyWhPerKg, batteryDepthOfDischarge,
    deliveryUSDPerKg, missionValueUSD, gridHardwareKg, roverHardwareKg, availableBatteryKg,
    dustFailureLossPct, lifetimeWindows, dispersionSemiMajorM, dispersionSemiMinorM]
    .every(value => Number.isFinite(value) && value >= 0) ||
    !batterySpecificEnergyWhPerKg || !batteryDepthOfDischarge || !lifetimeWindows ||
    !dispersionSemiMajorM || !dispersionSemiMinorM ||
    beamEfficiency > 1 || propellantYieldKgPerKgIce > 1 || batteryDepthOfDischarge > 1 ||
    dustFailureLossPct > 100) throw new RangeError('Invalid commercial scenario settings')

  const { site, nodeCount: n, solarFraction, heaterW } = window
  const usableWhPerKg = batterySpecificEnergyWhPerKg * batteryDepthOfDischarge
  const net = new Float64Array(MISSION_HOURS)
  const generation = (i: number) => arrayPeakW * solarFraction[i] * (1 - plasma.dustPowerLossPct[i] / 100)

  function architecture(kind: 'standalone' | 'grid' | 'mobile') {
    const grid = kind === 'grid'
    const path = kind === 'mobile' ? route?.path : undefined
    const twin = grid ? network.twin : null
    let beamKWh = 0, totalNetWh = 0, servedWh = 0
    const driveWh = (route?.driveWhPerM ?? 0) * site.manifest.analysis_grid.spacing_m
    for (let hour = 0; hour < MISSION_HOURS; hour++) {
      const node = path?.[hour] ?? network.primary
      const a = hour * n + node
      servedWh += baseLoadW + heaterW[a]
      const sourceA = generation(a) - baseLoadW - heaterW[a]
      let surplus = sourceA
      let eligible = grid && network.beamSources.includes(node) ? Math.max(0, sourceA) : 0
      if (twin !== null) {
        const b = hour * n + twin
        servedWh += baseLoadW + heaterW[b]
        const sourceB = generation(b) - baseLoadW - heaterW[b]
        surplus += sourceB
        if (network.beamSources.includes(twin)) eligible += Math.max(0, sourceB)
      }
      if (path && hour && node !== path[hour - 1]) {
        surplus -= driveWh
        servedWh += driveWh
      }
      const extractionWh = network.iceTarget !== null && beamEfficiency > 0 && iceRecoveryKgPerKWh > 0
        ? Math.min(eligible, Math.max(0, surplus),
          Math.max(0, iceInventoryKg / iceRecoveryKgPerKWh - beamKWh) * 1000 / beamEfficiency) : 0
      beamKWh += extractionWh * beamEfficiency / 1000
      net[hour] = surplus - extractionWh
      totalNetWh += net[hour]
    }
    const requiredBatteryMassKg = requiredStorageWh(net) / usableWhPerKg
    const hardware = twin !== null ? gridHardwareKg : path ? roverHardwareKg : 0
    const deliveredKWh = servedWh / 1000 + beamKWh
    const capitalUSD = (requiredBatteryMassKg + hardware) * deliveryUSDPerKg
    const psrIceExtractedKg = Math.min(iceInventoryKg, beamKWh * iceRecoveryKgPerKWh)
    return {
      requiredBatteryMassKg, deliveredKWh, netEnergyWh: totalNetWh,
      beamDeliveredKWh: beamKWh, capitalUSD,
      lunaGridLcoeUSDPerKWh: deliveredKWh > 0 ? capitalUSD / (lifetimeWindows * deliveredKWh) : null,
      psrIceExtractedKg,
      cislunarPropellantValueUSD: psrIceExtractedKg * propellantYieldKgPerKgIce * propellantPriceUSDPerKg,
    }
  }
  const standalone = architecture('standalone')
  const grid = architecture('grid')
  const mobile = route ? architecture('mobile') : null
  const withSavings = (metrics: typeof standalone) => ({
    ...metrics, netClpsCapitalSavedUSD: standalone.capitalUSD - metrics.capitalUSD,
  })

  // Uniform DEM-pixel samples over the axis-aligned landing ellipse. Use the
  // nearest analysis node for time series and the actual DEM pixel for slope.
  const { width, pixel_size_m: pixelM } = site.manifest.dem_grid
  const { cols, rows, start_pixel: start, step_pixel: step } = site.manifest.analysis_grid
  const pad = pixelIndex(site, network.primary)
  const r0 = Math.floor(pad / width), c0 = pad % width
  const nodeOutcome = new Int8Array(n).fill(-1)
  const outcome = (node: number) => {
    if (nodeOutcome[node] >= 0) return nodeOutcome[node]
    const capacity = usableWhPerKg * availableBatteryKg
    let charge = capacity, flags = 0
    for (let hour = 0; hour < MISSION_HOURS; hour++) {
      const i = hour * n + node
      charge = Math.min(capacity, Math.max(0, charge + generation(i) - baseLoadW - heaterW[i]))
      if (charge === 0 && heaterW[i] > 0) flags |= 1
      if (plasma.esdHazard[i] || plasma.dustPowerLossPct[i] >= dustFailureLossPct) flags |= 2
    }
    nodeOutcome[node] = flags
    return flags
  }

  let samples = 0, survived = 0, slopeFailures = 0, freezeFailures = 0, plasmaFailures = 0
  const dr = Math.floor(dispersionSemiMinorM / pixelM), dc = Math.floor(dispersionSemiMajorM / pixelM)
  for (let r = r0 - Math.min(dr, width); r <= r0 + Math.min(dr, width); r++) {
    for (let c = c0 - Math.min(dc, width); c <= c0 + Math.min(dc, width); c++) {
      if (((r - r0) * pixelM / dispersionSemiMinorM) ** 2 + ((c - c0) * pixelM / dispersionSemiMajorM) ** 2 > 1) continue
      samples++
      if (r < 0 || c < 0 || r >= width || c >= width) continue
      const rr = Math.max(0, Math.min(rows - 1, Math.round((r - start) / step)))
      const cc = Math.max(0, Math.min(cols - 1, Math.round((c - start) / step)))
      const steep = site.dem_slope[r * width + c] > 5
      const flags = outcome(rr * cols + cc)
      slopeFailures += +steep
      freezeFailures += +(!!(flags & 1))
      plasmaFailures += +(!!(flags & 2))
      survived += +(!steep && !flags)
    }
  }
  const survival = survived / samples
  return {
    standalone: withSavings(standalone), grid: withSavings(grid), mobile: mobile && withSavings(mobile),
    actuarialUnderwriting: {
      samples, slopeFailures, freezeFailures, plasmaFailures, survivalProbPct: 100 * survival,
      valueAtRisk95USD: survival >= 0.95 ? 0 : missionValueUSD,
      insuranceTier: survival >= 0.99 ? 'preferred' : survival >= 0.95 ? 'standard' : 'high-risk',
    },
  }
}
