import { readFile } from 'node:fs/promises'
import { parentPort, workerData } from 'node:worker_threads'
import { analyze, defaultPower, searchObserverDual } from '../web/src/planner/model.ts'
import { buildObserver, loadPolarSiteBundle, polarSites, wasmPath } from '../web/src/planner/benchmark.mjs'
import { createWasmSearchEngine } from '../web/src/planner/wasmSearch.ts'

export const horizonEpoch = '2026-11-14T00:00:00Z'
export const mastHeights = [1.5, 3, 5, 10, 20]
const integer = (value, min, max) => Number.isInteger(value) && value >= min && value <= max
const within = (value, max) => Number.isFinite(value) && value >= 0 && value <= max

export function validatePlan(input) {
  if (!input || !integer(input.days, 1, 15)) throw new Error('Use a mission duration of 1 to 15 days.')
  const last = 720 - input.days * 24
  if (input.kind === 'search') {
    const { sites, days, limits, mast, from, through } = input
    if (!Array.isArray(sites) || !sites.length || sites.length > 3 || sites.some(site => !polarSites.includes(site)))
      throw new Error('Choose one or more supported polar regions.')
    if (!integer(mast, 0, 4) || !integer(from, 0, last) || !integer(through, from, last))
      throw new Error('The mast or UTC start range is outside supported coverage.')
    if (!limits || !within(limits.dark, 360) || !within(limits.earth, 360) || !within(limits.slope, 90))
      throw new Error('Enter valid low-light, Earth obstruction and slope limits.')
    return { kind: 'search', sites: [...new Set(sites)].sort(), days,
      limits: { dark: limits.dark, earth: limits.earth, slope: limits.slope }, mast, from, through }
  }
  if (input.kind !== 'compare' && input.kind !== 'terrain') throw new Error('Unknown study type.')
  const expected = input.kind === 'compare' ? 2 : 1
  if (!Array.isArray(input.scenarios) || input.scenarios.length !== expected)
    throw new Error(`Choose ${expected} terrain-backed scenarios.`)
  const scenarios = input.scenarios.map(s => {
    if (!s || !polarSites.includes(s.site) || !integer(s.node, 0, 960) || !integer(s.start, 0, last) || !integer(s.mast, 0, 4))
      throw new Error('A scenario is outside the supported pad, date or mast range.')
    return { site: s.site, node: s.node, start: s.start, mast: s.mast }
  })
  return { kind: input.kind, days: input.days, scenarios }
}

export async function solve(plan, power, versions, progress = () => {}) {
  const sites = plan.kind === 'search' ? plan.sites : [...new Set(plan.scenarios.map(s => s.site))]
  const bundles = new Map(await Promise.all(sites.map(async site => [site, await loadPolarSiteBundle(site)])))
  for (const [site, bundle] of bundles) {
    const meta = bundle.meta
    if (JSON.stringify(meta) !== JSON.stringify(versions[site])) throw new Error('Dataset changed. Submit a new study.')
  }
  const steps = plan.days * 288
  const assumptions = { ...defaultPower, sigma: power.sigma }
  if (plan.kind !== 'search') {
    return { comparisons: plan.scenarios.map(s => {
      const bundle = bundles.get(s.site)
      const observer = buildObserver(bundle, s.node, s.mast)
      const r = analyze(observer, bundle.vectors, s.start * 12, steps, bundle.meta, assumptions)
      return { scenario: s, coordinates: observer.coordinates, coverageComplete: r.complete,
        lowLightHours: r.longestDark, earthObstructionHours: r.longestEarth,
        referenceLowLightHours: r.referenceLongestDark, referenceEarthObstructionHours: r.referenceLongestEarth,
        events: { lowLight: r.dark, earth: r.earth }, slope: r.slope }
    }) }
  }
  const wasm = await readFile(wasmPath).then(createWasmSearchEngine).catch(() => null)
  let count = 0
  const options = []
  for (const [site, bundle] of bundles) {
    for (let node = 0; node < 961; node++) {
      if (node % 64 === 0) progress({ site, node, total: 961 })
      const pad = buildObserver(bundle, node, plan.mast)
      if (pad.slope > plan.limits.slope) continue
      const starts = (wasm ? wasm.searchDual(pad, bundle.vectors, steps, bundle.meta, plan.limits, power.sigma)
        : searchObserverDual(pad, bundle.vectors, steps, bundle.meta, plan.limits, power.sigma))
        .map(sample => sample / 12).filter(hour => hour >= plan.from && hour <= plan.through)
      if (!starts.length) continue
      count += starts.length
      options.push({ scenario: { site, node, mast: plan.mast, start: starts[0] }, starts: starts.length, slope: pad.slope })
    }
  }
  options.sort((a, b) => a.scenario.start - b.scenario.start || a.slope - b.slope)
  return { count, options: options.slice(0, 12), engine: wasm ? 'Rust/WASM' : 'TypeScript' }
}

if (parentPort) {
  const { plan, power, versions } = workerData
  try {
    parentPort.postMessage({ result: await solve(plan, power, versions, progress => parentPort.postMessage({ progress })) })
  } catch (error) {
    parentPort.postMessage({ error: error.message })
  }
}
