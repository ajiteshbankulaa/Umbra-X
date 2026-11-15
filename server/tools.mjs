import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { analyze, defaultPower } from '../web/src/planner/model.ts'
import { buildObserver, loadPolarSiteBundle, polarSites, wasmPath } from '../web/src/planner/benchmark.mjs'
import { createWasmSearchEngine } from '../web/src/planner/wasmSearch.ts'
import { classifyScenarioConfidence } from '../web/src/planner/confidence.ts'
import { runMissionRecovery } from '../web/src/planner/recoverySearch.ts'
import { horizonEpoch, mastHeights, validatePlan } from './study.mjs'

export const CALCULATION_VERSION = 'umbra-x-phase4-tools-v1.0'
const defaultLimits = { dark: 48, earth: 72, slope: 5 }

const SITE_BUNDLE_CACHE = new Map()
let WASM_ENGINE_PROMISE = null

async function getBundle(site) {
  if (!polarSites.includes(site)) {
    throw new Error(`Unsupported polar terrain site '${site}'. Supported terrain sites: ${polarSites.join(', ')}.`)
  }
  if (!SITE_BUNDLE_CACHE.has(site)) {
    SITE_BUNDLE_CACHE.set(site, await loadPolarSiteBundle(site))
  }
  return SITE_BUNDLE_CACHE.get(site)
}

async function getWasmEngine() {
  if (!WASM_ENGINE_PROMISE) {
    WASM_ENGINE_PROMISE = readFile(wasmPath).then(createWasmSearchEngine).catch(() => null)
  }
  return WASM_ENGINE_PROMISE
}

async function loadRecoveryBundle(site) {
  const b = await getBundle(site)
  return {
    siteId: site,
    meta: b.meta,
    vectors: b.vectors,
    getObserver: (node, mast) => buildObserver(b, node, mast),
  }
}

export async function getSolverMetadata() {
  const bundles = await Promise.all(polarSites.map(async site => [site, await getBundle(site)]))
  const releaseSha256 = createHash('sha256')
    .update(JSON.stringify(Object.fromEntries(bundles.map(([s, b]) => [s, b.meta]))))
    .digest('hex')
  return {
    calculationVersion: CALCULATION_VERSION,
    releaseSha256,
    epoch: horizonEpoch,
    hours: 720,
    maxDays: 15,
    mastHeightsM: mastHeights,
    sites: bundles.map(([site, b]) => ({
      site,
      pads: 961,
      horizonKm: [48, 96],
      terrainSource: b.meta.regional?.source ?? 'LRO LOLA PGDA',
      vectorHash: b.meta.vectorHash,
      localHash: b.meta.localHash,
      regionalHash: b.meta.regional?.regional ?? null,
    })),
    ephemeris: 'JPL DE440 (MOON_ME_DE440_ME421); checked against JPL Horizons AIRLESS',
  }
}

function assertObjectKeys(obj, allowed, required = []) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
    throw new Error('Tool arguments must be a JSON object.')
  }
  for (const key of Object.keys(obj)) {
    if (!allowed.includes(key)) throw new Error(`Disallowed argument property '${key}'.`)
  }
  for (const req of required) {
    if (obj[req] === undefined) throw new Error(`Missing required argument property '${req}'.`)
  }
}

function validateScenarioArgs(raw, days) {
  assertObjectKeys(raw, ['site', 'node', 'start', 'mast'], ['site', 'node', 'start', 'mast'])
  if (!polarSites.includes(raw.site)) {
    throw new Error(`Site '${raw.site}' lacks compiled 96 km LOLA terrain; supported sites: ${polarSites.join(', ')}.`)
  }
  const last = 720 - days * 24
  if (!Number.isInteger(raw.node) || raw.node < 0 || raw.node > 960) {
    throw new Error(`Pad node must be an integer 0..960 (0-based for Pad #1..#961).`)
  }
  if (!Number.isInteger(raw.start) || raw.start < 0 || raw.start > last) {
    throw new Error(`Start hour offset must be an integer in 0..${last} for ${days}-day mission.`)
  }
  if (!Number.isInteger(raw.mast) || raw.mast < 0 || raw.mast > 4) {
    throw new Error(`Mast index must be an integer 0..4 (${mastHeights.join(', ')} m).`)
  }
  return { site: raw.site, node: raw.node, start: raw.start, mast: raw.mast }
}

function validateLimits(raw) {
  if (!raw) return { ...defaultLimits }
  assertObjectKeys(raw, ['dark', 'earth', 'slope'], ['dark', 'earth', 'slope'])
  const { dark, earth, slope } = raw
  if (!Number.isFinite(dark) || dark < 0 || dark > 360) throw new Error('limits.dark must be 0..360 h.')
  if (!Number.isFinite(earth) || earth < 0 || earth > 360) throw new Error('limits.earth must be 0..360 h.')
  if (!Number.isFinite(slope) || slope < 0 || slope > 90) throw new Error('limits.slope must be 0..90 deg.')
  return { dark, earth, slope }
}

function validateDays(days) {
  if (!Number.isInteger(days) || days < 1 || days > 15) {
    throw new Error('days must be an integer between 1 and 15.')
  }
  return days
}

function formatUtc(hour) {
  return new Date(Date.parse(horizonEpoch) + hour * 3600000).toISOString().slice(0, 16).replace('T', ' ') + ' UTC'
}

export async function runSingleSimulation({ site, node, start, mast, days = 15, sigma = 0, limits, budgetKg }) {
  const d = validateDays(days)
  const sc = validateScenarioArgs({ site, node, start, mast }, d)
  const lim = validateLimits(limits)
  if (!Number.isFinite(sigma) || sigma < 0 || sigma > 3) {
    throw new Error('sigma must be in 0..3.')
  }
  const b = await getBundle(sc.site)
  const observer = buildObserver(b, sc.node, sc.mast)
  const power = {
    ...defaultPower,
    sigma,
    ...(Number.isFinite(budgetKg) && budgetKg >= 10 && budgetKg <= 2000 ? { budgetKg } : {}),
  }
  const r = analyze(observer, b.vectors, sc.start * 12, d * 288, b.meta, power)
  const confidence = classifyScenarioConfidence({
    complete: r.complete,
    coveredAzimuths: r.covered,
    hasRegionalTerrain: Boolean(b.meta.regional),
    slope: r.slope,
    slopeLimit: lim.slope,
    longestDark: r.longestDark,
    referenceLongestDark: r.referenceLongestDark,
    darkLimit: lim.dark,
    longestEarth: r.longestEarth,
    referenceLongestEarth: r.referenceLongestEarth,
    earthLimit: lim.earth,
    feasible: r.feasible,
    unmetWh: r.unmetWh,
    headroomKg: r.headroomKg,
    sigma,
  })
  const geometryOk =
    r.complete &&
    r.longestDark <= lim.dark &&
    r.longestEarth <= lim.earth &&
    (r.slope === null || r.slope <= lim.slope)

  return {
    calculationVersion: CALCULATION_VERSION,
    coverageStatus: r.complete ? 'complete' : 'incomplete',
    dataProvenance: {
      site: sc.site,
      terrainSource: b.meta.regional?.source ?? 'LRO LOLA PGDA',
      ephemeris: 'JPL DE440 MOON_ME_DE440_ME421',
      vectorHash: b.meta.vectorHash,
      localHash: b.meta.localHash,
      regionalHash: b.meta.regional?.regional ?? null,
    },
    scenario: { ...sc, padNumber: sc.node + 1, mastM: mastHeights[sc.mast], startUtc: formatUtc(sc.start), days: d, sigma },
    coordinates: { latDeg: observer.coordinates[0], lonDeg: observer.coordinates[1], elevM: observer.coordinates[2] },
    metrics: {
      coveredAzimuths: r.covered,
      slopeDeg: r.slope,
      psr: observer.psr,
      longestDarkHours: Number(r.longestDark.toFixed(4)),
      longestEarthOutageHours: Number(r.longestEarth.toFixed(4)),
      reference48kmDarkHours: Number(r.referenceLongestDark.toFixed(4)),
      reference48kmEarthHours: Number(r.referenceLongestEarth.toFixed(4)),
      solarHours: Number(r.solarHours.toFixed(4)),
      earthHours: Number(r.earthHours.toFixed(4)),
      dsnHours: Number(r.dsnHours.toFixed(4)),
      stationDss14Hours: Number(r.stationHours.toFixed(4)),
      usableStorageWh: Number(r.usableWh.toFixed(2)),
      usableStorageKwh: Number((r.usableWh / 1000).toFixed(3)),
      batteryKg: Number(r.batteryKg.toFixed(2)),
      totalInstalledKg: Number(r.totalKg.toFixed(2)),
      headroomKg: Number(r.headroomKg.toFixed(2)),
      unmetLoadWh: Number(r.unmetWh.toFixed(2)),
    },
    checks: {
      geometryOk,
      powerOk: r.feasible && r.unmetWh <= 0,
      allLimitsOk: geometryOk && r.feasible && r.unmetWh <= 0,
      limits: lim,
    },
    confidence: {
      overall: confidence.overall,
      domains: confidence.domains,
      notModeled: confidence.notModeled,
    },
  }
}

export const TOOL_SCHEMAS = [
  {
    type: 'function',
    function: {
      name: 'inspect_coverage',
      description: 'Read supported lunar south-pole regions, ephemeris dates (30-day window starting 2026-11-14T00:00Z), mast heights, release hashes, and current UI scenarios.',
      parameters: { type: 'object', properties: {}, required: [], additionalProperties: false },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_scenario',
      description: 'Inspect deterministic geometry, coverage, slope, illumination, Earth/DSN visibility, and confidence for a single scenario.',
      parameters: {
        type: 'object',
        properties: {
          site: { type: 'string', enum: [...polarSites] },
          node: { type: 'integer', description: 'Zero-based pad index 0..960 (Pad #1..#961).' },
          start: { type: 'integer', description: 'UTC hour offset from 2026-11-14T00:00Z.' },
          mast: { type: 'integer', description: 'Mast index 0..4 corresponding to 1.5, 3, 5, 10, 20 m.' },
          days: { type: 'integer' },
        },
        required: ['site', 'node', 'start', 'mast'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'simulate_scenario',
      description: 'Run full physics, power/battery balance, 48km vs 96km extent check, and optional sigma height-error simulation on one scenario.',
      parameters: {
        type: 'object',
        properties: {
          site: { type: 'string', enum: [...polarSites] },
          node: { type: 'integer' },
          start: { type: 'integer' },
          mast: { type: 'integer' },
          days: { type: 'integer' },
          sigma: { type: 'number', description: 'LOLA height uncertainty multiplier 0..3.' },
          budgetKg: { type: 'number', description: 'Installed power mass budget in kg.' },
          limits: {
            type: 'object',
            properties: { dark: { type: 'number' }, earth: { type: 'number' }, slope: { type: 'number' } },
            required: ['dark', 'earth', 'slope'],
            additionalProperties: false,
          },
        },
        required: ['site', 'node', 'start', 'mast'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'compare_scenarios',
      description: 'Compare baseline vs revised/alternative scenario under mission limits to quantify which constraints failed, passed, or improved.',
      parameters: {
        type: 'object',
        properties: {
          baseline: {
            type: 'object',
            properties: { site: { type: 'string' }, node: { type: 'integer' }, start: { type: 'integer' }, mast: { type: 'integer' } },
            required: ['site', 'node', 'start', 'mast'],
            additionalProperties: false,
          },
          revised: {
            type: 'object',
            properties: { site: { type: 'string' }, node: { type: 'integer' }, start: { type: 'integer' }, mast: { type: 'integer' } },
            required: ['site', 'node', 'start', 'mast'],
            additionalProperties: false,
          },
          days: { type: 'integer' },
          limits: {
            type: 'object',
            properties: { dark: { type: 'number' }, earth: { type: 'number' }, slope: { type: 'number' } },
            required: ['dark', 'earth', 'slope'],
            additionalProperties: false,
          },
        },
        required: ['baseline', 'revised'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'search_alternatives',
      description: 'Run Rust/WASM or TS counterfactual recovery search across polar pads and launch times to discover non-dominated Pareto alternatives.',
      parameters: {
        type: 'object',
        properties: {
          baseline: {
            type: 'object',
            properties: { site: { type: 'string' }, node: { type: 'integer' }, start: { type: 'integer' }, mast: { type: 'integer' } },
            required: ['site', 'node', 'start', 'mast'],
            additionalProperties: false,
          },
          revised: {
            type: 'object',
            properties: { site: { type: 'string' }, node: { type: 'integer' }, start: { type: 'integer' }, mast: { type: 'integer' } },
            required: ['site', 'node', 'start', 'mast'],
            additionalProperties: false,
          },
          sites: { type: 'array', items: { type: 'string', enum: [...polarSites] } },
          days: { type: 'integer' },
          limits: {
            type: 'object',
            properties: { dark: { type: 'number' }, earth: { type: 'number' }, slope: { type: 'number' } },
            required: ['dark', 'earth', 'slope'],
            additionalProperties: false,
          },
          from: { type: 'integer' },
          through: { type: 'integer' },
        },
        required: ['baseline', 'sites'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'inspect_terrain_sensitivity',
      description: 'Measure sensitivity to 48km vs 96km horizon extent, 0-sigma vs 2-sigma LOLA error, and all 5 mast heights (1.5..20 m) on a pad.',
      parameters: {
        type: 'object',
        properties: {
          site: { type: 'string', enum: [...polarSites] },
          node: { type: 'integer' },
          start: { type: 'integer' },
          mast: { type: 'integer' },
          days: { type: 'integer' },
          limits: {
            type: 'object',
            properties: { dark: { type: 'number' }, earth: { type: 'number' }, slope: { type: 'number' } },
            required: ['dark', 'earth', 'slope'],
            additionalProperties: false,
          },
        },
        required: ['site', 'node', 'start', 'mast'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'retrieve_scientific_evidence',
      description: 'Search the verified NASA/JPL/NTRS/Umbra-X corpus using hybrid BM25 + Qdrant retrieval and return cited passages with SHA-256 provenance.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string' },
          topK: { type: 'integer' },
        },
        required: ['query'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_decision_certificate',
      description: 'Compute and return the deterministic fnv1a128 Decision Certificate summary and provenance for a Mission Recovery scenario pair.',
      parameters: {
        type: 'object',
        properties: {
          baseline: {
            type: 'object',
            properties: { site: { type: 'string' }, node: { type: 'integer' }, start: { type: 'integer' }, mast: { type: 'integer' } },
            required: ['site', 'node', 'start', 'mast'],
            additionalProperties: false,
          },
          revised: {
            type: 'object',
            properties: { site: { type: 'string' }, node: { type: 'integer' }, start: { type: 'integer' }, mast: { type: 'integer' } },
            required: ['site', 'node', 'start', 'mast'],
            additionalProperties: false,
          },
          sites: { type: 'array', items: { type: 'string', enum: [...polarSites] } },
          days: { type: 'integer' },
          limits: {
            type: 'object',
            properties: { dark: { type: 'number' }, earth: { type: 'number' }, slope: { type: 'number' } },
            required: ['dark', 'earth', 'slope'],
            additionalProperties: false,
          },
        },
        required: ['baseline', 'revised'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'apply_workspace_action',
      description: 'Apply real UI and mission actions in the Umbra-X 3D workspace (switch landing site, pad index 0..960, mast index 0..4, start hour offset 0..720, duration days 1..15, 3D viewport mode orbit3d/observer/polar/chart, terrain overlay, planner/learner mode, open panels, or trigger pad recovery search).',
      parameters: {
        type: 'object',
        properties: {
          target: { type: 'string', enum: ['baseline', 'alternative', 'both', 'workspace'], description: 'Which scenario slot or workspace control to update.' },
          site: { type: 'string', enum: [...polarSites] },
          node: { type: 'integer', description: 'Zero-based pad index 0..960 (Pad #1..#961).' },
          mast: { type: 'integer', description: 'Mast index 0..4 (1.5, 3, 5, 10, 20 m).' },
          start: { type: 'integer', description: 'Start hour offset 0..720 from 2026-11-14T00:00Z.' },
          days: { type: 'integer', description: 'Mission duration 1..15 days.' },
          view: { type: 'string', enum: ['orbit3d', 'observer', 'polar', 'chart'] },
          overlay: { type: 'string', enum: ['none', 'illumination', 'psr', 'earth', 'slope', 'solar_hours', 'viable'] },
          mode: { type: 'string', enum: ['planner', 'learner'] },
          openPanel: { type: 'string', enum: ['compare', 'scene', 'verdict', 'timeline', 'recover', 'power', 'methods'] },
          runRecoverySearch: { type: 'boolean' },
          note: { type: 'string' },
        },
        required: [],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'generate_chart_visualization',
      description: 'Render an inline data visualization bar/comparison chart in the Umbra Agent chat response using verified numbers from physics/recovery tools.',
      parameters: {
        type: 'object',
        properties: {
          title: { type: 'string' },
          subtitle: { type: 'string' },
          kind: { type: 'string', enum: ['grouped_bar', 'horizontal_bar', 'mast_sweep'] },
          unit: { type: 'string', description: 'Measurement unit label, e.g. h, kg, deg, kWh, %.' },
          series: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                label: { type: 'string' },
                baseline: { type: 'number' },
                alternative: { type: 'number' },
                limit: { type: 'number' },
                note: { type: 'string' },
              },
              required: ['label', 'baseline'],
              additionalProperties: false,
            },
          },
        },
        required: ['title', 'unit', 'series'],
        additionalProperties: false,
      },
    },
  },
]

export function createScientificToolbox({ retriever, coverageMeta }) {
  return {
    schemas: TOOL_SCHEMAS,

    async execute(name, rawArgs, context = {}) {
      const t0 = performance.now()
      let result
      switch (name) {
        case 'inspect_coverage': {
          assertObjectKeys(rawArgs ?? {}, [])
          const meta = coverageMeta ?? (await getSolverMetadata())
          result = {
            ...meta,
            coverageStatus: 'complete',
            dataProvenance: { releaseSha256: meta.releaseSha256, ephemeris: meta.ephemeris },
            currentContext: context,
          }
          break
        }

        case 'get_scenario': {
          assertObjectKeys(rawArgs, ['site', 'node', 'start', 'mast', 'days'], ['site', 'node', 'start', 'mast'])
          result = await runSingleSimulation({ ...rawArgs, days: rawArgs.days ?? 15, sigma: 0 })
          break
        }

        case 'simulate_scenario': {
          assertObjectKeys(
            rawArgs,
            ['site', 'node', 'start', 'mast', 'days', 'sigma', 'budgetKg', 'limits'],
            ['site', 'node', 'start', 'mast'],
          )
          result = await runSingleSimulation({
            ...rawArgs,
            days: rawArgs.days ?? 15,
            sigma: rawArgs.sigma ?? 0,
          })
          break
        }

        case 'compare_scenarios': {
          assertObjectKeys(rawArgs, ['baseline', 'revised', 'days', 'limits'], ['baseline', 'revised'])
          const days = validateDays(rawArgs.days ?? 15)
          const lim = validateLimits(rawArgs.limits)
          const [baseSim, revSim] = await Promise.all([
            runSingleSimulation({ ...rawArgs.baseline, days, limits: lim, sigma: 0 }),
            runSingleSimulation({ ...rawArgs.revised, days, limits: lim, sigma: 0 }),
          ])
          const darkDelta = Number((revSim.metrics.longestDarkHours - baseSim.metrics.longestDarkHours).toFixed(4))
          const earthDelta = Number((revSim.metrics.longestEarthOutageHours - baseSim.metrics.longestEarthOutageHours).toFixed(4))
          const battDelta = Number((revSim.metrics.batteryKg - baseSim.metrics.batteryKg).toFixed(2))
          const meta = await getSolverMetadata()
          result = {
            calculationVersion: CALCULATION_VERSION,
            coverageStatus:
              baseSim.coverageStatus === 'complete' && revSim.coverageStatus === 'complete' ? 'complete' : 'incomplete',
            dataProvenance: {
              baseline: baseSim.dataProvenance,
              revised: revSim.dataProvenance,
              releaseSha256: meta.releaseSha256,
            },
            limits: lim,
            days,
            baseline: baseSim,
            revised: revSim,
            deltas: {
              longestDarkHoursDelta: darkDelta,
              longestEarthOutageHoursDelta: earthDelta,
              batteryKgDelta: battDelta,
              batteryWhDelta: Number((revSim.metrics.usableStorageWh - baseSim.metrics.usableStorageWh).toFixed(2)),
              batteryKwhDelta: Number((revSim.metrics.usableStorageKwh - baseSim.metrics.usableStorageKwh).toFixed(3)),
            },
            summary: {
              baselinePassed: baseSim.checks.allLimitsOk,
              revisedPassed: revSim.checks.allLimitsOk,
              earthImproved: earthDelta < -0.05,
              revisedFailingConstraints: [
                ...(revSim.metrics.slopeDeg !== null && revSim.metrics.slopeDeg > lim.slope ? ['slope'] : []),
                ...(revSim.metrics.longestDarkHours > lim.dark ? ['longestDark'] : []),
                ...(revSim.metrics.longestEarthOutageHours > lim.earth ? ['longestEarth'] : []),
                ...(!revSim.checks.powerOk ? ['power'] : []),
              ],
            },
          }
          break
        }

        case 'search_alternatives': {
          assertObjectKeys(
            rawArgs,
            ['baseline', 'revised', 'sites', 'days', 'limits', 'from', 'through'],
            ['baseline', 'sites'],
          )
          const days = validateDays(rawArgs.days ?? 15)
          const lim = validateLimits(rawArgs.limits)
          const sites = [...new Set(rawArgs.sites)].filter(s => polarSites.includes(s))
          if (!sites.length) throw new Error('Select at least one valid polar site.')
          const base = validateScenarioArgs(rawArgs.baseline, days)
          const rev = rawArgs.revised ? validateScenarioArgs(rawArgs.revised, days) : { ...base, start: Math.min(720 - days * 24, base.start + 48) }
          const from = Number.isInteger(rawArgs.from) ? rawArgs.from : 0
          const through = Number.isInteger(rawArgs.through) ? rawArgs.through : 720 - days * 24
          validatePlan({ kind: 'search', sites, days, limits: lim, mast: rev.mast, from, through })

          const wasm = await getWasmEngine()
          const out = await runMissionRecovery(
            {
              baseline: base,
              revised: rev,
              days,
              limits: lim,
              power: defaultPower,
              delayWindowHours: { minStart: from, maxStart: through },
              scope: { kind: 'sites', sites },
              robustnessPreference: 'dual-extent-and-sigma',
            },
            loadRecoveryBundle,
            { wasm, maxFullEval: 36 },
          )
          if (!out.ok) throw new Error(out.errors?.join(' ') ?? 'Recovery search failed.')
          const meta = await getSolverMetadata()
          result = {
            calculationVersion: CALCULATION_VERSION,
            engine: out.engine,
            coverageStatus: 'complete',
            dataProvenance: { releaseSha256: meta.releaseSha256, sitesSearched: sites },
            passingPairCount: out.count,
            paretoCount: out.selection.paretoFrontier.length,
            recommended: out.selection.recommended
              ? {
                  site: out.selection.recommended.site,
                  padNumber: out.selection.recommended.pad,
                  node: out.selection.recommended.node,
                  start: out.selection.recommended.start,
                  startUtc: formatUtc(out.selection.recommended.start),
                  mastM: mastHeights[out.selection.recommended.mast],
                  longestDarkHours: Number(out.selection.recommended.longestDark.toFixed(2)),
                  longestEarthOutageHours: Number(out.selection.recommended.longestEarth.toFixed(2)),
                  slopeDeg: out.selection.recommended.slope !== null ? Number(out.selection.recommended.slope.toFixed(2)) : null,
                  batteryKg: Number(out.selection.recommended.batteryKg.toFixed(1)),
                  displacementKm: Number(out.selection.recommended.displacementKm.toFixed(2)),
                  robustnessStatus: out.selection.recommended.robustness.status,
                }
              : null,
            paretoFront: out.selection.paretoFrontier.slice(0, 8).map(c => ({
              site: c.site,
              padNumber: c.pad,
              node: c.node,
              start: c.start,
              mastM: mastHeights[c.mast],
              longestDarkHours: Number(c.longestDark.toFixed(2)),
              longestEarthOutageHours: Number(c.longestEarth.toFixed(2)),
              slopeDeg: c.slope !== null ? Number(c.slope.toFixed(2)) : null,
              batteryKg: Number(c.batteryKg.toFixed(1)),
              displacementKm: Number(c.displacementKm.toFixed(2)),
              robustnessStatus: c.robustness.status,
            })),
          }
          break
        }

        case 'inspect_terrain_sensitivity': {
          assertObjectKeys(rawArgs, ['site', 'node', 'start', 'mast', 'days', 'limits'], ['site', 'node', 'start', 'mast'])
          const days = validateDays(rawArgs.days ?? 15)
          const sc = validateScenarioArgs({ site: rawArgs.site, node: rawArgs.node, start: rawArgs.start, mast: rawArgs.mast }, days)
          const lim = validateLimits(rawArgs.limits)
          const [nom0, sig2, ...mastSweep] = await Promise.all([
            runSingleSimulation({ ...sc, days, sigma: 0, limits: lim }),
            runSingleSimulation({ ...sc, days, sigma: 2, limits: lim }),
            ...mastHeights.map((_, mIdx) => runSingleSimulation({ ...sc, mast: mIdx, days, sigma: 0, limits: lim })),
          ])
          const extentDeltaDark = Number((nom0.metrics.longestDarkHours - nom0.metrics.reference48kmDarkHours).toFixed(2))
          const extentDeltaEarth = Number((nom0.metrics.longestEarthOutageHours - nom0.metrics.reference48kmEarthHours).toFixed(2))
          const sigmaDeltaDark = Number((sig2.metrics.longestDarkHours - nom0.metrics.longestDarkHours).toFixed(2))
          const sigmaDeltaEarth = Number((sig2.metrics.longestEarthOutageHours - nom0.metrics.longestEarthOutageHours).toFixed(2))
          result = {
            calculationVersion: CALCULATION_VERSION,
            coverageStatus: nom0.coverageStatus,
            dataProvenance: nom0.dataProvenance,
            scenario: nom0.scenario,
            extent48Vs96Km: {
              dark48kmHours: nom0.metrics.reference48kmDarkHours,
              dark96kmHours: nom0.metrics.longestDarkHours,
              darkDeltaHours: extentDeltaDark,
              earth48kmHours: nom0.metrics.reference48kmEarthHours,
              earth96kmHours: nom0.metrics.longestEarthOutageHours,
              earthDeltaHours: extentDeltaEarth,
              extentSensitive: Math.abs(extentDeltaDark) > 0.05 || Math.abs(extentDeltaEarth) > 0.05,
            },
            sigma0Vs2Sensitivity: {
              dark0SigmaHours: nom0.metrics.longestDarkHours,
              dark2SigmaHours: sig2.metrics.longestDarkHours,
              darkDeltaHours: sigmaDeltaDark,
              earth0SigmaHours: nom0.metrics.longestEarthOutageHours,
              earth2SigmaHours: sig2.metrics.longestEarthOutageHours,
              earthDeltaHours: sigmaDeltaEarth,
              flipsGeometryPass: nom0.checks.geometryOk && !sig2.checks.geometryOk,
            },
            mastHeightSweepSummary: {
              lowestMastM: mastHeights[0],
              lowestDarkHours: mastSweep[0].metrics.longestDarkHours,
              baselineMastM: mastHeights[sc.mast],
              baselineDarkHours: nom0.metrics.longestDarkHours,
              tallestMastM: mastHeights[mastHeights.length - 1],
              tallestDarkHours: mastSweep[mastSweep.length - 1].metrics.longestDarkHours,
              mastDeltaDarkHours: Number((mastSweep[mastSweep.length - 1].metrics.longestDarkHours - mastSweep[0].metrics.longestDarkHours).toFixed(2)),
            },
            mastHeightSweep: mastSweep.map((m, idx) => ({
              mastIndex: idx,
              mastM: mastHeights[idx],
              longestDarkHours: m.metrics.longestDarkHours,
              longestEarthOutageHours: m.metrics.longestEarthOutageHours,
              geometryOk: m.checks.geometryOk,
            })),
          }
          break
        }

        case 'retrieve_scientific_evidence': {
          assertObjectKeys(rawArgs, ['query', 'topK'], ['query'])
          if (typeof rawArgs.query !== 'string' || !rawArgs.query.trim()) {
            throw new Error('query must be a non-empty string.')
          }
          const topK = rawArgs.topK === undefined ? 4 : Math.max(1, Math.min(8, Math.trunc(rawArgs.topK)))
          const res = await retriever.search(rawArgs.query, { mode: 'hybrid_rrf', topK })
          result = {
            calculationVersion: CALCULATION_VERSION,
            coverageStatus: 'complete',
            dataProvenance: {
              vectorStore: res.vectorStore,
              embeddingModel: res.embeddingModel,
              mode: res.mode,
              cacheHit: res.cacheHit,
            },
            latencyMs: res.latencyMs,
            passages: res.results.map(p => ({
              passageId: p.passageId,
              docId: p.docId,
              title: p.title,
              citation: p.citation,
              sourceUrl: p.sourceUrl,
              contentSha256: p.contentSha256,
              score: p.score,
              injectionFlags: p.injectionFlags ?? [],
              untrustedEvidenceText: p.text,
            })),
          }
          break
        }

        case 'get_decision_certificate': {
          assertObjectKeys(rawArgs, ['baseline', 'revised', 'sites', 'days', 'limits'], ['baseline', 'revised'])
          const days = validateDays(rawArgs.days ?? 15)
          const lim = validateLimits(rawArgs.limits)
          const base = validateScenarioArgs(rawArgs.baseline, days)
          const rev = validateScenarioArgs(rawArgs.revised, days)
          const sites = rawArgs.sites?.length ? [...new Set(rawArgs.sites)].filter(s => polarSites.includes(s)) : [...polarSites]
          const wasm = await getWasmEngine()
          const out = await runMissionRecovery(
            {
              baseline: base,
              revised: rev,
              days,
              limits: lim,
              power: defaultPower,
              delayWindowHours: { minStart: 0, maxStart: 720 - days * 24 },
              scope: { kind: 'sites', sites },
              robustnessPreference: 'dual-extent-and-sigma',
            },
            loadRecoveryBundle,
            { wasm, maxFullEval: 36 },
          )
          if (!out.ok) throw new Error(out.errors?.join(' ') ?? 'Certificate generation failed.')
          result = {
            calculationVersion: CALCULATION_VERSION,
            coverageStatus: 'complete',
            dataProvenance: {
              deterministicFingerprint: out.certificate.deterministicFingerprint,
              schema: out.certificate.schema,
              engine: out.engine,
            },
            certificateSummary: {
              deterministicFingerprint: out.certificate.deterministicFingerprint,
              schema: out.certificate.schema,
              statusCategory: out.diff.statusCategory,
              recommendedSite: out.selection.recommended?.site ?? null,
              recommendedPad: out.selection.recommended ? out.selection.recommended.pad : null,
              recommendedStart: out.selection.recommended?.start ?? null,
              paretoCount: out.selection.paretoFrontier.length,
              notModeled: out.certificate.knownLimitations,
            },
          }
          break
        }

        case 'apply_workspace_action': {
          assertObjectKeys(rawArgs ?? {}, [
            'target', 'site', 'node', 'mast', 'start', 'days', 'view', 'overlay', 'mode', 'openPanel', 'runRecoverySearch', 'note',
          ])
          const target = ['baseline', 'alternative', 'both', 'workspace'].includes(rawArgs?.target)
            ? rawArgs.target
            : 'baseline'
          const uiAction = { target }
          if (rawArgs?.site !== undefined) {
            if (!polarSites.includes(rawArgs.site)) throw new Error(`Unsupported site '${rawArgs.site}'.`)
            uiAction.site = rawArgs.site
          }
          if (rawArgs?.node !== undefined) {
            if (!Number.isInteger(rawArgs.node) || rawArgs.node < 0 || rawArgs.node > 960) {
              throw new Error('node must be an integer 0..960.')
            }
            uiAction.node = rawArgs.node
          }
          if (rawArgs?.mast !== undefined) {
            if (!Number.isInteger(rawArgs.mast) || rawArgs.mast < 0 || rawArgs.mast > 4) {
              throw new Error('mast must be an integer 0..4.')
            }
            uiAction.mast = rawArgs.mast
          }
          const activeDays = rawArgs?.days !== undefined ? validateDays(rawArgs.days) : validateDays(context?.days ?? 15)
          if (rawArgs?.days !== undefined) uiAction.days = activeDays
          if (rawArgs?.start !== undefined) {
            if (!Number.isInteger(rawArgs.start) || rawArgs.start < 0 || rawArgs.start > 720 - activeDays * 24) {
              throw new Error(`start must be an integer 0..${720 - activeDays * 24} for a ${activeDays}-day mission.`)
            }
            uiAction.start = rawArgs.start
          }
          if (rawArgs?.view !== undefined) {
            if (!['orbit3d', 'observer', 'polar', 'chart'].includes(rawArgs.view)) throw new Error('Invalid view mode.')
            uiAction.view = rawArgs.view
          }
          if (rawArgs?.overlay !== undefined) {
            if (!['none', 'illumination', 'psr', 'earth', 'slope', 'solar_hours', 'viable'].includes(rawArgs.overlay)) {
              throw new Error('Invalid terrain overlay.')
            }
            uiAction.overlay = rawArgs.overlay
          }
          if (rawArgs?.mode !== undefined) {
            if (!['planner', 'learner'].includes(rawArgs.mode)) throw new Error('Invalid workspace mode.')
            uiAction.mode = rawArgs.mode
          }
          if (rawArgs?.openPanel !== undefined) {
            if (!['compare', 'scene', 'verdict', 'timeline', 'recover', 'power', 'methods'].includes(rawArgs.openPanel)) {
              throw new Error('Invalid panel name.')
            }
            uiAction.openPanel = rawArgs.openPanel
          }
          if (typeof rawArgs?.runRecoverySearch === 'boolean') {
            uiAction.runRecoverySearch = rawArgs.runRecoverySearch
          }
          if (typeof rawArgs?.note === 'string' && rawArgs.note.trim()) {
            uiAction.note = rawArgs.note.trim().slice(0, 160)
          }

          let simulation = null
          const hasScenarioEdit = ['site', 'node', 'mast', 'start', 'days'].some(k => uiAction[k] !== undefined)
          if (hasScenarioEdit) {
            const slotIdx = target === 'alternative' ? 1 : 0
            const fallbackSc = context?.scenarios?.[slotIdx] ?? { site: 'shackleton-ridge', node: 480, start: slotIdx === 1 ? 48 : 0, mast: 2 }
            const merged = validateScenarioArgs({
              site: uiAction.site ?? fallbackSc.site ?? 'shackleton-ridge',
              node: uiAction.node ?? fallbackSc.node ?? 480,
              start: uiAction.start ?? fallbackSc.start ?? 0,
              mast: uiAction.mast ?? fallbackSc.mast ?? 2,
            }, activeDays)
            simulation = await runSingleSimulation({
              ...merged,
              days: activeDays,
              sigma: 0,
              limits: validateLimits(context?.limits),
            })
          }

          result = {
            calculationVersion: CALCULATION_VERSION,
            coverageStatus: 'complete',
            applied: true,
            uiAction,
            simulation,
          }
          break
        }

        case 'generate_chart_visualization': {
          assertObjectKeys(rawArgs ?? {}, ['title', 'subtitle', 'kind', 'unit', 'series'], ['title', 'unit', 'series'])
          if (typeof rawArgs.title !== 'string' || !rawArgs.title.trim()) {
            throw new Error('Chart title must be a non-empty string.')
          }
          if (typeof rawArgs.unit !== 'string' || !rawArgs.unit.trim()) {
            throw new Error('Chart unit must be a non-empty string.')
          }
          if (!Array.isArray(rawArgs.series) || rawArgs.series.length === 0 || rawArgs.series.length > 8) {
            throw new Error('Chart series must contain 1..8 items.')
          }
          const kind = ['grouped_bar', 'horizontal_bar', 'mast_sweep'].includes(rawArgs.kind)
            ? rawArgs.kind
            : 'grouped_bar'
          const series = rawArgs.series.map(item => {
            assertObjectKeys(item, ['label', 'baseline', 'alternative', 'limit', 'note'], ['label', 'baseline'])
            if (typeof item.label !== 'string' || !item.label.trim()) {
              throw new Error('Each series item needs a non-empty label.')
            }
            if (typeof item.baseline !== 'number' || !Number.isFinite(item.baseline)) {
              throw new Error(`Invalid baseline value for ${item.label}.`)
            }
            const clean = { label: item.label.trim().slice(0, 40), baseline: Number(item.baseline.toFixed(2)) }
            if (item.alternative !== undefined) {
              if (typeof item.alternative !== 'number' || !Number.isFinite(item.alternative)) {
                throw new Error(`Invalid alternative value for ${item.label}.`)
              }
              clean.alternative = Number(item.alternative.toFixed(2))
            }
            if (item.limit !== undefined) {
              if (typeof item.limit !== 'number' || !Number.isFinite(item.limit)) {
                throw new Error(`Invalid limit value for ${item.label}.`)
              }
              clean.limit = Number(item.limit.toFixed(2))
            }
            if (typeof item.note === 'string' && item.note.trim()) {
              clean.note = item.note.trim().slice(0, 80)
            }
            return clean
          })
          result = {
            calculationVersion: CALCULATION_VERSION,
            coverageStatus: 'complete',
            chart: {
              title: rawArgs.title.trim().slice(0, 90),
              subtitle: typeof rawArgs.subtitle === 'string' ? rawArgs.subtitle.trim().slice(0, 140) : '',
              kind,
              unit: rawArgs.unit.trim().slice(0, 16),
              series,
            },
          }
          break
        }

        default:
          throw new Error(`Permitted tool list does not include '${name}'.`)
      }

      return { ok: true, tool: name, elapsedMs: Number((performance.now() - t0).toFixed(2)), data: result }
    },
  }
}
