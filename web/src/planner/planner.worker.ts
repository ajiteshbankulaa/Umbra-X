import { dataset, fetchLivePolarHorizon, observer, padPixel, polarSites } from './data'
import { analyze, computePadViabilityMap } from './model'
import type { Limits, Power, Scenario } from './model'
import type { ObjectiveKey, RobustnessPreference } from './recovery'
import { runMissionRecovery } from './recoverySearch'
import { createWasmSearchEngine } from './wasmSearch'
import type { WasmSearchEngine } from './wasmSearch'

export type Request = { id: number; days: number; power: Power; limits: Limits } & (
  | { kind: 'compare'; scenarios: [Scenario, Scenario] }
  | {
      kind: 'search'
      mast: number
      version: string
      targetStart?: number
      scope?: { sites: string[]; from: number; through: number }
      baseline?: Scenario
      revised?: Scenario
      robustnessPreference?: RobustnessPreference
      weights?: Partial<Record<ObjectiveKey, number>>
    }
)

let activeSearch = 0
const cache = new Map<string, ReturnType<typeof analyze>>()
const viabilityCache = new Map<string, { viability: Uint8Array; solarPct: Uint8Array; earthPct: Uint8Array }>()
let wasmPromise: Promise<WasmSearchEngine | null> | null = null

function reportTelemetry(payload: { event: string; engine?: string; elapsedMs?: number }) {
  try {
    if (typeof fetch !== 'function') return
    void fetch('/api/telemetry/client', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    }).catch(() => {})
  } catch {
    // Ignore on static-only hosts without optional backend
  }
}

function getWasm(): Promise<WasmSearchEngine | null> {
  if (!wasmPromise) {
    const url = import.meta.env.BASE_URL + 'wasm/umbra_core.wasm'
    wasmPromise = createWasmSearchEngine(url).catch(() => {
      reportTelemetry({ event: 'wasm_fallback', engine: 'TypeScript' })
      return null
    })
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
          let padEarthPct: Uint8Array | undefined
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
            padEarthPct = vMap.earthPct
          }
          return { report, pad, meta: bundle.meta, terrain: bundle.site, mastSensitivity, liveTerrain, padViability, padSolarPct, padEarthPct }
        }),
      )
      self.postMessage({ id: request.id, kind: 'compare', items })
      return
    }

    const wasm = await getWasm()
    const scope = request.scope
    const targetStart = request.targetStart
    const defaultSite = (scope?.sites.find(s => polarSites.includes(s)) ?? 'shackleton-ridge')
    const defaultBaseline: Scenario = request.baseline && polarSites.includes(request.baseline.site)
      ? request.baseline
      : { site: defaultSite, node: 480, start: 0, mast: request.mast }
    const defaultRevised: Scenario = request.revised && polarSites.includes(request.revised.site)
      ? request.revised
      : { site: defaultSite, node: 480, start: targetStart ?? defaultBaseline.start, mast: request.mast }
    const maxStartAllowed = Math.max(0, 720 - request.days * 24)
    const minStart = scope ? Math.max(0, scope.from) : 0
    const maxStart = scope ? Math.min(maxStartAllowed, scope.through) : maxStartAllowed
    const recoveryScope = scope
      ? scope.sites.length === polarSites.length
        ? ('all-polar' as const)
        : { kind: 'sites' as const, sites: scope.sites.filter(s => polarSites.includes(s)) }
      : ('all-polar' as const)

    const problem = {
      baseline: defaultBaseline,
      revised: defaultRevised,
      days: request.days,
      limits: request.limits,
      power: request.power,
      delayWindowHours: { minStart, maxStart },
      scope: recoveryScope,
      robustnessPreference: request.robustnessPreference ?? 'dual-extent-and-sigma',
      weights: request.weights,
    }

    const result = await runMissionRecovery(
      problem,
      async siteId => {
        const bundle = await dataset(siteId)
        return {
          siteId,
          meta: bundle.meta,
          vectors: bundle.vectors,
          getObserver: (node, mast) => observer(bundle, { site: siteId, node, mast, start: 0 }),
        }
      },
      {
        wasm,
        expectedVectorHashPrefix: request.version,
        shouldCancel: () => ticket !== activeSearch,
        onProgress: stage => {
          if (ticket === activeSearch) {
            self.postMessage({ id: request.id, kind: 'progress', stage })
          }
        },
      },
    )

    if (!result.ok) {
      if (result.cancelled || ticket !== activeSearch) return
      throw new Error(result.errors.join(' '))
    }
    if (ticket !== activeSearch) return

    const defaultSorted = [...result.padOptions].sort((a, b) => a.earliestStart - b.earliestStart || a.slope - b.slope)
    const targetSorted =
      targetStart != null
        ? [...result.padOptions].sort(
            (a, b) =>
              Number(b.targetStartMatch) - Number(a.targetStartMatch) ||
              Math.abs(a.nearestStart - targetStart) - Math.abs(b.nearestStart - targetStart) ||
              a.longestDark - b.longestDark ||
              a.slope - b.slope,
          )
        : defaultSorted

    reportTelemetry({ event: 'worker_search', engine: result.engine, elapsedMs: result.elapsedMs })
    self.postMessage({
      id: request.id,
      kind: 'search',
      count: result.count,
      options: targetSorted.slice(0, 12),
      allOptions: targetSorted,
      targetStart: targetStart ?? null,
      elapsedMs: result.elapsedMs,
      engine: result.engine,
      recovery: result,
    })
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    if (/checksum|mismatch|contract|out of sync|malformed/i.test(msg)) {
      reportTelemetry({ event: 'data_version_error', engine: 'worker' })
    }
    self.postMessage({ id: request.id, kind: 'error', message: msg })
  }
}
