import { readFile } from 'node:fs/promises'
import { defaultPower } from './model.ts'
import { createWasmSearchEngine } from './wasmSearch.ts'
import { buildObserver, loadPolarSiteBundle, wasmPath } from './benchmark.mjs'
import { runMissionRecovery } from './recoverySearch.ts'

const wasmEngine = await createWasmSearchEngine(await readFile(wasmPath))
const cache = new Map()
async function getBundle(siteId) {
  if (!cache.has(siteId)) {
    const raw = await loadPolarSiteBundle(siteId)
    cache.set(siteId, {
      siteId,
      meta: raw.meta,
      vectors: raw.vectors,
      getObserver: (node, mast) => buildObserver(raw, node, mast),
    })
  }
  return cache.get(siteId)
}

const limits = { dark: 48, earth: 72, slope: 5 }

const shackletonProblem = {
  baseline: { site: 'shackleton-ridge', node: 480, start: 0, mast: 2 },
  revised: { site: 'shackleton-ridge', node: 480, start: 48, mast: 2 },
  days: 15,
  limits,
  power: defaultPower,
  delayWindowHours: { minStart: 48, maxStart: 360 },
  scope: 'all-polar',
  robustnessPreference: 'dual-extent-and-sigma',
}

// Cold pre-warm bundle load then timed runs (WASM cold, WASM warm, TS warm)
const tCold0 = performance.now()
const coldWasm = await runMissionRecovery(shackletonProblem, getBundle, { wasm: wasmEngine })
const coldMs = Math.round(performance.now() - tCold0)

const warmRuns = []
for (let i = 0; i < 2; i++) {
  const t0 = performance.now()
  await runMissionRecovery(shackletonProblem, getBundle, { wasm: wasmEngine })
  warmRuns.push(Math.round(performance.now() - t0))
}

const tTs0 = performance.now()
const tsRun = await runMissionRecovery(shackletonProblem, getBundle, { wasm: null })
const tsWarmMs = Math.round(performance.now() - tTs0)

// Demo 2: Geometry passes yet battery/power fails (pad 217 on Shackleton @ T+48h)
const powerFailProblem = {
  baseline: { site: 'shackleton-ridge', node: 180, start: 48, mast: 2 },
  revised: { site: 'shackleton-ridge', node: 216, start: 48, mast: 2 },
  days: 15,
  limits: { dark: 100, earth: 72, slope: 5 },
  power: defaultPower,
  delayWindowHours: { minStart: 0, maxStart: 360 },
  scope: 'same-site',
  robustnessPreference: 'dual-extent-and-sigma',
}
const powerFailRun = await runMissionRecovery(powerFailProblem, getBundle, { wasm: wasmEngine })

// Demo 3: Impossible constraint set -> infeasible with bounded near-misses
const infeasibleProblem = {
  baseline: { site: 'shackleton-ridge', node: 180, start: 48, mast: 2 },
  revised: { site: 'shackleton-ridge', node: 180, start: 48, mast: 2 },
  days: 15,
  limits: { dark: 0, earth: 0, slope: 0 },
  power: { ...defaultPower, budgetKg: 21 },
  delayWindowHours: { minStart: 0, maxStart: 72 },
  scope: { kind: 'sites', sites: ['shackleton-ridge'] },
  robustnessPreference: 'nominal-only',
}
const infeasibleRun = await runMissionRecovery(infeasibleProblem, getBundle, { wasm: wasmEngine })

// Demo 4: Sensitivity flip scenario (Mons Mouton pad 17 @ T+67h under tight dark limit where nominal passes, 2-sigma fails)
const mmBundle = await getBundle('mons-mouton')
const mmNominal = await runMissionRecovery(
  {
    baseline: { site: 'mons-mouton', node: 16, start: 67, mast: 2 },
    revised: { site: 'mons-mouton', node: 16, start: 67, mast: 2 },
    days: 15,
    limits: { dark: 48.7, earth: 72, slope: 5 },
    power: { ...defaultPower, budgetKg: 140, sigma: 0 },
    delayWindowHours: { minStart: 67, maxStart: 67 },
    scope: { kind: 'sites', sites: ['mons-mouton'] },
    robustnessPreference: 'dual-extent-and-sigma',
  },
  getBundle,
  { wasm: wasmEngine },
)

const report = {
  timingsMs: {
    wasmColdWithBundleLoad: coldMs,
    wasmWarmRuns: warmRuns,
    wasmWarmMedian: [...warmRuns].sort((a, b) => a - b)[1],
    tsWarmFullPolar: tsWarmMs,
    wasmBytes: wasmEngine.byteLength,
  },
  shackleton48hDemo: coldWasm.ok
    ? {
        count: coldWasm.count,
        feasibleCount: coldWasm.selection.feasibleCount,
        paretoCount: coldWasm.selection.paretoFrontier.length,
        baseline: {
          dark: coldWasm.baselineCandidate.longestDark,
          earth: coldWasm.baselineCandidate.longestEarth,
          slope: coldWasm.baselineCandidate.slope,
          batteryKg: coldWasm.baselineCandidate.batteryKg,
          feasible: coldWasm.baselineCandidate.feasible,
        },
        revised: {
          dark: coldWasm.revisedCandidate.longestDark,
          earth: coldWasm.revisedCandidate.longestEarth,
          slope: coldWasm.revisedCandidate.slope,
          batteryKg: coldWasm.revisedCandidate.batteryKg,
          feasible: coldWasm.revisedCandidate.feasible,
        },
        sameSiteBest: coldWasm.selection.sameSiteBest && {
          pad: coldWasm.selection.sameSiteBest.pad,
          start: coldWasm.selection.sameSiteBest.start,
          dark: coldWasm.selection.sameSiteBest.longestDark,
          earth: coldWasm.selection.sameSiteBest.longestEarth,
          slope: coldWasm.selection.sameSiteBest.slope,
          feasible: coldWasm.selection.sameSiteBest.feasible,
        },
        paretoTop5: coldWasm.selection.paretoFrontier.slice(0, 5).map(c => ({
          site: c.site,
          pad: c.pad,
          start: c.start,
          dark: c.longestDark,
          earth: c.longestEarth,
          slope: c.slope,
          batteryKg: Number(c.batteryKg.toFixed(2)),
          headroomKg: Number(c.headroomKg.toFixed(2)),
          displacementKm: Number(c.displacementKm.toFixed(2)),
          shiftH: c.scheduleShiftHours,
          robustness: c.robustness.classification,
          archetypes: c.archetypes,
        })),
        fingerprintWasm: coldWasm.certificate.deterministicFingerprint,
        fingerprintTs: tsRun.ok ? tsRun.certificate.deterministicFingerprint : null,
      }
    : coldWasm,
  powerDeficitDemo: powerFailRun.ok
    ? {
        statusCategory: powerFailRun.diff.statusCategory,
        firstViolatedConstraint: powerFailRun.diff.firstViolatedConstraint,
        revisedDark: powerFailRun.revisedCandidate.longestDark,
        revisedBatteryKg: Number(powerFailRun.revisedCandidate.batteryKg.toFixed(2)),
        revisedUnmetWh: Number(powerFailRun.revisedCandidate.unmetWh.toFixed(2)),
        feasibleCount: powerFailRun.selection.feasibleCount,
        recommended: powerFailRun.selection.recommended && {
          pad: powerFailRun.selection.recommended.pad,
          start: powerFailRun.selection.recommended.start,
          batteryKg: Number(powerFailRun.selection.recommended.batteryKg.toFixed(2)),
        },
      }
    : powerFailRun,
  infeasibleDemo: infeasibleRun.ok
    ? {
        statusCategory: infeasibleRun.diff.statusCategory,
        feasibleCount: infeasibleRun.selection.feasibleCount,
        nearMisses: infeasibleRun.selection.nearMisses.slice(0, 3).map(c => ({
          pad: c.pad,
          start: c.start,
          dark: c.longestDark,
          earth: c.longestEarth,
          slope: c.slope,
          batteryKg: Number(c.batteryKg.toFixed(2)),
          unmetWh: Number(c.unmetWh.toFixed(2)),
          feasible: c.feasible,
        })),
      }
    : infeasibleRun,
  sensitivityFlipDemo: mmNominal.ok
    ? {
        site: 'mons-mouton',
        pad: 17,
        start: 67,
        dark96km: mmNominal.revisedCandidate.longestDark,
        dark48km: mmNominal.revisedCandidate.referenceLongestDark,
        classification: mmNominal.revisedCandidate.robustness.classification,
        summary: mmNominal.revisedCandidate.robustness.summary,
        assumptions: mmNominal.revisedCandidate.robustness.assumptionsChecked.map(a => ({
          id: a.id,
          executed: a.executed,
          passed: a.passed,
        })),
      }
    : mmNominal,
  bundleMetaCheck: {
    monsMoutonVectorHash: mmBundle.meta.vectorHash.slice(0, 12),
  },
}

console.log(JSON.stringify(report, null, 2))
