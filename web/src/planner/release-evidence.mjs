import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { resolve } from 'node:path'
import { analyze, defaultPower, searchObserverDual } from './model.ts'
import { buildObserver, loadPolarSiteBundle, polarSites, wasmPath } from './benchmark.mjs'
import { createWasmSearchEngine } from './wasmSearch.ts'

const days = 15
const steps = days * 24 * 12
const limits = { dark: 48, earth: 72, slope: 5 }
const wasm = await createWasmSearchEngine(await readFile(wasmPath))
const bundles = await Promise.all(polarSites.map(loadPolarSiteBundle))
const beforeDir = process.argv[2]
const root = new URL('../../public/data/planner-release/planner/', import.meta.url)

async function binary(hash, Type) {
  const bytes = await readFile(new URL(hash + '.bin', root))
  assert.equal(createHash('sha256').update(bytes).digest('hex'), hash)
  return new Type(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength))
}

const changes = []
const passing = []
let cannotPass = 0
for (const bundle of bundles) {
  const old = beforeDir && JSON.parse(await readFile(resolve(beforeDir, bundle.site + '.json'), 'utf8'))
  const prior = old && {
    ...bundle,
    h96: await binary(old.regional.regional, Float32Array),
    h48: await binary(old.regional.sensitivity, Float32Array),
    cov: await binary(old.regional.coverage, Uint8Array),
  }
  const count = { site: bundle.site, eligible: 0, oldEligible: 0, gained: 0, lost: 0, example: null }
  for (let node = 0; node < 961; node++) {
    const mast = 2
    const pad = buildObserver(bundle, node, mast)
    if (pad.slope > limits.slope) continue
    const now = searchObserverDual(pad, bundle.vectors, steps, bundle.meta, limits)
    assert.deepEqual(wasm.searchDual(pad, bundle.vectors, steps, bundle.meta, limits, 0), now)
    cannotPass += searchObserverDual(pad, bundle.vectors, steps, bundle.meta, { ...limits, dark: 0, earth: 0, slope: 0 }).length
    count.eligible += now.length
    if (now.includes(48 * 12)) passing.push({ site: bundle.site, node, start: 48, mast })
    if (!prior) continue
    const oldStarts = searchObserverDual(buildObserver(prior, node, mast), bundle.vectors, steps, bundle.meta, limits)
    count.oldEligible += oldStarts.length
    const oldSet = new Set(oldStarts)
    const nowSet = new Set(now)
    const gains = now.filter(x => !oldSet.has(x))
    const losses = oldStarts.filter(x => !nowSet.has(x))
    count.gained += gains.length
    count.lost += losses.length
    if (!count.example && (gains.length || losses.length)) {
      const start = (losses[0] ?? gains[0]) / 12
      count.example = { pad: node + 1, start, before: summarize(prior, node, mast, start), corrected: summarize(bundle, node, mast, start) }
    }
  }
  changes.push(count)
}

function summarize(bundle, node, mast, start) {
  const r = analyze(buildObserver(bundle, node, mast), bundle.vectors, start * 12, steps, bundle.meta, defaultPower)
  return {
    utc: new Date(Date.parse(bundle.meta.start) + start * 3600000).toISOString(),
    lowLightHours: r.longestDark, earthObstructionHours: r.longestEarth, slopeDeg: r.slope,
    requiredBatteryKg: r.batteryKg, batteryFeasible: r.feasible, coverageComplete: r.complete,
  }
}

const baseline = { site: polarSites[0], node: 480, mast: 2, start: 0 }
const delayed = { ...baseline, start: 48 }
assert.ok(passing.length, 'No alternative passes at the requested delayed start')
const better = passing.find(x => x.site === baseline.site) ?? passing[0]
const baselineMetrics = summarize(bundles[0], baseline.node, baseline.mast, baseline.start)
let trade
for (const bundle of bundles) {
  for (let node = 0; !trade && node < 961; node++) {
    const mast = 2
    const start = 48
    const pad = buildObserver(bundle, node, mast)
    if (pad.slope > limits.slope) continue
    const metrics = summarize(bundle, node, mast, start)
    if (metrics.coverageComplete && metrics.earthObstructionHours < baselineMetrics.earthObstructionHours &&
        metrics.requiredBatteryKg > baselineMetrics.requiredBatteryKg + 1) {
      trade = { site: bundle.site, node, start, mast }
    }
  }
  if (trade) break
}
assert.ok(trade, 'No reproducible Earth visibility versus storage trade-off found')
assert.equal(cannotPass, 0, 'Unexpected result for zero-duration, zero-slope search limits')
const cases = [
  ['launch-delay', 'Recover a viable option after a 48-hour launch delay', baseline, better, limits],
  ['trade-off', 'Compare Earth obstruction and storage under identical power assumptions', baseline, trade, limits],
  ['no-option', 'Stress test zero allowable outages and zero slope', baseline, delayed, { dark: 0, earth: 0, slope: 0 }],
].map(([id, title, a, b, caseLimits]) => {
  const scenarios = [a, b]
  const inputs = { schema: 1, scenarios, days, limits: caseLimits, power: defaultPower, rates: ['', '', ''], equipment: 0,
    versions: scenarios.map(s => {
      const m = bundles[polarSites.indexOf(s.site)].meta
      return [m.vectorHash, m.localHash, m.regional.regional].join(':')
    }) }
  return { id, title, query: '?' + new URLSearchParams({ comparison: JSON.stringify(inputs) }), inputs,
    expected: scenarios.map(s => summarize(bundles[polarSites.indexOf(s.site)], s.node, s.mast, s.start)) }
})
if (!beforeDir) {
  const pinned = JSON.parse(await readFile(new URL('../../public/release-evidence.json', import.meta.url), 'utf8'))
  assert.equal(cases.length, pinned.cases.length)
  for (const [i, item] of cases.entries()) {
    const expected = pinned.cases[i]
    assert.equal(item.id, expected.id)
    assert.deepEqual(item.inputs, expected.inputs)
    for (const [j, metrics] of item.expected.entries()) {
      for (const [key, value] of Object.entries(metrics)) {
        if (typeof value === 'number') assert.ok(Math.abs(value - expected.expected[j][key]) < 1e-7, key)
        else assert.equal(value, expected.expected[j][key], key)
      }
    }
  }
  assert.deepEqual(changes.map(({ site, eligible }) => [site, eligible]),
    pinned.changes.map(({ site, eligible }) => [site, eligible]), 'Pinned eligibility counts changed')
}
const payload = { days, limits, mastM: 5, startsPerPad: 361, changes, cases }
console.log(JSON.stringify(payload, null, 2))
if (process.argv[3]) await writeFile(process.argv[3], JSON.stringify(payload, null, 2) + '\n')
