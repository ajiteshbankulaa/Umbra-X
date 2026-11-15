import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

import { defaultPower } from './model.ts'
import { createWasmSearchEngine } from './wasmSearch.ts'
import { buildObserver, loadPolarSiteBundle, wasmPath } from './benchmark.mjs'
import {
  buildDecisionCertificate,
  classifyCandidateRobustness,
  computeCounterfactualDiff,
  extractParetoFrontier,
  greatCircleKm,
  rankParetoRecoveryAlternatives,
  validateRecoveryProblem,
} from './recovery.ts'
import { runMissionRecovery } from './recoverySearch.ts'

const wasmEngine = await createWasmSearchEngine(await readFile(wasmPath))
const bundleCache = new Map()

async function getBundle(siteId) {
  if (!bundleCache.has(siteId)) {
    const raw = await loadPolarSiteBundle(siteId)
    bundleCache.set(siteId, {
      siteId,
      raw,
      meta: raw.meta,
      vectors: raw.vectors,
      getObserver: (node, mast) => buildObserver(raw, node, mast),
    })
  }
  return bundleCache.get(siteId)
}

const defaultLimits = { dark: 48, earth: 72, slope: 5 }

test('1. Defining demonstration: Shackleton Ridge pad 481 48h delay (Earth improves, slope/dark still fail -> recovers alternatives)', async () => {
  const res = await runMissionRecovery(
    {
      baseline: { site: 'shackleton-ridge', node: 480, start: 0, mast: 2 },
      revised: { site: 'shackleton-ridge', node: 480, start: 48, mast: 2 },
      days: 15,
      limits: defaultLimits,
      power: defaultPower,
      delayWindowHours: { minStart: 48, maxStart: 360 },
      scope: 'all-polar',
      robustnessPreference: 'dual-extent-and-sigma',
    },
    getBundle,
    { wasm: wasmEngine, maxFullEval: 8 },
  )

  assert.equal(res.ok, true)
  assert.equal(res.engine, 'Rust/WASM')

  // Verify counterfactual physics on Shackleton pad 481: 0h -> 48h delay.
  assert.ok(res.baselineCandidate.longestEarth > 90 && res.revisedCandidate.longestEarth < 72, 'Earth blackout drops from >90h into <72h passing regime')
  assert.ok(res.revisedCandidate.longestDark > 48, 'Max low-light remains above 48h limit')
  assert.ok((res.revisedCandidate.slope ?? 0) > 5, 'Coarse slope on pad 481 remains above 5 deg')
  assert.equal(res.diff.revisedAllOk, false)
  assert.ok(res.diff.revisedViolations.includes('slope'))
  assert.ok(res.diff.revisedViolations.includes('longestDark'))
  assert.ok(res.diff.improvedConstraints.some(s => s.toLowerCase().includes('earth')))

  // Must discover feasible alternatives with honest robustness classification.
  assert.ok(res.selection.feasibleCount > 0)
  assert.ok(res.selection.paretoFrontier.length >= 1)
  assert.ok(res.selection.recommended !== null)
  assert.equal(res.selection.recommended.feasible, true)
  assert.ok(res.selection.feasibleCount <= 8, 'detailed shortlist respects its cap across all selection passes')
  assert.ok(res.selection.paretoFrontier.every(candidate => candidate.start >= 48), 'recovery cannot precede the hard delay')
  assert.equal(res.selection.recommended.robustness.classification, 'passes_all_tested')
  assert.ok(res.certificate.deterministicFingerprint.startsWith('fnv1a128:'))
})

test('2. Sensitivity flip detection: nominal passes 96 km + power yet fails 48 km or 2-sigma uncertainty', async () => {
  // Search mons-mouton node 16 @ start 67 (or verify 2-sigma sensitivity flip on a real rim pad).
  const bundle = await getBundle('mons-mouton')
  const obs = bundle.getObserver(16, 2)
  const steps = 15 * 24 * 12

  // First test nominal 0-sigma where 48 km = 45.08h and 96 km = 48.67h -> let limit=48.7h so nominal passes, 2-sigma fails!
  const res = await runMissionRecovery(
    {
      baseline: { site: 'mons-mouton', node: 16, start: 67, mast: 2 },
      revised: { site: 'mons-mouton', node: 16, start: 67, mast: 2 },
      days: 15,
      limits: { dark: 52, earth: 72, slope: 6 },
      power: { ...defaultPower, budgetKg: 140, sigma: 0 },
      delayWindowHours: { minStart: 67, maxStart: 67 },
      scope: { kind: 'sites', sites: ['mons-mouton'] },
      robustnessPreference: 'dual-extent-and-sigma',
    },
    getBundle,
    { wasm: wasmEngine },
  )

  assert.equal(res.ok, true)
  // Check whether mons-mouton pad 17 at 2-sigma degrades past dark limit or find one in frontier if not.
  const cand = res.revisedCandidate
  const twoSigma = classifyCandidateRobustness({
    observer: obs,
    report: await import('./model.ts').then(m => m.analyze(obs, bundle.vectors, 67 * 12, steps, bundle.meta, { ...defaultPower, budgetKg: 140, sigma: 0 })),
    meta: bundle.meta,
    limits: { dark: cand.longestDark + 0.2, earth: 90, slope: (cand.slope ?? 5) + 0.5 },
    power: { ...defaultPower, budgetKg: 140, sigma: 0 },
    vectors: bundle.vectors,
    startStep: 67 * 12,
    steps,
    preference: 'dual-extent-and-sigma',
  })
  assert.equal(twoSigma.classification, 'nominal_only_sensitivity_fails')
  assert.equal(twoSigma.nominalPasses, true)
  assert.equal(twoSigma.sigma2Passes, false)
  assert.ok(twoSigma.assumptionsChecked.some(a => a.id === 'sigma_2_height_error' && a.executed && a.passed === false))
})

test('3. All constraints satisfied -> all_satisfied and passes_all_tested', async () => {
  const res = await runMissionRecovery(
    {
      baseline: { site: 'shackleton-ridge', node: 180, start: 48, mast: 2 },
      revised: { site: 'shackleton-ridge', node: 180, start: 48, mast: 2 },
      days: 15,
      limits: defaultLimits,
      power: defaultPower,
      delayWindowHours: { minStart: 48, maxStart: 48 },
      scope: { kind: 'sites', sites: ['shackleton-ridge'] },
      robustnessPreference: 'dual-extent-and-sigma',
    },
    getBundle,
    { wasm: wasmEngine },
  )
  assert.equal(res.ok, true)
  assert.equal(res.diff.statusCategory, 'all_satisfied')
  assert.equal(res.diff.revisedAllOk, true)
  assert.equal(res.diff.firstViolatedConstraint, null)
  assert.equal(res.revisedCandidate.robustness.classification, 'passes_all_tested')
})

test('4. Geometry-only vs power/battery failure explicitly separated on tight mass budget & pad 217', async () => {
  // Shackleton node 216 (pad 217) at start 48: passes 5 deg slope & Earth blackout, but battery > 80 kg usable budget!
  const res = await runMissionRecovery(
    {
      baseline: { site: 'shackleton-ridge', node: 180, start: 48, mast: 2 },
      revised: { site: 'shackleton-ridge', node: 216, start: 48, mast: 2 },
      days: 15,
      limits: { dark: 100, earth: 72, slope: 5 },
      power: defaultPower,
      delayWindowHours: { minStart: 48, maxStart: 48 },
      scope: { kind: 'sites', sites: ['shackleton-ridge'] },
      robustnessPreference: 'dual-extent-48-96km',
    },
    getBundle,
    { wasm: wasmEngine },
  )
  assert.equal(res.ok, true)
  assert.equal(res.diff.revisedGeometryOk, true)
  assert.equal(res.diff.revisedPowerOk, false)
  assert.equal(res.diff.statusCategory, 'geometry_only_power_fails')
  assert.equal(res.diff.firstViolatedConstraint, 'powerUnmet')
  assert.ok(res.diff.revisedViolations.includes('batteryMass'))
  assert.equal(res.revisedCandidate.feasible, false)
  assert.ok(res.explanation.headline.toLowerCase().includes('geometry'))
})

test('5. Multiple constraints violated preserves deterministic firstViolatedConstraint ordering', async () => {
  const res = await runMissionRecovery(
    {
      baseline: { site: 'shackleton-ridge', node: 180, start: 48, mast: 2 },
      revised: { site: 'shackleton-ridge', node: 480, start: 0, mast: 2 },
      days: 15,
      limits: defaultLimits,
      power: defaultPower,
      delayWindowHours: { minStart: 0, maxStart: 0 },
      scope: { kind: 'sites', sites: ['shackleton-ridge'] },
      robustnessPreference: 'nominal-only',
    },
    getBundle,
    { wasm: wasmEngine },
  )
  assert.equal(res.ok, true)
  assert.ok(res.diff.revisedViolations.includes('slope'))
  assert.ok(res.diff.revisedViolations.includes('longestDark'))
  assert.ok(res.diff.revisedViolations.includes('longestEarth'))
  assert.equal(res.diff.firstViolatedConstraint, 'slope')
})

test('6. Zero feasible alternatives (impossible limits) returns bounded near-misses tagged infeasible', async () => {
  const res = await runMissionRecovery(
    {
      baseline: { site: 'shackleton-ridge', node: 180, start: 48, mast: 2 },
      revised: { site: 'shackleton-ridge', node: 180, start: 48, mast: 2 },
      days: 15,
      limits: { dark: 0, earth: 0, slope: 0 },
      power: { ...defaultPower, budgetKg: 21 },
      delayWindowHours: { minStart: 0, maxStart: 72 },
      scope: { kind: 'sites', sites: ['shackleton-ridge'] },
      robustnessPreference: 'nominal-only',
    },
    getBundle,
    { wasm: wasmEngine, nearMissPadStride: 24, nearMissHourStep: 24 },
  )
  assert.equal(res.ok, true)
  assert.equal(res.selection.feasibleCount, 0)
  assert.equal(res.selection.paretoFrontier.length, 0)
  assert.equal(res.selection.recommended, null)
  assert.ok(res.selection.nearMisses.length > 0)
  for (const nm of res.selection.nearMisses) {
    assert.equal(nm.feasible, false)
  }
  assert.ok(res.explanation.alternativeFinding.includes('No passing alternative found in this search'))
  assert.ok(res.explanation.alternativeFinding.includes('unevaluated candidates'))
})

test('7. Tied & Pareto-incomparable alternatives stay in Pareto frontier without collapsing trade-offs', () => {
  const makeDummyRobustness = rank => ({
    classification: rank === 0 ? 'passes_all_tested' : 'nominal_only_sensitivity_fails',
    rank,
    nominalPasses: true,
    extent48Passes: true,
    sigma2Passes: rank === 0,
    powerFeasible: true,
    coveredAzimuths: 360,
    completeCoverage: true,
    assumptionsChecked: [],
    summary: 'test',
  })
  const makeCand = (node, start, dark, earth, slope, battKg, dispKm, shiftH, rank = 0) => ({
    site: 'shackleton-ridge',
    node,
    pad: node + 1,
    start,
    mast: 2,
    coordinates: [-89.5, 0, 0],
    longestDark: dark,
    longestEarth: earth,
    referenceLongestDark: dark,
    referenceLongestEarth: earth,
    solarPct: 80,
    dsnHours: 200,
    slope,
    batteryKg: battKg,
    unmetWh: 0,
    headroomKg: 80 - battKg,
    powerFeasible: true,
    geometryFeasible: true,
    feasible: true,
    complete: true,
    coveredAzimuths: 360,
    displacementKm: dispKm,
    scheduleShiftHours: shiftH,
    absScheduleShiftHours: Math.abs(shiftH),
    robustness: makeDummyRobustness(rank),
  })

  const a = makeCand(10, 48, 8, 24, 4.5, 25, 12, 48, 0) // lowest dark & battery
  const b = makeCand(20, 48, 20, 4, 1.2, 45, 8, 48, 0) // lowest earth & slope
  const c = makeCand(30, 0, 22, 20, 3.0, 50, 0.5, 0, 0) // nearest relocation & zero shift
  const dominatedByA = makeCand(40, 48, 12, 30, 4.8, 30, 15, 48, 0) // strictly worse than a on every objective!

  const frontier = extractParetoFrontier([a, b, c, dominatedByA])
  assert.equal(frontier.length, 3)
  assert.ok(!frontier.includes(dominatedByA))

  const ranked = rankParetoRecoveryAlternatives({ evaluated: [a, b, c, dominatedByA] })
  assert.equal(ranked.paretoFrontier.length, 3)
  assert.ok(ranked.paretoFrontier.some(x => x.archetypes?.includes('Lowest Darkness')))
  assert.ok(ranked.paretoFrontier.some(x => x.archetypes?.includes('Flattest Slope')))
  assert.ok(ranked.paretoFrontier.some(x => x.archetypes?.includes('Minimum Relocation')))
})

test('8. Validation rejects apollo-11, past-ephemeris shifts, invalid days (>15), and invalid mass budgets', () => {
  const baseProblem = {
    baseline: { site: 'shackleton-ridge', node: 480, start: 0, mast: 2 },
    revised: { site: 'shackleton-ridge', node: 480, start: 48, mast: 2 },
    days: 15,
    limits: defaultLimits,
    power: defaultPower,
    delayWindowHours: { minStart: 0, maxStart: 360 },
    scope: 'all-polar',
    robustnessPreference: 'nominal-only',
  }

  assert.equal(validateRecoveryProblem(baseProblem).ok, true)

  const apollo = validateRecoveryProblem({ ...baseProblem, revised: { ...baseProblem.revised, site: 'apollo-11' } })
  assert.equal(apollo.ok, false)
  assert.ok(apollo.errors.some(e => e.includes('apollo-11')))

  const pastEphemeris = validateRecoveryProblem({ ...baseProblem, delayWindowHours: { minStart: 0, maxStart: 400 } })
  assert.equal(pastEphemeris.ok, false)
  assert.ok(pastEphemeris.errors.some(e => e.includes('exceeds latest valid start')))

  const tooManyDays = validateRecoveryProblem({ ...baseProblem, days: 16 })
  assert.equal(tooManyDays.ok, false)

  const badBudget = validateRecoveryProblem({ ...baseProblem, power: { ...defaultPower, hardwareKg: 100, budgetKg: 100 } })
  assert.equal(badBudget.ok, false)
})

test('9. Incomplete horizon coverage -> unassessed_missing_data and insufficient_coverage', async () => {
  const bundle = await getBundle('shackleton-ridge')
  const fullObs = bundle.getObserver(180, 2)
  const partialCov = new Uint8Array(360)
  partialCov.fill(1)
  // Drop a wide sector so multiple azimuth steps are uncovered.
  for (let i = 0; i < 180; i++) partialCov[i] = 0
  const partialObs = { ...fullObs, coverage: partialCov }

  const steps = 15 * 24 * 12
  const { analyze } = await import('./model.ts')
  const fullReport = analyze(fullObs, bundle.vectors, 48 * 12, steps, bundle.meta, defaultPower)
  const partialReport = analyze(partialObs, bundle.vectors, 48 * 12, steps, bundle.meta, defaultPower)

  assert.equal(partialReport.complete, false)
  const diff = computeCounterfactualDiff({
    baseline: fullReport,
    revised: partialReport,
    limits: defaultLimits,
    power: defaultPower,
  })
  assert.equal(diff.statusCategory, 'insufficient_coverage')
  assert.equal(diff.firstViolatedConstraint, 'coverage')

  const rob = classifyCandidateRobustness({
    observer: partialObs,
    report: partialReport,
    meta: bundle.meta,
    limits: defaultLimits,
    power: defaultPower,
    vectors: bundle.vectors,
    startStep: 48 * 12,
    steps,
    preference: 'dual-extent-and-sigma',
  })
  assert.equal(rob.classification, 'unassessed_missing_data')
})

test('10. Raising mast height 1.5m (idx 0) -> 20.0m (idx 4) reduces or preserves horizon outages', async () => {
  const res = await runMissionRecovery(
    {
      baseline: { site: 'shackleton-ridge', node: 480, start: 48, mast: 0 }, // 1.5 m
      revised: { site: 'shackleton-ridge', node: 480, start: 48, mast: 4 }, // 20.0 m
      days: 15,
      limits: defaultLimits,
      power: defaultPower,
      delayWindowHours: { minStart: 48, maxStart: 48 },
      scope: { kind: 'sites', sites: ['shackleton-ridge'] },
      robustnessPreference: 'dual-extent-48-96km',
    },
    getBundle,
    { wasm: wasmEngine },
  )
  assert.equal(res.ok, true)
  assert.ok(res.revisedCandidate.longestDark <= res.baselineCandidate.longestDark + 1e-6)
  assert.ok(res.revisedCandidate.longestEarth <= res.baselineCandidate.longestEarth + 1e-6)
  assert.ok(res.revisedCandidate.batteryKg <= res.baselineCandidate.batteryKg + 1e-6)
})

test('11. WASM unavailable fallback (Optimized TS) matches Rust/WASM recovery outputs identically', async () => {
  const problem = {
    baseline: { site: 'shackleton-ridge', node: 480, start: 0, mast: 2 },
    revised: { site: 'shackleton-ridge', node: 480, start: 48, mast: 2 },
    days: 15,
    limits: defaultLimits,
    power: defaultPower,
    delayWindowHours: { minStart: 24, maxStart: 96 },
    scope: { kind: 'sites', sites: ['shackleton-ridge'] },
    robustnessPreference: 'dual-extent-48-96km',
  }

  const withWasm = await runMissionRecovery(problem, getBundle, { wasm: wasmEngine })
  const tsOnly = await runMissionRecovery(problem, getBundle, { wasm: null })

  assert.equal(withWasm.ok, true)
  assert.equal(tsOnly.ok, true)
  assert.equal(withWasm.engine, 'Rust/WASM')
  assert.equal(tsOnly.engine, 'Optimized TS')
  assert.equal(withWasm.count, tsOnly.count)
  assert.deepEqual(
    withWasm.selection.paretoFrontier.map(c => `${c.site}:${c.pad}:${c.start}`),
    tsOnly.selection.paretoFrontier.map(c => `${c.site}:${c.pad}:${c.start}`),
  )
  assert.equal(withWasm.certificate.deterministicFingerprint, tsOnly.certificate.deterministicFingerprint)
})

test('12. Worker cancellation and dataset version mismatch fail cleanly without emitting stale results', async () => {
  const problem = {
    baseline: { site: 'shackleton-ridge', node: 480, start: 0, mast: 2 },
    revised: { site: 'shackleton-ridge', node: 480, start: 48, mast: 2 },
    days: 15,
    limits: defaultLimits,
    power: defaultPower,
    delayWindowHours: { minStart: 0, maxStart: 360 },
    scope: 'all-polar',
    robustnessPreference: 'nominal-only',
  }

  let calls = 0
  const cancelled = await runMissionRecovery(problem, getBundle, {
    wasm: wasmEngine,
    shouldCancel: () => {
      calls++
      return calls >= 2
    },
  })
  assert.deepEqual(cancelled, { ok: false, cancelled: true })

  const mismatch = await runMissionRecovery(problem, getBundle, {
    wasm: wasmEngine,
    expectedVectorHashPrefix: '0000000000000000',
  })
  assert.equal(mismatch.ok, false)
  assert.equal(mismatch.cancelled, false)
  assert.ok(mismatch.errors[0].includes('version mismatch'))
})

test('13. Identical inputs produce identical Decision Certificate deterministicFingerprint & lunar displacement', async () => {
  assert.equal(Math.round(greatCircleKm(-90, 0, -89, 0) * 100) / 100, 30.32)

  const problem = {
    baseline: { site: 'shackleton-ridge', node: 480, start: 0, mast: 2 },
    revised: { site: 'shackleton-ridge', node: 480, start: 48, mast: 2 },
    days: 10,
    limits: defaultLimits,
    power: defaultPower,
    delayWindowHours: { minStart: 24, maxStart: 120 },
    scope: { kind: 'sites', sites: ['shackleton-ridge'] },
    robustnessPreference: 'dual-extent-and-sigma',
  }

  const run1 = await runMissionRecovery(problem, getBundle, { wasm: wasmEngine })
  const run2 = await runMissionRecovery(problem, getBundle, { wasm: wasmEngine })

  assert.equal(run1.ok, true)
  assert.equal(run2.ok, true)
  assert.equal(run1.certificate.deterministicFingerprint, run2.certificate.deterministicFingerprint)
  assert.equal(JSON.stringify(run1.certificate), JSON.stringify(run2.certificate))

  // Also test direct buildDecisionCertificate determinism with perturbed weights.
  const alt = buildDecisionCertificate({
    problem: { ...problem, weights: { slope: 2.5 } },
    validation: run1.validation,
    sitesMeta: { 'shackleton-ridge': (await getBundle('shackleton-ridge')).meta },
    baselineReport: null,
    revisedReport: await import('./model.ts').then(async m => {
      const b = await getBundle('shackleton-ridge')
      return m.analyze(b.getObserver(480, 2), b.vectors, 48 * 12, 10 * 24 * 12, b.meta, defaultPower)
    }),
    baselineCandidate: run1.baselineCandidate,
    revisedCandidate: run1.revisedCandidate,
    diff: run1.diff,
    selection: run1.selection,
    explanation: run1.explanation,
  })
  assert.notEqual(alt.deterministicFingerprint, run1.certificate.deterministicFingerprint)
})
