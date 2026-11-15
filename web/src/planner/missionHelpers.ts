import { names } from './data'
import { classifyScenarioConfidence, combinePairConfidence } from './confidence'
import type { buildComparisonRecord } from './explain'
import { defaultPower } from './model'
import type { Limits, Metadata, Observer, Power, Report, Scenario } from './model'
import type { RecoveryRunSuccess } from './recoverySearch'
import type { RobustnessClassification } from './recovery'
import type { SiteData } from '../types/helios'

export type ComparisonRecord = ReturnType<typeof buildComparisonRecord>

export const ROLE_CARDS = [
  { id: 'Planner', num: '01', title: 'Planner', desc: 'Compare launch windows and search 2,883 candidate pads' },
  { id: 'Scientist', num: '02', title: 'Scientist', desc: 'Inspect 96 km LOLA horizons, DE440 kernels & terrain sensitivity' },
  { id: 'Educator', num: '03', title: 'Educator', desc: 'Guided Apollo 11 vs. South Pole predictions & solar array tests' },
  { id: 'Public', num: '04', title: 'Public', desc: 'Explore the 3D lunar sky, crater rims & Earth libration loops' },
] as const

export const VIEW_CARDS = [
  { id: 'orbit', code: 'V1', title: 'Orbit 3D', tag: '3D Terrain' },
  { id: 'pad', code: 'V2', title: 'From the pad', tag: 'Surface Eye' },
  { id: 'polar', code: 'V3', title: '360° Polar', tag: 'Polar Dome' },
  { id: 'chart', code: 'V4', title: '2D & chart', tag: '2D Profile' },
] as const

export const initial: [Scenario, Scenario] = [
  { site: 'shackleton-ridge', node: 480, start: 0, mast: 2 },
  { site: 'shackleton-ridge', node: 480, start: 48, mast: 2 },
]

export type TabId = 'Decision' | 'Co-Pilot' | 'Power & Cost' | 'Methods'

export type Result = {
  report: Report
  pad: Observer
  meta: Metadata
  terrain: SiteData | null
  mastSensitivity: { height: number; lowLight: number; earth: number; complete: boolean }[]
  liveTerrain?: boolean
  padViability?: Uint8Array
  padSolarPct?: Uint8Array
  padEarthPct?: Uint8Array
}

export type Choice = {
  scenario: Scenario
  slope: number
  starts: number
  earliestStart?: number
  nearestStart?: number
  targetStartMatch?: boolean
  longestDark?: number
  longestEarth?: number
  solarPct?: number
  dsnHours?: number
}

export type SearchResultState = {
  count: number
  options: Choice[]
  allOptions?: Choice[]
  targetStart?: number | null
  elapsedMs?: number
  engine?: string
  recovery?: RecoveryRunSuccess
}

export type Snapshot = {
  scenarios: [Scenario, Scenario]
  days: number
  limits: Limits
  power: Power
  rates: string[]
  equipment: number
  versions?: string[]
}

export const defaults: Snapshot = {
  scenarios: initial,
  days: 15,
  limits: { dark: 48, earth: 72, slope: 5 },
  power: defaultPower,
  rates: ['', '', ''],
  equipment: 0,
}

export type ChatChartSpec = {
  title: string
  subtitle?: string
  kind?: 'grouped_bar' | 'horizontal_bar' | 'mast_sweep'
  unit: string
  series: Array<{ label: string; baseline: number; alternative?: number; limit?: number; note?: string }>
}

export type ChatMessage = {
  id: string
  sender: 'user' | 'agent'
  text: string
  headline?: string
  actionsApplied?: string[]
  charts?: ChatChartSpec[]
  report?: { title?: string; summary?: string; recommendations?: string[] } | null
  facts?: Array<{ label: string; baseline: string; alternative: string }>
  citations?: Array<{ id: string; title: string; url: string }>
  certificate?: {
    fingerprint: string
    statusCategory?: string
    runSettings?: {
      scope?: string[]
      delayWindowHours?: { minStart: number; maxStart: number }
      robustnessPreference?: string
      maxFullEval?: number
      days?: number
      calculationVersion?: string
    }
  } | null
}

export function robustnessLabel(cls: RobustnessClassification): { label: string; className: string } {
  if (cls === 'passes_all_tested') return { label: 'Passes tested settings', className: 'badge-meets' }
  if (cls === 'nominal_only_sensitivity_fails') return { label: 'Nominal Only · Sensitivity Fails', className: 'badge-warn' }
  if (cls === 'unassessed_missing_data') return { label: 'Unassessed · Missing Data', className: 'badge-muted' }
  return { label: 'Fails Constraints', className: 'badge-exceeds' }
}

export function validScenario(s: Scenario, days: number) {
  if (
    !s ||
    !Object.hasOwn(names, s.site) ||
    ![s.node, s.start, s.mast].every(Number.isInteger) ||
    s.node < 0 ||
    s.node > 960 ||
    s.mast < 0 ||
    s.mast > 4 ||
    s.start < 0 ||
    s.start > 720 - 24 * days
  ) {
    return false
  }
  if (s.customLat !== undefined && (!Number.isFinite(s.customLat) || Math.abs(s.customLat) > 90)) return false
  if (s.customLon !== undefined && (!Number.isFinite(s.customLon) || Math.abs(s.customLon) > 360)) return false
  return true
}

export function restore(): Snapshot {
  try {
    const encoded = new URLSearchParams(location.search).get('comparison')
    if (!encoded) {
      return new URLSearchParams(location.search).get('replay') === 'nearby'
        ? { ...defaults, scenarios: [initial[1], delayedAlternative] }
        : defaults
    }
    const x = JSON.parse(encoded)
    if (x.schema !== 1 || !Number.isInteger(x.days) || x.days < 1 || x.days > 15 || x.scenarios?.length !== 2) {
      return defaults
    }
    for (const s of x.scenarios) {
      if (!validScenario(s, x.days)) return defaults
    }
    const numKeys = ['arrayW', 'loadW', 'specificWh', 'hardwareKg', 'budgetKg'] as const
    if (
      !x.power ||
      !numKeys.every(k => Number.isFinite(x.power[k]) && x.power[k] >= 0) ||
      x.power.specificWh <= 0 ||
      (x.power.arrayMode !== undefined && !['tracked', 'vertical', 'horizontal'].includes(x.power.arrayMode)) ||
      (x.power.sigma !== undefined && (!Number.isFinite(x.power.sigma) || x.power.sigma < 0 || x.power.sigma > 5)) ||
      !x.limits ||
      !Object.keys(defaults.limits).every(k => Number.isFinite(x.limits[k]) && x.limits[k] >= 0) ||
      !Number.isFinite(x.equipment) ||
      !Array.isArray(x.rates) ||
      x.rates.length !== 3 ||
      !x.rates.every((r: unknown) => typeof r === 'string' && (r === '' || (Number.isFinite(Number(r)) && Number(r) >= 0)))
    ) {
      return defaults
    }
    if (
      x.versions !== undefined &&
      (!Array.isArray(x.versions) || x.versions.length !== 2 || !x.versions.every((v: unknown) => typeof v === 'string'))
    ) {
      return defaults
    }
    return {
      ...x,
      power: {
        ...x.power,
        arrayMode: x.power.arrayMode ?? 'tracked',
        sigma: x.power.sigma ?? 0,
      },
    }
  } catch {
    return defaults
  }
}

export const name = (id: string) => names[id] ?? id
export const n = (value: number, digits = 1) => value.toFixed(digits)
export const sign = (value: number) => (value >= 0 ? '+' : '') + n(value)
export const money = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 })
export const utc = (epochIso: string, hours: number) =>
  new Date(Date.parse(epochIso) + hours * 3600000).toISOString().slice(0, 16).replace('T', ' ') + ' UTC'
export const epoch = '2026-11-14T00:00:00Z'
export const delayedAlternative: Scenario = { ...initial[1], node: 478 }

export const fingerprint = (x: Result) => [x.meta.vectorHash, x.meta.localHash, x.meta.regional?.regional ?? 'local'].join(':')

export function coveredCount(coverage: Uint8Array) {
  let count = 0
  for (let i = 0; i < coverage.length; i++) {
    if (coverage[i]) count++
  }
  return count
}

export function download(filename: string, value: string, type: string) {
  const url = URL.createObjectURL(new Blob([value], { type }))
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

export function buildConfidencePair(
  items: {
    report: {
      complete: boolean
      longestDark: number
      referenceLongestDark: number
      longestEarth: number
      referenceLongestEarth: number
      feasible: boolean
      unmetWh: number
      headroomKg: number
    }
    pad: { coverage?: Uint8Array | number[] | null; slope: number | null }
    meta: { regional?: unknown }
    terrain?: unknown
    liveTerrain?: unknown
  }[],
  sigma: number,
  limits: { slope: number; dark: number; earth: number },
) {
  const reports = items.map(item => {
    const cov = item.pad.coverage
    let covered = 360
    if (cov) {
      covered = 0
      for (let k = 0; k < cov.length; k += 1) if (cov[k]) covered += 1
    }
    return classifyScenarioConfidence({
      complete: item.report.complete,
      coveredAzimuths: covered,
      hasRegionalTerrain: Boolean((item.terrain || item.liveTerrain) && item.meta.regional),
      is80mLive: Boolean(item.liveTerrain),
      slope: item.pad.slope,
      slopeLimit: limits.slope,
      longestDark: item.report.longestDark,
      referenceLongestDark: item.report.referenceLongestDark,
      darkLimit: limits.dark,
      longestEarth: item.report.longestEarth,
      referenceLongestEarth: item.report.referenceLongestEarth,
      earthLimit: limits.earth,
      feasible: item.report.feasible,
      unmetWh: item.report.unmetWh,
      headroomKg: item.report.headroomKg,
      sigma,
    })
  })
  return {
    baseline: reports[0],
    alternative: reports[1],
    overall: combinePairConfidence(reports[0], reports[1]),
  }
}

export function requirement(value: number | null, max: number, covered = true, reference?: number) {
  return value === null || !covered
    ? 'Insufficient evidence'
    : reference !== undefined && (value <= max) !== (reference <= max)
      ? 'Sensitive to terrain extent'
      : value <= max
        ? 'Meets'
        : 'Exceeds'
}

export function statusClass(label: string) {
  if (label === 'Meets') return 'badge-meets'
  if (label === 'Exceeds') return 'badge-exceeds'
  if (label === 'Sensitive to terrain extent') return 'badge-warn'
  return 'badge-muted'
}

export function webglAvailable() {
  if (new URLSearchParams(location.search).get('view') === '2d') return false
  try {
    const context = document.createElement('canvas').getContext('webgl2')
    context?.getExtension('WEBGL_lose_context')?.loseContext()
    return Boolean(context)
  } catch {
    return false
  }
}

export function azTrackSegments(
  sky: Report['sky'],
  pick: (s: Report['sky'][number]) => { az: number; el: number },
  xOf: (az: number) => number,
  yOf: (el: number) => number,
) {
  const segments: string[] = []
  let current: string[] = []
  let prevAz: number | null = null
  for (let i = 0; i < sky.length; i += 6) {
    const pt = pick(sky[i])
    if (prevAz !== null && Math.abs(pt.az - prevAz) > 180) {
      if (current.length > 1) segments.push(current.join(' '))
      current = []
    }
    current.push(`${xOf(pt.az).toFixed(1)},${yOf(pt.el).toFixed(1)}`)
    prevAz = pt.az
  }
  const last = pick(sky[sky.length - 1])
  if (prevAz !== null && Math.abs(last.az - prevAz) <= 180) {
    current.push(`${xOf(last.az).toFixed(1)},${yOf(last.el).toFixed(1)}`)
  }
  if (current.length > 1) segments.push(current.join(' '))
  return segments
}
