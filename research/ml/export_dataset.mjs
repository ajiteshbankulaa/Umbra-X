import { writeFile, mkdir } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { analyze, defaultPower } from '../../web/src/planner/model.ts'
import { buildObserver, loadPolarSiteBundle, polarSites } from '../../web/src/planner/benchmark.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const OUT_CSV = resolve(HERE, 'surrogate_dataset.csv')

const STARTS = [0, 48, 96, 360, 408, 456] // Early [0..336h] vs Late [360..696h] non-overlapping 10-day windows
const MAST_INDICES = [0, 2, 4] // 1.5 m, 5.0 m, 20.0 m
const DAYS = 10
const STEPS = DAYS * 288
const RAD = 180 / Math.PI

function arrayStats(arr, startIdx = 0, endIdx = arr.length) {
  let sum = 0
  let max = -Infinity
  let min = Infinity
  const vals = []
  for (let i = startIdx; i < endIdx; i++) {
    const v = arr[i]
    sum += v
    if (v > max) max = v
    if (v < min) min = v
    vals.push(v)
  }
  const n = vals.length || 1
  const mean = sum / n
  let varSum = 0
  for (let i = 0; i < vals.length; i++) {
    const d = vals[i] - mean
    varSum += d * d
  }
  vals.sort((a, b) => a - b)
  const p90 = vals[Math.min(vals.length - 1, Math.floor(0.9 * vals.length))] ?? 0
  return { mean, std: Math.sqrt(varSum / n), min, max, p90 }
}

function earthSectorStats(arr) {
  // Earth appears near azimuth 0 deg (+/- 35 deg) from Lunar South Pole
  const vals = []
  for (let a = 0; a <= 35; a++) vals.push(arr[a])
  for (let a = 325; a < 360; a++) vals.push(arr[a])
  return arrayStats(vals)
}

function sunSectorStats(arr) {
  // Sun sweeps full 360 deg azimuth over synodic month; count horizon > 1.5 deg
  let gt15 = 0
  let gt0 = 0
  for (let a = 0; a < 360; a++) {
    if (arr[a] > 1.5) gt15++
    if (arr[a] > 0.0) gt0++
  }
  return { fracGt15: gt15 / 360, fracGt0: gt0 / 360 }
}

function ephemerisWindowStats(vectors, startHour, steps) {
  const startStep = startHour * 12
  let sunSum = 0
  let sunMin = Infinity
  let sunMax = -Infinity
  let earthSum = 0
  let earthMin = Infinity
  let earthMax = -Infinity
  for (let k = 0; k < steps; k++) {
    const off = (startStep + k) * 9
    const sunEl = Math.asin(Math.max(-1, Math.min(1, vectors[off + 2]))) * RAD
    const earthEl = Math.asin(Math.max(-1, Math.min(1, vectors[off + 5]))) * RAD
    sunSum += sunEl
    if (sunEl < sunMin) sunMin = sunEl
    if (sunEl > sunMax) sunMax = sunEl
    earthSum += earthEl
    if (earthEl < earthMin) earthMin = earthEl
    if (earthEl > earthMax) earthMax = earthEl
  }
  return {
    sunElMean: sunSum / steps,
    sunElMin: sunMin,
    sunElMax: sunMax,
    earthElMean: earthSum / steps,
    earthElMin: earthMin,
    earthElMax: earthMax,
  }
}

function horizonAwareAnalyze(observer, vectors, startStep, steps, meta, sigma, use96Km) {
  const patched = use96Km
    ? observer
    : { ...observer, horizon: observer.reference }
  return analyze(patched, vectors, startStep, steps, meta, defaultPower, sigma)
}

async function main() {
  await mkdir(HERE, { recursive: true })
  const header = [
    'site', 'node', 'row', 'col', 'spatialBlock', 'startHour', 'temporalSplit', 'mastM',
    'latDeg', 'lonDeg', 'elevM', 'slopeDeg', 'psr',
    'h48Mean', 'h48Std', 'h48Max', 'h48P90', 'h48EarthMax', 'h48EarthMean', 'h48FracGt15', 'h48FracGt0',
    'h96Mean', 'h96Max', 'hDiffMean', 'hDiffMax', 'hDiffEarthMax',
    'errMean', 'errP90', 'errMax', 'errEarthMean', 'distFarFrac',
    'sunElMean', 'sunElMin', 'sunElMax', 'earthElMean', 'earthElMin', 'earthElMax',
    'ref48DarkH', 'ref48EarthH', 'ref48SolarH', 'ref48EarthVisH',
    'nom96DarkH', 'nom96EarthH', 'nom96BatteryKg',
    'sig2_96DarkH', 'sig2_96EarthH', 'sig2_96BatteryKg',
    'extentSensitiveDark', 'sigma2FlipFail', 'viable96Nom', 'viable96Sig2'
  ]
  const rows = [header.join(',')]
  const t0 = performance.now()

  for (const site of polarSites) {
    const bundle = await loadPolarSiteBundle(site)
    const ephemCache = new Map()
    for (const s of STARTS) {
      ephemCache.set(s, ephemerisWindowStats(bundle.vectors, s, STEPS))
    }

    // Stratified 1-of-3 uniform grid sampling across the full 31x31 DEM (row 0..30, col 0..30)
    for (let node = 0; node < 961; node += 3) {
      const row = Math.floor(node / 31)
      const col = node % 31
      // Spatial quadrants for 2D spatial block holdout (row < 15 vs >= 15, col < 15 vs >= 15)
      const spatialBlock = (row < 15 ? 0 : 2) + (col < 15 ? 0 : 1)

      for (const mIdx of MAST_INDICES) {
        const obs = buildObserver(bundle, node, mIdx)
        const h48Stats = arrayStats(obs.reference)
        const h48Earth = earthSectorStats(obs.reference)
        const h48Sun = sunSectorStats(obs.reference)
        const h96Stats = arrayStats(obs.horizon)
        const diffs = new Float32Array(360)
        let farCount = 0
        for (let a = 0; a < 360; a++) {
          diffs[a] = Math.max(0, obs.horizon[a] - obs.reference[a])
          if (obs.distance[a] > 48000) farCount++
        }
        const hDiffStats = arrayStats(diffs)
        const hDiffEarth = earthSectorStats(diffs)
        const errStats = arrayStats(obs.horizonError)
        const errEarth = earthSectorStats(obs.horizonError)

        for (const startHour of STARTS) {
          const ep = ephemCache.get(startHour)
          const stepStart = startHour * 12
          const r48Nom = horizonAwareAnalyze(obs, bundle.vectors, stepStart, STEPS, bundle.meta, 0, false)
          const r96Nom = horizonAwareAnalyze(obs, bundle.vectors, stepStart, STEPS, bundle.meta, 0, true)
          const r96Sig2 = horizonAwareAnalyze(obs, bundle.vectors, stepStart, STEPS, bundle.meta, 2, true)

          const slope = obs.slope ?? 99
          const viable48Nom = r48Nom.longestDark <= 48 && r48Nom.longestEarth <= 72 && slope <= 5 ? 1 : 0
          const viable96Nom = r96Nom.longestDark <= 48 && r96Nom.longestEarth <= 72 && slope <= 5 ? 1 : 0
          const viable96Sig2 = r96Sig2.longestDark <= 48 && r96Sig2.longestEarth <= 72 && slope <= 5 ? 1 : 0
          const extentSensitiveDark = Math.abs(r96Nom.longestDark - r48Nom.longestDark) > 0.25 ? 1 : 0
          const sigma2FlipFail = viable96Nom === 1 && viable96Sig2 === 0 ? 1 : 0
          const temporalSplit = startHour < 200 ? 'early' : 'late'

          rows.push([
            site, node, row, col, spatialBlock, startHour, temporalSplit, obs.mast,
            obs.coordinates[0].toFixed(5), obs.coordinates[1].toFixed(5), obs.coordinates[2].toFixed(2),
            slope.toFixed(4), obs.psr,
            h48Stats.mean.toFixed(4), h48Stats.std.toFixed(4), h48Stats.max.toFixed(4), h48Stats.p90.toFixed(4),
            h48Earth.max.toFixed(4), h48Earth.mean.toFixed(4), h48Sun.fracGt15.toFixed(4), h48Sun.fracGt0.toFixed(4),
            h96Stats.mean.toFixed(4), h96Stats.max.toFixed(4),
            hDiffStats.mean.toFixed(4), hDiffStats.max.toFixed(4), hDiffEarth.max.toFixed(4),
            errStats.mean.toFixed(4), errStats.p90.toFixed(4), errStats.max.toFixed(4), errEarth.mean.toFixed(4),
            (farCount / 360).toFixed(4),
            ep.sunElMean.toFixed(4), ep.sunElMin.toFixed(4), ep.sunElMax.toFixed(4),
            ep.earthElMean.toFixed(4), ep.earthElMin.toFixed(4), ep.earthElMax.toFixed(4),
            r48Nom.longestDark.toFixed(4), r48Nom.longestEarth.toFixed(4), r48Nom.solarHours.toFixed(4), r48Nom.earthHours.toFixed(4),
            r96Nom.longestDark.toFixed(4), r96Nom.longestEarth.toFixed(4), r96Nom.batteryKg.toFixed(2),
            r96Sig2.longestDark.toFixed(4), r96Sig2.longestEarth.toFixed(4), r96Sig2.batteryKg.toFixed(2),
            extentSensitiveDark, sigma2FlipFail, viable96Nom, viable96Sig2,
          ].join(','))
        }
      }
    }
  }

  await writeFile(OUT_CSV, rows.join('\n') + '\n', 'utf8')
  const dt = performance.now() - t0
  console.log(`Exported ${rows.length - 1} exact simulation samples to ${OUT_CSV} in ${dt.toFixed(1)} ms`)
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
