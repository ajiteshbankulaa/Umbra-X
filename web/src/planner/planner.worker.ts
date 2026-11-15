import { dataset, fetchLivePolarHorizon, observer, padPixel, polarSites } from './data'
import { analyze, computePadViabilityMap, evaluateWindowSummary, searchObserverDual } from './model'
import type { Limits, Power, Scenario } from './model'
import { createWasmSearchEngine } from './wasmSearch'
import type { WasmSearchEngine } from './wasmSearch'

export type Request = { id: number; days: number; power: Power; limits: Limits } & (
  | { kind: 'compare'; scenarios: [Scenario, Scenario] }
  | { kind: 'search'; mast: number; version: string; targetStart?: number; scope?: { sites: string[]; from: number; through: number } }
)

let activeSearch = 0
const cache = new Map<string, ReturnType<typeof analyze>>()
const viabilityCache = new Map<string, { viability: Uint8Array; solarPct: Uint8Array }>()
let wasmPromise: Promise<WasmSearchEngine | null> | null = null

function getWasm(): Promise<WasmSearchEngine | null> {
  if (!wasmPromise) {
    const url = import.meta.env.BASE_URL + 'wasm/umbra_core.wasm'
    wasmPromise = createWasmSearchEngine(url).catch(() => null)
  }
  return wasmPromise
}

self.onmessage = async ({ data: request }: MessageEvent<Request | { kind: 'cancel' }>) => {
  if (request.kind === 'cancel') {
    activeSearch++
    return
  }
  const ticket = ++activeSearch
  try {
    const steps = request.days * 24 * 12
    if (request.kind === 'compare') {
      const items = await Promise.all(
        request.scenarios.map(async s => {
          const bundle = await dataset(s.site)
          const pad = observer(bundle, s)
          let liveTerrain = false
          if (s.site === 'custom') {
            const lat = s.customLat ?? -89.45
            const lon = s.customLon ?? -138.0
            if (lat >= -90 && lat <= -80) {
              const live = await fetchLivePolarHorizon(lat, lon, pad.mast)
              if (live) {
                liveTerrain = true
                pad.coordinates = [live.lat, live.lon, live.elevation_m]
                pad.slope = live.slope_80m_deg
                pad.horizon = new Float32Array(live.horizon_96km)
                pad.reference = new Float32Array(live.horizon_48km)
                pad.distance = new Float32Array(live.distance_m)
                pad.coverage = new Uint8Array(live.coverage)
              }
            }
          }
          const key = JSON.stringify([bundle.meta.vectorHash, bundle.meta.localHash, liveTerrain, s, steps, request.power])
          let report = cache.get(key)
          if (!report) {
            report = analyze(pad, bundle.vectors, s.start * 12, steps, bundle.meta, request.power)
            if (cache.size >= 12) cache.delete(cache.keys().next().value!)
            cache.set(key, report)
          }
          const mastSensitivity = bundle.site
            ? [0, 4].map(mast => {
                const variant = observer(bundle, { ...s, mast })
                const result = analyze(variant, bundle.vectors, s.start * 12, steps, bundle.meta, request.power)
                return { height: variant.mast, lowLight: result.longestDark, earth: result.longestEarth, complete: result.complete }
              })
            : []
          let padViability: Uint8Array | undefined
          let padSolarPct: Uint8Array | undefined
          if (bundle.site && bundle.horizon && bundle.reference && bundle.coverage) {
            const vKey = JSON.stringify([bundle.meta.vectorHash, bundle.meta.localHash, s.site, s.mast, s.start, steps, request.limits, request.power.sigma ?? 0])
            let vMap = viabilityCache.get(vKey)
            if (!vMap) {
              const slopes = new Float32Array(bundle.meta.observers.length)
              for (let n = 0; n < slopes.length; n++) {
                slopes[n] = bundle.site.dem_slope[padPixel(bundle.site, n)]
              }
              vMap = computePadViabilityMap({
                meta: bundle.meta,
                horizons: bundle.horizon,
                reference: bundle.reference,
                horizonError: bundle.site.horizons_err,
                coverage: bundle.coverage,
                slopes,
                mast: s.mast,
                mastHeightM: bundle.site.manifest.mast_heights_m[s.mast] ?? 5,
                vectors: bundle.vectors,
                startHour: s.start,
                steps,
                limits: request.limits,
                sigma: request.power.sigma ?? 0,
              })
              if (viabilityCache.size >= 8) viabilityCache.delete(viabilityCache.keys().next().value!)
              viabilityCache.set(vKey, vMap)
            }
            padViability = vMap.viability
            padSolarPct = vMap.solarPct
          }
          return { report, pad, meta: bundle.meta, terrain: bundle.site, mastSensitivity, liveTerrain, padViability, padSolarPct }
        }),
      )
      self.postMessage({ id: request.id, kind: 'compare', items })
      return
    }

    const t0 = performance.now()
    const wasm = await getWasm()
    const engine = wasm ? 'Rust/WASM' : 'Optimized TS'
    let count = 0
    const scope = request.scope
    const targetStart = request.targetStart
    type Choice = {
      scenario: Scenario
      slope: number
      starts: number
      earliestStart: number
      nearestStart: number
      targetStartMatch: boolean
      longestDark: number
      longestEarth: number
      solarPct: number
      dsnHours: number
    }
    const options: Choice[] = []
    let lastYield = performance.now()

    for (const site of polarSites.filter(site => !scope || scope.sites.includes(site))) {
      const bundle = await dataset(site)
      if (!bundle.meta.vectorHash.startsWith(request.version)) throw new Error('Search data version mismatch.')
      if (!bundle.meta.regional) throw new Error(`Regional horizon data is unavailable for ${site}.`)
      const sigma = request.power.sigma ?? 0
      for (let node = 0; node < 961; node++) {
        if (performance.now() - lastYield >= 16) {
          await new Promise(resolve => setTimeout(resolve, 0))
          if (ticket !== activeSearch) return
          lastYield = performance.now()
          self.postMessage({ id: request.id, kind: 'progress', site, node })
        }
        const scenario = { site, node, mast: request.mast, start: 0 }
        const pad = observer(bundle, scenario)
        if (pad.slope == null || pad.slope > request.limits.slope) continue
        const passing = wasm
          ? wasm.searchDual(pad, bundle.vectors, steps, bundle.meta, request.limits, sigma)
          : searchObserverDual(pad, bundle.vectors, steps, bundle.meta, request.limits, sigma)
        const stable = scope
          ? passing.filter(step => step / 12 >= scope.from && step / 12 <= scope.through)
          : passing
        if (stable.length) {
          count += stable.length
          const earliestStart = stable[0] / 12
          let nearestStart = earliestStart
          let targetStartMatch = false
          if (targetStart != null) {
            let bestDiff = Infinity
            for (const step of stable) {
              const h = step / 12
              const diff = Math.abs(h - targetStart)
              if (diff < bestDiff) {
                bestDiff = diff
                nearestStart = h
              }
              if (diff === 0) {
                targetStartMatch = true
                break
              }
            }
          }
          const summary = evaluateWindowSummary(pad, bundle.vectors, nearestStart * 12, steps, bundle.meta, sigma)
          options.push({
            scenario: { ...scenario, start: targetStart != null ? nearestStart : earliestStart },
            slope: pad.slope,
            starts: stable.length,
            earliestStart,
            nearestStart,
            targetStartMatch,
            longestDark: summary.longestDark,
            longestEarth: summary.longestEarth,
            solarPct: summary.solarPct,
            dsnHours: summary.dsnHours,
          })
        }
      }
    }
    const defaultSorted = [...options].sort((a, b) => a.earliestStart - b.earliestStart || a.slope - b.slope)
    const targetSorted = targetStart != null
      ? [...options].sort((a, b) =>
          Number(b.targetStartMatch) - Number(a.targetStartMatch) ||
          Math.abs(a.nearestStart - targetStart) - Math.abs(b.nearestStart - targetStart) ||
          a.longestDark - b.longestDark ||
          a.slope - b.slope,
        )
      : defaultSorted
    self.postMessage({
      id: request.id,
      kind: 'search',
      count,
      options: targetSorted.slice(0, 12),
      allOptions: targetSorted,
      targetStart: targetStart ?? null,
      elapsedMs: Math.round(performance.now() - t0),
      engine,
    })
  } catch (e) {
    self.postMessage({ id: request.id, kind: 'error', message: e instanceof Error ? e.message : String(e) })
  }
}
