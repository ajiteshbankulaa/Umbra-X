import { analyze, searchObserverDual } from './model.ts'
import type { Limits, Metadata, Observer, Power, Report, Scenario } from './model.ts'

export const LUNAR_RADIUS_KM = 1737.4
export const POLAR_SITES = ['shackleton-ridge', 'mons-mouton', 'malapert-massif'] as const
export const MAST_HEIGHTS_M = [1.5, 3, 5, 10, 20] as const

export type PolarSiteId = (typeof POLAR_SITES)[number]
export type RecoverySpatialScope = 'same-site' | 'all-polar' | { kind: 'sites'; sites: string[] }
export type RobustnessPreference = 'nominal-only' | 'dual-extent-48-96km' | 'dual-extent-and-sigma'
export type ObjectiveKey =
  | 'longestDark'
  | 'longestEarth'
  | 'slope'
  | 'batteryKg'
  | 'displacementKm'
  | 'absScheduleShiftHours'
  | 'robustnessRank'

export interface MissionRecoveryProblem {
  baseline: Scenario
  revised: Scenario
  days: number
  limits: Limits
  power: Power
  delayWindowHours: { minStart: number; maxStart: number }
  scope: RecoverySpatialScope
  robustnessPreference: RobustnessPreference
  weights?: Partial<Record<ObjectiveKey, number>>
  baselineLabel?: string
  revisedLabel?: string
}

export type ProblemValidationResult = { ok: true; sites: string[]; steps: number } | { ok: false; errors: string[] }

export type ConstraintId =
  | 'coverage'
  | 'slope'
  | 'longestDark'
  | 'longestEarth'
  | 'powerUnmet'
  | 'batteryMass'

export interface ConstraintCheck {
  id: ConstraintId
  label: string
  category: 'coverage' | 'geometry' | 'power'
  actual: number | null
  limit: number | null
  unit: string
  passed: boolean
  margin: number | null
}

export interface MetricDelta {
  key: 'longestDark' | 'longestEarth' | 'slope' | 'batteryKg' | 'unmetWh' | 'headroomKg' | 'solarHours' | 'dsnHours'
  label: string
  unit: string
  before: number | null
  after: number | null
  delta: number | null
  relativePct: number | null
  direction: 'improved' | 'deteriorated' | 'unchanged' | 'unavailable'
}

export type DiffStatusCategory =
  | 'all_satisfied'
  | 'geometry_only_power_fails'
  | 'partial_improvement_still_infeasible'
  | 'insufficient_coverage'
  | 'infeasible'

export interface CounterfactualDiff {
  baselineLabel: string
  revisedLabel: string
  statusCategory: DiffStatusCategory
  baselineGeometryOk: boolean
  baselinePowerOk: boolean
  baselineAllOk: boolean
  revisedGeometryOk: boolean
  revisedPowerOk: boolean
  revisedAllOk: boolean
  firstViolatedConstraint: ConstraintId | null
  baselineViolations: ConstraintId[]
  revisedViolations: ConstraintId[]
  improvedConstraints: string[]
  deterioratedConstraints: string[]
  unchangedFailingConstraints: string[]
  checksBefore: ConstraintCheck[]
  checksAfter: ConstraintCheck[]
  metricDeltas: MetricDelta[]
  coverageSufficient: boolean
  summary: string
}

export type RobustnessClassification =
  | 'passes_all_tested'
  | 'nominal_only_sensitivity_fails'
  | 'unassessed_missing_data'
  | 'fails_constraints'

export interface AssumptionCheck {
  id: 'regional_coverage' | 'extent_96km_nominal' | 'extent_48km_comparison' | 'sigma_2_height_error' | 'power_balance'
  label: string
  executed: boolean
  passed: boolean | null
  detail: string
}

export interface CandidateRobustness {
  classification: RobustnessClassification
  /** Rank used as 7th Pareto objective: 0 = passes all tested, 1 = passes nominal / fails sensitivity, 2 = unassessed, 3 = fails. */
  rank: number
  nominalPasses: boolean
  extent48Passes: boolean | null
  sigma2Passes: boolean | null
  powerFeasible: boolean
  coveredAzimuths: number
  completeCoverage: boolean
  assumptionsChecked: AssumptionCheck[]
  summary: string
}

export interface RecoveryCandidate {
  site: string
  node: number
  pad: number
  start: number
  mast: number
  coordinates: [number, number, number]
  longestDark: number
  longestEarth: number
  referenceLongestDark: number
  referenceLongestEarth: number
  solarPct: number
  dsnHours: number
  slope: number | null
  batteryKg: number
  unmetWh: number
  headroomKg: number
  powerFeasible: boolean
  geometryFeasible: boolean
  feasible: boolean
  complete: boolean
  coveredAzimuths: number
  displacementKm: number
  scheduleShiftHours: number
  absScheduleShiftHours: number
  robustness: CandidateRobustness
  archetypes?: string[]
  weightedScore?: number
  normalizedViolation?: number
}

export interface ParetoSelectionResult {
  feasibleCount: number
  totalEvaluatedCount: number
  paretoFrontier: RecoveryCandidate[]
  recommended: RecoveryCandidate | null
  sameSiteBest: RecoveryCandidate | null
  geometryOnlyPowerFail: RecoveryCandidate[]
  nearMisses: RecoveryCandidate[]
  weightsApplied: Record<ObjectiveKey, number>
}

export interface RecoveryExplanation {
  headline: string
  whatChanged: string
  samePadFinding: string
  alternativeFinding: string
  tradeoffNote: string
  sensitivityNote: string
  notModeledNote: string
}

export interface MissionDecisionCertificate {
  schema: string
  calculationVersion: string
  deterministicFingerprint: string
  generatedWithoutWallClockTimestamp: true
  problem: MissionRecoveryProblem
  validation: ProblemValidationResult
  scientificDataProvenance: {
    sites: Record<
      string,
      {
        vectorHash: string
        localHash: string
        regionalSource: string | null
        radiusM: number | null
        comparisonRadiusM: number | null
        frame: string
        station: { name: string; maskDeg: number; source: string }
        kernels: Record<string, { url: string; sha256: string }>
      }
    >
  }
  ephemerisCoverage: {
    startUtc: string
    stepMinutes: number
    count: number
    totalHours: number
    requestedWindowStartHours: number
    requestedWindowHours: number
  }
  terrainCoverage: {
    azimuthBins: number
    nominalRadiusKm: number
    comparisonRadiusKm: number
    baselineComplete: boolean
    revisedComplete: boolean
  }
  modelAssumptions: {
    solarThreshold: number
    arrayMode: string
    nominalSigma: number
    specificWh: number
    hardwareKg: number
    budgetKg: number
    limits: Limits
  }
  counterfactualComparison: CounterfactualDiff
  sensitivityResults: {
    baseline: CandidateRobustness | null
    revised: CandidateRobustness
    recommended: CandidateRobustness | null
  }
  samePadRecovery: RecoveryCandidate | null
  paretoAlternatives: RecoveryCandidate[]
  geometryOnlyPowerFailures: RecoveryCandidate[]
  nearMisses: RecoveryCandidate[]
  knownLimitations: string[]
  searchCoverage?: {
    geometryPassingPairs: number
    representativeCandidates: number
    detailedCandidates: number
    exhaustivePowerSearch: boolean
  }
  causalConclusion: RecoveryExplanation
}

export const KNOWN_LIMITATIONS: string[] = [
  '20 m LOLA digital elevation model omits boulder fields, micro-craters, and slopes below ~20 m spatial scale.',
  '20 m finite-difference terrain slopes exhibit ~0.2-0.4 deg RMSE uncertainty relative to independent LOLA LDSM baselines.',
  'Subsurface regolith ice presence, rover trafficability, RF link margin/multipath, and thermal transient power loads are not modeled.',
  'Deterministic hourly/5-min energy balance assumes idealized PV tracking mode and constant average payload draw.',
  'Robustness classifications cover only the executed 48 km vs 96 km extents and up to 2-sigma vertical LOLA horizon perturbations, not global statistical certainty.',
]

export function resolveMastMeters(mastIndex: number): number {
  return MAST_HEIGHTS_M[mastIndex] ?? mastIndex
}

export function greatCircleKm(lat1Deg: number, lon1Deg: number, lat2Deg: number, lon2Deg: number): number {
  const rad = Math.PI / 180
  const phi1 = lat1Deg * rad
  const phi2 = lat2Deg * rad
  const dPhi = (lat2Deg - lat1Deg) * rad
  const dLam = (lon2Deg - lon1Deg) * rad
  const a = Math.sin(dPhi / 2) ** 2 + Math.cos(phi1) * Math.cos(phi2) * Math.sin(dLam / 2) ** 2
  return 2 * LUNAR_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(Math.max(0, a))))
}

function stableSortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableSortJson)
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      const v = (value as Record<string, unknown>)[key]
      if (v !== undefined) out[key] = stableSortJson(v)
    }
    return out
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return String(value)
    return Object.is(value, -0) ? 0 : Math.round(value * 1e6) / 1e6
  }
  return value
}

/** Deterministic 64-bit FNV-1a hex fingerprint over canonicalized JSON for offline reproducibility without async SubtleCrypto dependency. */
export function canonicalFingerprint(input: unknown): string {
  const serialized = JSON.stringify(stableSortJson(input))
  let h1 = 0xcbf29ce484222325n
  const prime = 0x100000001b3n
  const mask = 0xffffffffffffffffn
  for (let i = 0; i < serialized.length; i++) {
    h1 ^= BigInt(serialized.charCodeAt(i))
    h1 = (h1 * prime) & mask
  }
  let h2 = 0x9e3779b97f4a7c15n
  for (let i = serialized.length - 1; i >= 0; i--) {
    h2 ^= BigInt(serialized.charCodeAt(i) + (i & 0xff))
    h2 = (h2 * prime) & mask
  }
  return `fnv1a128:${h1.toString(16).padStart(16, '0')}${h2.toString(16).padStart(16, '0')}`
}

export function validateRecoveryProblem(
  problem: MissionRecoveryProblem,
  hoursAvailable = 720,
  stepMinutes = 5,
): ProblemValidationResult {
  const errors: string[] = []
  const isPolar = (site: string) => (POLAR_SITES as readonly string[]).includes(site)

  if (!isPolar(problem.baseline.site)) {
    errors.push(`Baseline site '${problem.baseline.site}' is not a compiled polar terrain bundle (${POLAR_SITES.join(', ')}).`)
  }
  if (!isPolar(problem.revised.site)) {
    errors.push(`Revised site '${problem.revised.site}' is not a compiled polar terrain bundle (${POLAR_SITES.join(', ')}).`)
  }
  if (!Number.isInteger(problem.days) || problem.days < 1 || problem.days > 15) {
    errors.push(`Mission duration (${problem.days} d) must be an integer between 1 and 15 days.`)
  }
  for (const [name, s] of [
    ['baseline', problem.baseline],
    ['revised', problem.revised],
  ] as const) {
    if (!Number.isInteger(s.mast) || s.mast < 0 || s.mast >= MAST_HEIGHTS_M.length) {
      errors.push(`${name} mast index (${s.mast}) must be 0..${MAST_HEIGHTS_M.length - 1} (${MAST_HEIGHTS_M.join('/')} m).`)
    }
    if (!Number.isInteger(s.node) || s.node < 0 || s.node >= 961) {
      errors.push(`${name} pad node (${s.node}) must be in 0..960.`)
    }
    if (!Number.isFinite(s.start) || s.start < 0 || s.start + problem.days * 24 > hoursAvailable) {
      errors.push(
        `${name} start (${s.start} h) + duration (${problem.days * 24} h) exceeds available ephemeris coverage (${hoursAvailable} h).`,
      )
    }
  }

  const maxStartAllowed = Math.max(0, hoursAvailable - problem.days * 24)
  if (!Number.isFinite(problem.delayWindowHours.minStart) || !Number.isFinite(problem.delayWindowHours.maxStart)) {
    errors.push('Delay search window bounds must be finite numbers.')
  } else {
    if (problem.delayWindowHours.minStart < 0) {
      errors.push(`Delay search window minStart (${problem.delayWindowHours.minStart} h) cannot be negative.`)
    }
    if (problem.delayWindowHours.maxStart > maxStartAllowed) {
      errors.push(
        `Delay search window maxStart (${problem.delayWindowHours.maxStart} h) exceeds latest valid start (${maxStartAllowed} h) for a ${problem.days}-day mission.`,
      )
    }
    if (problem.delayWindowHours.minStart > problem.delayWindowHours.maxStart) {
      errors.push(
        `Delay search window minStart (${problem.delayWindowHours.minStart} h) exceeds maxStart (${problem.delayWindowHours.maxStart} h).`,
      )
    }
  }

  if (problem.limits.dark < 0 || problem.limits.earth < 0 || problem.limits.slope < 0) {
    errors.push('Engineering limits (dark, earth, slope) must be non-negative.')
  }
  if (problem.power.arrayW <= 0 || problem.power.loadW <= 0 || problem.power.specificWh <= 0) {
    errors.push('Power arrayW, loadW, and battery specificWh must be positive.')
  }
  if (problem.power.hardwareKg < 0 || problem.power.budgetKg <= problem.power.hardwareKg) {
    errors.push(
      `Mass budget (${problem.power.budgetKg} kg) must strictly exceed fixed hardware mass (${problem.power.hardwareKg} kg).`,
    )
  }

  let sites: string[] = []
  if (problem.scope === 'same-site') {
    sites = [problem.revised.site]
  } else if (problem.scope === 'all-polar') {
    sites = [...POLAR_SITES]
  } else {
    sites = [...problem.scope.sites]
    if (!sites.length) errors.push('Explicit recovery scope must specify at least one site.')
    for (const site of sites) {
      if (!isPolar(site)) {
        errors.push(`Scope site '${site}' is not a compiled polar terrain bundle.`)
      }
    }
  }

  if (errors.length) return { ok: false, errors }
  return {
    ok: true,
    sites,
    steps: Math.round((problem.days * 24 * 60) / stepMinutes),
  }
}

export function buildConstraintChecks(report: Report, limits: Limits, power: Power): ConstraintCheck[] {
  const usableMassBudget = Math.max(0, power.budgetKg - power.hardwareKg)
  const checks: ConstraintCheck[] = [
    {
      id: 'coverage',
      label: '96 km horizon azimuth coverage',
      category: 'coverage',
      actual: report.complete ? 1 : 0,
      limit: 1,
      unit: 'bool',
      passed: report.complete,
      margin: report.complete ? 0 : -1,
    },
    {
      id: 'slope',
      label: '20 m LOLA coarse slope',
      category: 'geometry',
      actual: report.slope,
      limit: limits.slope,
      unit: 'deg',
      passed: report.slope !== null && report.slope <= limits.slope,
      margin: report.slope === null ? null : limits.slope - report.slope,
    },
    {
      id: 'longestDark',
      label: 'Longest solar low-light outage',
      category: 'geometry',
      actual: report.longestDark,
      limit: limits.dark,
      unit: 'h',
      passed: report.longestDark <= limits.dark,
      margin: limits.dark - report.longestDark,
    },
    {
      id: 'longestEarth',
      label: 'Longest direct-to-Earth blackout',
      category: 'geometry',
      actual: report.longestEarth,
      limit: limits.earth,
      unit: 'h',
      passed: report.longestEarth <= limits.earth,
      margin: limits.earth - report.longestEarth,
    },
    {
      id: 'powerUnmet',
      label: 'Unmet electrical load',
      category: 'power',
      actual: report.unmetWh,
      limit: 0,
      unit: 'Wh',
      passed: report.unmetWh < 1e-6,
      margin: -report.unmetWh,
    },
    {
      id: 'batteryMass',
      label: 'Required battery mass vs available budget',
      category: 'power',
      actual: report.batteryKg,
      limit: usableMassBudget,
      unit: 'kg',
      passed: report.batteryKg + power.hardwareKg <= power.budgetKg + 1e-9,
      margin: usableMassBudget - report.batteryKg,
    },
  ]
  return checks
}

export function computeCounterfactualDiff(input: {
  baseline: Report
  revised: Report
  limits: Limits
  power: Power
  baselineLabel?: string
  revisedLabel?: string
}): CounterfactualDiff {
  const baselineLabel = input.baselineLabel ?? 'Baseline plan'
  const revisedLabel = input.revisedLabel ?? 'Revised plan'
  const checksBefore = buildConstraintChecks(input.baseline, input.limits, input.power)
  const checksAfter = buildConstraintChecks(input.revised, input.limits, input.power)

  const passedByCategory = (checks: ConstraintCheck[], cat: ConstraintCheck['category']) =>
    checks.filter(c => c.category === cat).every(c => c.passed)

  const baselineGeometryOk = passedByCategory(checksBefore, 'geometry') && input.baseline.complete
  const baselinePowerOk = passedByCategory(checksBefore, 'power') && input.baseline.feasible
  const baselineAllOk = baselineGeometryOk && baselinePowerOk

  const revisedGeometryOk = passedByCategory(checksAfter, 'geometry') && input.revised.complete
  const revisedPowerOk = passedByCategory(checksAfter, 'power') && input.revised.feasible
  const revisedAllOk = revisedGeometryOk && revisedPowerOk

  const baselineViolations = checksBefore.filter(c => !c.passed).map(c => c.id)
  const revisedViolations = checksAfter.filter(c => !c.passed).map(c => c.id)

  const metricSpecs: Array<{
    key: MetricDelta['key']
    label: string
    unit: string
    get: (r: Report) => number | null
    lowerIsBetter: boolean
  }> = [
    { key: 'longestDark', label: 'Max low-light interval', unit: 'h', get: r => r.longestDark, lowerIsBetter: true },
    { key: 'longestEarth', label: 'Max Earth blackout', unit: 'h', get: r => r.longestEarth, lowerIsBetter: true },
    { key: 'slope', label: 'Coarse slope', unit: 'deg', get: r => r.slope, lowerIsBetter: true },
    { key: 'batteryKg', label: 'Battery mass required', unit: 'kg', get: r => r.batteryKg, lowerIsBetter: true },
    { key: 'unmetWh', label: 'Unmet energy deficit', unit: 'Wh', get: r => r.unmetWh, lowerIsBetter: true },
    { key: 'headroomKg', label: 'Mass budget headroom', unit: 'kg', get: r => r.headroomKg, lowerIsBetter: false },
    { key: 'solarHours', label: 'Total solar hours', unit: 'h', get: r => r.solarHours, lowerIsBetter: false },
    { key: 'dsnHours', label: 'DSN window hours', unit: 'h', get: r => r.dsnHours, lowerIsBetter: false },
  ]

  const metricDeltas: MetricDelta[] = metricSpecs.map(spec => {
    const before = spec.get(input.baseline)
    const after = spec.get(input.revised)
    if (before === null || after === null) {
      return {
        key: spec.key,
        label: spec.label,
        unit: spec.unit,
        before,
        after,
        delta: null,
        relativePct: null,
        direction: 'unavailable',
      }
    }
    const delta = after - before
    const relativePct = Math.abs(before) > 1e-6 ? (delta / Math.abs(before)) * 100 : null
    let direction: MetricDelta['direction'] = 'unchanged'
    if (Math.abs(delta) > 1e-4) {
      const better = spec.lowerIsBetter ? delta < 0 : delta > 0
      direction = better ? 'improved' : 'deteriorated'
    }
    return { key: spec.key, label: spec.label, unit: spec.unit, before, after, delta, relativePct, direction }
  })

  const improvedConstraints: string[] = []
  const deterioratedConstraints: string[] = []
  const unchangedFailingConstraints: string[] = []

  for (let i = 0; i < checksBefore.length; i++) {
    const b = checksBefore[i]
    const a = checksAfter[i]
    if (b.id === 'coverage') {
      if (!b.passed && a.passed) improvedConstraints.push(`${a.label} restored`)
      else if (b.passed && !a.passed) deterioratedConstraints.push(`${a.label} became incomplete`)
      else if (!a.passed) unchangedFailingConstraints.push(a.label)
      continue
    }
    if (b.margin === null || a.margin === null) continue
    const marginGain = a.margin - b.margin
    if (Math.abs(marginGain) > 1e-4) {
      const line = `${a.label} (${b.actual?.toFixed(2)} -> ${a.actual?.toFixed(2)} ${a.unit}; limit ${a.limit?.toFixed(2)} ${a.unit})`
      if (marginGain > 0) improvedConstraints.push(line)
      else deterioratedConstraints.push(line)
    } else if (!a.passed) {
      unchangedFailingConstraints.push(
        `${a.label} unchanged and still failing (${a.actual?.toFixed(2)} vs limit ${a.limit?.toFixed(2)} ${a.unit})`,
      )
    }
  }

  // Order for reporting first violated constraint cleanly.
  const firstViolatedConstraint = revisedViolations.length ? revisedViolations[0] : null
  const coverageSufficient = input.revised.complete

  let statusCategory: DiffStatusCategory = 'all_satisfied'
  if (!coverageSufficient) {
    statusCategory = 'insufficient_coverage'
  } else if (revisedAllOk) {
    statusCategory = 'all_satisfied'
  } else if (revisedGeometryOk && !revisedPowerOk) {
    statusCategory = 'geometry_only_power_fails'
  } else if (improvedConstraints.length > 0 && revisedViolations.length > 0) {
    statusCategory = 'partial_improvement_still_infeasible'
  } else {
    statusCategory = 'infeasible'
  }

  let summary = `${revisedLabel} satisfies all geometry and power constraints.`
  if (statusCategory === 'insufficient_coverage') {
    summary = `${revisedLabel} has incomplete regional horizon azimuth coverage; outage bounds are unverified.`
  } else if (statusCategory === 'geometry_only_power_fails') {
    summary = `${revisedLabel} passes geometric limits (dark/Earth/slope), but fails energy storage mass/load sizing (${input.revised.batteryKg.toFixed(1)} kg required, ${input.revised.unmetWh.toFixed(0)} Wh unmet).`
  } else if (!revisedAllOk) {
    summary = `${revisedLabel} remains infeasible (${revisedViolations.length} constraint(s) violated: ${revisedViolations.join(', ')})` +
      (improvedConstraints.length ? `, despite partial improvement in ${improvedConstraints.length} metric(s).` : '.')
  }

  return {
    baselineLabel,
    revisedLabel,
    statusCategory,
    baselineGeometryOk,
    baselinePowerOk,
    baselineAllOk,
    revisedGeometryOk,
    revisedPowerOk,
    revisedAllOk,
    firstViolatedConstraint,
    baselineViolations,
    revisedViolations,
    improvedConstraints,
    deterioratedConstraints,
    unchangedFailingConstraints,
    checksBefore,
    checksAfter,
    metricDeltas,
    coverageSufficient,
    summary,
  }
}

export function countCoveredAzimuths(observer: Observer): number {
  let covered = 0
  for (let i = 0; i < 360; i++) {
    if (observer.coverage[i]) covered++
  }
  return covered
}

export function classifyCandidateRobustness(input: {
  observer: Observer
  report: Report
  meta: Metadata
  limits: Limits
  power: Power
  vectors: Float64Array
  startStep: number
  steps: number
  preference: RobustnessPreference
}): CandidateRobustness {
  const coveredAzimuths = countCoveredAzimuths(input.observer)
  const completeCoverage = input.report.complete && coveredAzimuths === 360 && input.meta.regional !== null
  const powerFeasible = input.report.feasible
  const nominalGeometryPasses =
    input.report.slope !== null &&
    input.report.slope <= input.limits.slope &&
    input.report.longestDark <= input.limits.dark &&
    input.report.longestEarth <= input.limits.earth
  const nominalPasses = completeCoverage && nominalGeometryPasses && powerFeasible

  const assumptionsChecked: AssumptionCheck[] = [
    {
      id: 'regional_coverage',
      label: '360-deg regional 96 km LOLA coverage',
      executed: true,
      passed: completeCoverage,
      detail: `${coveredAzimuths}/360 azimuths covered; complete=${input.report.complete}.`,
    },
    {
      id: 'extent_96km_nominal',
      label: '96 km LOLA horizon nominal geometry',
      executed: true,
      passed: nominalGeometryPasses,
      detail: `dark=${input.report.longestDark.toFixed(2)}h (limit ${input.limits.dark}h), earth=${input.report.longestEarth.toFixed(2)}h (limit ${input.limits.earth}h), slope=${input.report.slope?.toFixed(2) ?? 'n/a'} deg (limit ${input.limits.slope} deg).`,
    },
    {
      id: 'power_balance',
      label: 'Hourly/5-min energy balance & mass budget',
      executed: true,
      passed: powerFeasible,
      detail: `battery=${input.report.batteryKg.toFixed(2)} kg, headroom=${input.report.headroomKg.toFixed(2)} kg, unmet=${input.report.unmetWh.toFixed(1)} Wh.`,
    },
  ]

  let extent48Passes: boolean | null = null
  if (input.meta.regional) {
    extent48Passes =
      input.report.referenceLongestDark <= input.limits.dark &&
      input.report.referenceLongestEarth <= input.limits.earth
    assumptionsChecked.push({
      id: 'extent_48km_comparison',
      label: '48 km regional horizon sensitivity extent',
      executed: true,
      passed: extent48Passes,
      detail: `48km dark=${input.report.referenceLongestDark.toFixed(2)}h, 48km earth=${input.report.referenceLongestEarth.toFixed(2)}h.`,
    })
  } else {
    assumptionsChecked.push({
      id: 'extent_48km_comparison',
      label: '48 km regional horizon sensitivity extent',
      executed: false,
      passed: null,
      detail: 'Regional sensitivity extent unavailable.',
    })
  }

  let sigma2Passes: boolean | null = null
  const wantsSigma = input.preference === 'dual-extent-and-sigma'
  if (wantsSigma && input.observer.horizonError && completeCoverage) {
    const sigmaProfile = Math.max(2, input.power.sigma ?? 0)
    const sigmaReport = analyze(input.observer, input.vectors, input.startStep, input.steps, input.meta, {
      ...input.power,
      sigma: sigmaProfile,
    })
    sigma2Passes =
      sigmaReport.slope !== null &&
      sigmaReport.slope <= input.limits.slope &&
      sigmaReport.longestDark <= input.limits.dark &&
      sigmaReport.longestEarth <= input.limits.earth &&
      sigmaReport.feasible
    assumptionsChecked.push({
      id: 'sigma_2_height_error',
      label: `${sigmaProfile}-sigma LOLA vertical horizon uncertainty profile`,
      executed: true,
      passed: sigma2Passes,
      detail: `${sigmaProfile}sigma dark=${sigmaReport.longestDark.toFixed(2)}h, earth=${sigmaReport.longestEarth.toFixed(2)}h, battery=${sigmaReport.batteryKg.toFixed(2)} kg, feasible=${sigmaReport.feasible}.`,
    })
  } else if (wantsSigma) {
    assumptionsChecked.push({
      id: 'sigma_2_height_error',
      label: '2-sigma LOLA vertical horizon uncertainty profile',
      executed: false,
      passed: null,
      detail: 'Cannot assess 2-sigma profile because horizonError or 360-deg regional coverage is missing.',
    })
  }

  if (!completeCoverage || !input.meta.regional || (wantsSigma && sigma2Passes === null)) {
    return {
      classification: 'unassessed_missing_data',
      rank: 2,
      nominalPasses,
      extent48Passes,
      sigma2Passes,
      powerFeasible,
      coveredAzimuths,
      completeCoverage,
      assumptionsChecked,
      summary: `Unassessed (${coveredAzimuths}/360 covered azimuths or missing uncertainty layer).`,
    }
  }

  if (!nominalPasses) {
    return {
      classification: 'fails_constraints',
      rank: 3,
      nominalPasses,
      extent48Passes,
      sigma2Passes,
      powerFeasible,
      coveredAzimuths,
      completeCoverage,
      assumptionsChecked,
      summary: 'Fails nominal geometry, coverage, or power/battery constraints.',
    }
  }

  const sensitivityFailed =
    (input.preference !== 'nominal-only' && extent48Passes === false) ||
    (wantsSigma && sigma2Passes === false)

  if (sensitivityFailed) {
    const failedParts = [
      extent48Passes === false ? '48 km extent' : null,
      sigma2Passes === false ? '2-sigma LOLA margin' : null,
    ].filter(Boolean)
    return {
      classification: 'nominal_only_sensitivity_fails',
      rank: 1,
      nominalPasses,
      extent48Passes,
      sigma2Passes,
      powerFeasible,
      coveredAzimuths,
      completeCoverage,
      assumptionsChecked,
      summary: `Nominal only: passes 96 km nominal limits + power budget, but fails ${failedParts.join(' & ')} check.`,
    }
  }

  const verifiedParts = ['96 km nominal geometry', 'energy/battery budget']
  if (input.preference !== 'nominal-only' && extent48Passes === true) verifiedParts.push('48 km extent')
  if (wantsSigma && sigma2Passes === true) verifiedParts.push(`${Math.max(2, input.power.sigma ?? 0)}-sigma LOLA height margin`)

  return {
    classification: 'passes_all_tested',
    rank: 0,
    nominalPasses,
    extent48Passes,
    sigma2Passes,
    powerFeasible,
    coveredAzimuths,
    completeCoverage,
    assumptionsChecked,
    summary: `Stable across tested profiles (${verifiedParts.join(', ')}).`,
  }
}

export function evaluateScenarioCandidate(input: {
  site: string
  node: number
  start: number
  mast: number
  observer: Observer
  vectors: Float64Array
  meta: Metadata
  limits: Limits
  power: Power
  baseline: { coordinates: [number, number, number]; start: number }
  preference: RobustnessPreference
}): RecoveryCandidate {
  const stepHours = input.meta.stepMinutes / 60
  const startStep = Math.round(input.start / stepHours)
  // Expect caller to pass full duration via baseline? Pass steps explicitly when calling buildCandidate; default 24h*10d=2880 if omitted
  return evaluateCandidateWithSteps({ ...input, startStep, steps: Math.min(input.meta.count - 1 - startStep, 2880) })
}

export function evaluateCandidateReportWithSteps(input: {
  site: string
  node: number
  start: number
  mast: number
  observer: Observer
  vectors: Float64Array
  meta: Metadata
  limits: Limits
  power: Power
  baseline: { coordinates: [number, number, number]; start: number }
  preference: RobustnessPreference
  startStep: number
  steps: number
}): { candidate: RecoveryCandidate; report: Report } {
  const report = analyze(input.observer, input.vectors, input.startStep, input.steps, input.meta, input.power)
  const totalHours = input.steps * (input.meta.stepMinutes / 60)
  const robustness = classifyCandidateRobustness({
    observer: input.observer,
    report,
    meta: input.meta,
    limits: input.limits,
    power: input.power,
    vectors: input.vectors,
    startStep: input.startStep,
    steps: input.steps,
    preference: input.preference,
  })
  const geometryFeasible =
    report.complete &&
    report.slope !== null &&
    report.slope <= input.limits.slope &&
    report.longestDark <= input.limits.dark &&
    report.longestEarth <= input.limits.earth
  const feasible = geometryFeasible && report.feasible
  const displacementKm = greatCircleKm(
    input.baseline.coordinates[0],
    input.baseline.coordinates[1],
    input.observer.coordinates[0],
    input.observer.coordinates[1],
  )
  const scheduleShiftHours = input.start - input.baseline.start

  const slopeRatio = input.limits.slope > 0 && report.slope !== null ? Math.max(0, report.slope - input.limits.slope) / input.limits.slope : report.slope === null ? 1 : 0
  const darkRatio = Math.max(0, report.longestDark - input.limits.dark) / Math.max(1, input.limits.dark)
  const earthRatio = Math.max(0, report.longestEarth - input.limits.earth) / Math.max(1, input.limits.earth)
  const usableKg = Math.max(1e-6, input.power.budgetKg - input.power.hardwareKg)
  const massRatio = Math.max(0, report.batteryKg - usableKg) / usableKg
  const unmetRatio = Math.max(0, report.unmetWh) / Math.max(1, input.power.loadW * 12)
  const normalizedViolation = slopeRatio + darkRatio + earthRatio + massRatio + unmetRatio + (report.complete ? 0 : 10)

  return {
    report,
    candidate: {
      site: input.site,
      node: input.node,
      pad: input.node + 1,
      start: input.start,
      mast: input.mast,
      coordinates: input.observer.coordinates,
      longestDark: report.longestDark,
      longestEarth: report.longestEarth,
      referenceLongestDark: report.referenceLongestDark,
      referenceLongestEarth: report.referenceLongestEarth,
      solarPct: totalHours > 0 ? (report.solarHours / totalHours) * 100 : 0,
      dsnHours: report.dsnHours,
      slope: report.slope,
      batteryKg: report.batteryKg,
      unmetWh: report.unmetWh,
      headroomKg: report.headroomKg,
      powerFeasible: report.feasible,
      geometryFeasible,
      feasible,
      complete: report.complete,
      coveredAzimuths: robustness.coveredAzimuths,
      displacementKm,
      scheduleShiftHours,
      absScheduleShiftHours: Math.abs(scheduleShiftHours),
      robustness,
      normalizedViolation,
    },
  }
}

export function evaluateCandidateWithSteps(input: {
  site: string
  node: number
  start: number
  mast: number
  observer: Observer
  vectors: Float64Array
  meta: Metadata
  limits: Limits
  power: Power
  baseline: { coordinates: [number, number, number]; start: number }
  preference: RobustnessPreference
  startStep: number
  steps: number
}): RecoveryCandidate {
  return evaluateCandidateReportWithSteps(input).candidate
}

export const DEFAULT_OBJECTIVE_WEIGHTS: Record<ObjectiveKey, number> = {
  longestDark: 1.0,
  longestEarth: 1.0,
  slope: 0.8,
  batteryKg: 1.0,
  displacementKm: 0.6,
  absScheduleShiftHours: 0.5,
  robustnessRank: 1.2,
}

function candidateVector(c: RecoveryCandidate): [number, number, number, number, number, number, number] {
  return [
    c.longestDark,
    c.longestEarth,
    c.slope ?? 90,
    c.batteryKg,
    c.displacementKm,
    c.absScheduleShiftHours,
    c.robustness.rank,
  ]
}

function dominates(a: RecoveryCandidate, b: RecoveryCandidate): boolean {
  const va = candidateVector(a)
  const vb = candidateVector(b)
  let strictlyBetter = false
  for (let i = 0; i < va.length; i++) {
    if (va[i] > vb[i] + 1e-6) return false
    if (va[i] < vb[i] - 1e-6) strictlyBetter = true
  }
  return strictlyBetter
}

export function extractParetoFrontier(candidates: RecoveryCandidate[]): RecoveryCandidate[] {
  const frontier: RecoveryCandidate[] = []
  for (let i = 0; i < candidates.length; i++) {
    let isDominated = false
    for (let j = 0; j < candidates.length; j++) {
      if (i !== j && dominates(candidates[j], candidates[i])) {
        isDominated = true
        break
      }
    }
    if (!isDominated) frontier.push(candidates[i])
  }
  return frontier
}

export function rankParetoRecoveryAlternatives(input: {
  evaluated: RecoveryCandidate[]
  sameSiteBest?: RecoveryCandidate | null
  nearMisses?: RecoveryCandidate[]
  weights?: Partial<Record<ObjectiveKey, number>>
}): ParetoSelectionResult {
  const weightsApplied: Record<ObjectiveKey, number> = {
    ...DEFAULT_OBJECTIVE_WEIGHTS,
    ...(input.weights ?? {}),
  }

  const feasible = input.evaluated.filter(c => c.feasible)
  const geometryOnlyPowerFail = input.evaluated
    .filter(c => c.geometryFeasible && !c.powerFeasible)
    .sort((a, b) => (a.normalizedViolation ?? 0) - (b.normalizedViolation ?? 0))

  const frontier = extractParetoFrontier(feasible)

  // Compute transparent min-max normalized weighted scalar score over feasible Pareto frontier.
  const keys: ObjectiveKey[] = [
    'longestDark',
    'longestEarth',
    'slope',
    'batteryKg',
    'displacementKm',
    'absScheduleShiftHours',
    'robustnessRank',
  ]

  const getObj = (c: RecoveryCandidate, k: ObjectiveKey): number => {
    if (k === 'slope') return c.slope ?? 90
    if (k === 'robustnessRank') return c.robustness.rank
    return c[k]
  }

  if (frontier.length > 0) {
    const mins: Record<string, number> = {}
    const maxs: Record<string, number> = {}
    for (const k of keys) {
      mins[k] = Math.min(...frontier.map(c => getObj(c, k)))
      maxs[k] = Math.max(...frontier.map(c => getObj(c, k)))
    }
    const weightSum = keys.reduce((acc, k) => acc + Math.max(0, weightsApplied[k]), 0) || 1
    for (const c of frontier) {
      let score = 0
      for (const k of keys) {
        const span = maxs[k] - mins[k]
        const norm = span > 1e-6 ? (getObj(c, k) - mins[k]) / span : 0
        score += (Math.max(0, weightsApplied[k]) / weightSum) * norm
      }
      c.weightedScore = score
      c.archetypes = []
    }

    const archetypeDefs: Array<{ label: string; key: ObjectiveKey }> = [
      { label: 'Lowest Darkness', key: 'longestDark' },
      { label: 'Lowest Earth Blackout', key: 'longestEarth' },
      { label: 'Flattest Slope', key: 'slope' },
      { label: 'Lowest Battery Mass', key: 'batteryKg' },
      { label: 'Minimum Relocation', key: 'displacementKm' },
      { label: 'Smallest Schedule Shift', key: 'absScheduleShiftHours' },
      { label: 'Most Robust Tested', key: 'robustnessRank' },
    ]
    for (const def of archetypeDefs) {
      const best = [...frontier].sort((a, b) => {
        const diff = getObj(a, def.key) - getObj(b, def.key)
        if (Math.abs(diff) > 1e-6) return diff
        return (a.weightedScore ?? 0) - (b.weightedScore ?? 0)
      })[0]
      if (best) {
        best.archetypes = [...(best.archetypes ?? []), def.label]
      }
    }

    frontier.sort((a, b) => {
      if (a.robustness.rank !== b.robustness.rank) return a.robustness.rank - b.robustness.rank
      const scoreDiff = (a.weightedScore ?? 0) - (b.weightedScore ?? 0)
      if (Math.abs(scoreDiff) > 1e-6) return scoreDiff
      return a.pad - b.pad || a.start - b.start
    })
  }

  const nearMissPool = [...(input.nearMisses ?? []), ...input.evaluated.filter(c => !c.feasible)]
  const seenNear = new Set<string>()
  const dedupedNear: RecoveryCandidate[] = []
  for (const c of nearMissPool) {
    const key = `${c.site}:${c.node}:${c.start}:${c.mast}`
    if (!seenNear.has(key)) {
      seenNear.add(key)
      dedupedNear.push(c)
    }
  }
  dedupedNear.sort((a, b) => (a.normalizedViolation ?? 999) - (b.normalizedViolation ?? 999))

  return {
    feasibleCount: feasible.length,
    totalEvaluatedCount: input.evaluated.length,
    paretoFrontier: frontier,
    recommended: frontier[0] ?? null,
    sameSiteBest: input.sameSiteBest ?? null,
    geometryOnlyPowerFail: geometryOnlyPowerFail.slice(0, 8),
    nearMisses: feasible.length === 0 ? dedupedNear.slice(0, 6) : [],
    weightsApplied,
  }
}

export function explainRecoveryDecision(input: {
  problem: MissionRecoveryProblem
  diff: CounterfactualDiff
  revisedCandidate: RecoveryCandidate
  selection: ParetoSelectionResult
}): RecoveryExplanation {
  const { problem, diff, revisedCandidate, selection } = input
  const mastMeters = resolveMastMeters(problem.revised.mast)
  const basePad = problem.baseline.node + 1
  const revPad = problem.revised.node + 1

  const headline = diff.revisedAllOk
    ? `Revised configuration (${problem.revised.site} pad ${revPad}, T+${problem.revised.start}h, ${mastMeters}m mast) satisfies all geometric and power limits.`
    : diff.statusCategory === 'geometry_only_power_fails'
      ? `Revised configuration passes terrain geometry but fails electrical energy/mass sizing.`
      : `Revised configuration (${problem.revised.site} pad ${revPad}, T+${problem.revised.start}h) fails ${diff.revisedViolations.length} constraint(s): ${diff.revisedViolations.join(', ')}.`

  const improvedText = diff.improvedConstraints.length
    ? `Improved: ${diff.improvedConstraints.join('; ')}.`
    : 'No constraint margins improved relative to baseline.'
  const deterioratedText = diff.deterioratedConstraints.length
    ? `Deteriorated: ${diff.deterioratedConstraints.join('; ')}.`
    : ''
  const unchangedText = diff.unchangedFailingConstraints.length
    ? `Still failing: ${diff.unchangedFailingConstraints.join('; ')}.`
    : ''
  const whatChanged = [improvedText, deterioratedText, unchangedText].filter(Boolean).join(' ')

  let samePadFinding = `Same-pad recovery scan around pad ${revPad} (from T+${problem.delayWindowHours.minStart}h to T+${problem.delayWindowHours.maxStart}h) was not evaluated.`
  if (selection.sameSiteBest) {
    const sp = selection.sameSiteBest
    if (sp.feasible) {
      samePadFinding = `Same-pad schedule recovery succeeds on pad ${sp.pad} at T+${sp.start}h (${sp.scheduleShiftHours >= 0 ? '+' : ''}${sp.scheduleShiftHours}h vs baseline): dark ${sp.longestDark.toFixed(2)}h, Earth ${sp.longestEarth.toFixed(2)}h, slope ${sp.slope?.toFixed(2) ?? 'n/a'} deg, battery ${sp.batteryKg.toFixed(1)} kg.`
    } else {
      samePadFinding = `No start in [${problem.delayWindowHours.minStart}h, ${problem.delayWindowHours.maxStart}h] satisfies all constraints at pad ${sp.pad}; closest same-pad option (T+${sp.start}h) has dark ${sp.longestDark.toFixed(2)}h, Earth ${sp.longestEarth.toFixed(2)}h, slope ${sp.slope?.toFixed(2) ?? 'n/a'} deg, battery ${sp.batteryKg.toFixed(1)} kg (unmet ${sp.unmetWh.toFixed(0)} Wh).`
    }
  }

  let alternativeFinding = ''
  let tradeoffNote = ''
  if (selection.recommended) {
    const rec = selection.recommended
    const darkDiff = rec.longestDark - revisedCandidate.longestDark
    const earthDiff = rec.longestEarth - revisedCandidate.longestEarth
    const battDiff = rec.batteryKg - revisedCandidate.batteryKg
    const slopeText = rec.slope !== null ? `${rec.slope.toFixed(2)} deg slope` : 'unknown slope'
    alternativeFinding = `Recommended Pareto alternative: ${rec.site} pad ${rec.pad} at T+${rec.start}h (${rec.displacementKm.toFixed(2)} km from baseline pad ${basePad}, schedule shift ${rec.scheduleShiftHours >= 0 ? '+' : ''}${rec.scheduleShiftHours}h) achieves ${rec.longestDark.toFixed(2)}h dark (${darkDiff >= 0 ? '+' : ''}${darkDiff.toFixed(2)}h), ${rec.longestEarth.toFixed(2)}h Earth (${earthDiff >= 0 ? '+' : ''}${earthDiff.toFixed(2)}h), ${slopeText}, and ${rec.batteryKg.toFixed(1)} kg battery (${battDiff >= 0 ? '+' : ''}${battDiff.toFixed(1)} kg, ${rec.headroomKg.toFixed(1)} kg headroom).`

    const frontierSummary = selection.paretoFrontier
      .slice(0, 5)
      .map(
        c =>
          `${c.site} pad ${c.pad}@T+${c.start}h [${c.archetypes?.length ? c.archetypes.join('/') : 'Pareto'}]: ${c.longestDark.toFixed(1)}h dark, ${c.longestEarth.toFixed(1)}h Earth, ${c.slope?.toFixed(2) ?? '?'} deg, ${c.batteryKg.toFixed(1)} kg, ${c.displacementKm.toFixed(1)} km`,
      )
      .join(' | ')
    tradeoffNote = `${selection.paretoFrontier.length} non-dominated option(s) among evaluated candidates, including ${selection.feasibleCount} passing candidate(s): ${frontierSummary}.`
  } else {
    const blockReasons = new Set<string>()
    if (selection.geometryOnlyPowerFail.length > 0) {
      blockReasons.add(`${selection.geometryOnlyPowerFail.length} geometry-passing pad/start pair(s) failed power/mass budget`)
    }
    if (!selection.nearMisses.length) {
      blockReasons.add('no candidate satisfied geometric/power constraints in scope')
    } else {
      const top = selection.nearMisses[0]
      blockReasons.add(
        `closest bounded near-miss is ${top.site} pad ${top.pad}@T+${top.start}h (INFEASIBLE: dark ${top.longestDark.toFixed(2)}h, Earth ${top.longestEarth.toFixed(2)}h, slope ${top.slope?.toFixed(2) ?? '?'} deg, battery ${top.batteryKg.toFixed(1)} kg, unmet ${top.unmetWh.toFixed(0)} Wh)`,
      )
    }
    alternativeFinding = `No passing alternative found in this search (${Array.from(blockReasons).join('; ')}). Additional unevaluated candidates may exist.`
    tradeoffNote = selection.nearMisses.length
      ? `Showing ${selection.nearMisses.length} closest infeasible near-miss(es) to show blocking margins; none are flyable without relaxing constraints or hardware sizing.`
      : 'Expand delay window, spatial scope, or array/mass sizing to identify feasible options.'
  }

  const sensitivityTarget = selection.recommended ?? revisedCandidate
  const sensitivityNote = `Robustness status (${problem.robustnessPreference}): ${sensitivityTarget.robustness.classification} — ${sensitivityTarget.robustness.summary}`

  return {
    headline,
    whatChanged,
    samePadFinding,
    alternativeFinding,
    tradeoffNote,
    sensitivityNote,
    notModeledNote:
      'Not modeled: sub-20 m terrain hazards/boulders, ~0.2-0.4 deg 20 m slope RMSE, regolith thermal transients, RF link margins/DSN scheduling, and subsurface PSR water ice.',
  }
}

export function buildDecisionCertificate(input: {
  problem: MissionRecoveryProblem
  validation: ProblemValidationResult
  sitesMeta: Record<string, Metadata>
  baselineReport: Report | null
  revisedReport: Report
  baselineCandidate: RecoveryCandidate | null
  revisedCandidate: RecoveryCandidate
  diff: CounterfactualDiff
  selection: ParetoSelectionResult
  explanation: RecoveryExplanation
  calculationVersion?: string
  searchCoverage?: MissionDecisionCertificate['searchCoverage']
}): MissionDecisionCertificate {
  const firstSiteMeta = Object.values(input.sitesMeta)[0]
  const sitesProvenance: MissionDecisionCertificate['scientificDataProvenance']['sites'] = {}
  for (const [siteId, meta] of Object.entries(input.sitesMeta)) {
    sitesProvenance[siteId] = {
      vectorHash: meta.vectorHash,
      localHash: meta.localHash,
      regionalSource: meta.regional?.source ?? null,
      radiusM: meta.regional?.radiusM ?? null,
      comparisonRadiusM: meta.regional?.comparisonRadiusM ?? null,
      frame: meta.frame,
      station: meta.station,
      kernels: meta.kernels,
    }
  }

  const totalHours = firstSiteMeta ? ((firstSiteMeta.count - 1) * firstSiteMeta.stepMinutes) / 60 : 720
  const calculationVersion = input.calculationVersion ?? 'umbra-x-recovery-v2.1-dss63'

  const corePayload = {
    schema: 'umbra-x.decision-certificate/v2',
    calculationVersion,
    generatedWithoutWallClockTimestamp: true as const,
    problem: input.problem,
    validation: input.validation,
    ...(input.searchCoverage ? { searchCoverage: input.searchCoverage } : {}),
    scientificDataProvenance: { sites: sitesProvenance },
    ephemerisCoverage: {
      startUtc: firstSiteMeta?.start ?? 'unknown',
      stepMinutes: firstSiteMeta?.stepMinutes ?? 5,
      count: firstSiteMeta?.count ?? 8641,
      totalHours,
      requestedWindowStartHours: input.problem.revised.start,
      requestedWindowHours: input.problem.days * 24,
    },
    terrainCoverage: {
      azimuthBins: 360,
      nominalRadiusKm: (firstSiteMeta?.regional?.radiusM ?? 96000) / 1000,
      comparisonRadiusKm: (firstSiteMeta?.regional?.comparisonRadiusM ?? 48000) / 1000,
      baselineComplete: input.baselineReport?.complete ?? input.revisedReport.complete,
      revisedComplete: input.revisedReport.complete,
    },
    modelAssumptions: {
      solarThreshold: 0.1,
      arrayMode: input.problem.power.arrayMode ?? 'tracked',
      nominalSigma: input.problem.power.sigma ?? 0,
      specificWh: input.problem.power.specificWh,
      hardwareKg: input.problem.power.hardwareKg,
      budgetKg: input.problem.power.budgetKg,
      limits: input.problem.limits,
    },
    counterfactualComparison: input.diff,
    sensitivityResults: {
      baseline: input.baselineCandidate?.robustness ?? null,
      revised: input.revisedCandidate.robustness,
      recommended: input.selection.recommended?.robustness ?? null,
    },
    samePadRecovery: input.selection.sameSiteBest,
    paretoAlternatives: input.selection.paretoFrontier,
    geometryOnlyPowerFailures: input.selection.geometryOnlyPowerFail,
    nearMisses: input.selection.nearMisses,
    knownLimitations: KNOWN_LIMITATIONS,
    causalConclusion: input.explanation,
  }

  return {
    ...corePayload,
    deterministicFingerprint: canonicalFingerprint(corePayload),
  }
}

export function collectPassingStartsByPad(input: {
  site: string
  meta: Metadata
  vectors: Float64Array
  days: number
  mast: number
  limits: Limits
  power: Power
  minStart: number
  maxStart: number
  getObserver: (node: number, mast: number) => Observer
  wasm?: {
    searchDual: (
      observer: Observer,
      vectors: Float64Array,
      steps: number,
      meta: Metadata,
      limits: Limits,
      sigma?: number,
    ) => number[]
    searchSiteDual?: (opts: {
      siteKey: string
      nodeCount: number
      mastM: number
      vectors: Float64Array
      steps: number
      meta: Metadata
      limits: Limits
      sigma?: number
      minStep: number
      maxStep: number
      getObserver: (node: number) => Observer
    }) => Map<number, number[]>
  } | null
  shouldCancel?: () => boolean
  onPadProgress?: (done: number, total: number) => void
}): {
  passingStartsByNode: Map<number, number[]>
  engine: 'Rust/WASM' | 'Optimized TS'
  cancelled: boolean
} {
  const stepHours = input.meta.stepMinutes / 60
  const steps = Math.round((input.days * 24) / stepHours)
  const sigma = input.power.sigma ?? 0
  const minStep = Math.ceil(input.minStart / stepHours)
  const maxStep = Math.floor(input.maxStart / stepHours)

  if (input.wasm?.searchSiteDual && input.meta.observers.length > 0) {
    if (input.shouldCancel?.()) {
      return { passingStartsByNode: new Map(), engine: 'Rust/WASM', cancelled: true }
    }
    const sampleObs = input.getObserver(0, input.mast)
    const passingStartsByNode = input.wasm.searchSiteDual({
      siteKey: `${input.site}:${input.mast}`,
      nodeCount: input.meta.observers.length,
      mastM: sampleObs.mast,
      vectors: input.vectors,
      steps,
      meta: input.meta,
      limits: input.limits,
      sigma,
      minStep,
      maxStep,
      getObserver: (node) => input.getObserver(node, input.mast),
    })
    input.onPadProgress?.(input.meta.observers.length, input.meta.observers.length)
    return { passingStartsByNode, engine: 'Rust/WASM', cancelled: false }
  }

  const passingStartsByNode = new Map<number, number[]>()
  let usedWasm = false

  for (let node = 0; node < input.meta.observers.length; node++) {
    if (input.shouldCancel?.()) {
      return { passingStartsByNode, engine: usedWasm ? 'Rust/WASM' : 'Optimized TS', cancelled: true }
    }
    const obs = input.getObserver(node, input.mast)
    if (obs.slope == null || obs.slope > input.limits.slope) continue
    const rawSteps = input.wasm
      ? (usedWasm = true, input.wasm.searchDual(obs, input.vectors, steps, input.meta, input.limits, sigma))
      : searchObserverDual(obs, input.vectors, steps, input.meta, input.limits, sigma)

    const filteredHours: number[] = []
    for (const s of rawSteps) {
      if (s >= minStep && s <= maxStep) {
        filteredHours.push(Math.round(s * stepHours))
      }
    }
    if (filteredHours.length > 0) {
      // Deduplicate hourly starts while preserving order.
      passingStartsByNode.set(node, Array.from(new Set(filteredHours)))
    }
    if (input.onPadProgress && (node % 120 === 0 || node === input.meta.observers.length - 1)) {
      input.onPadProgress(node + 1, input.meta.observers.length)
    }
  }
  return { passingStartsByNode, engine: usedWasm ? 'Rust/WASM' : 'Optimized TS', cancelled: false }
}
