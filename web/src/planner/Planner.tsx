import { Fragment, lazy, Suspense, useEffect, useMemo, useRef, useState } from 'react'
import {
  ArrowLeftRight,
  ArrowRight,
  ArrowUpRight,
  ChevronDown,
  ChevronUp,
  Compass,
  Download,
  Globe2,
  Layers,
  Pause,
  Play,
  Search,
  Share2,
  SlidersHorizontal,
  Sparkles,
} from 'lucide-react'
import type { SiteData } from '../types/helios'
import { AskStudy } from './AskStudy'
import { findNearestPolarPad, names, padPixel, polarSites, referenceSites } from './data'
import { answerScenarioQuestion, buildComparisonRecord, QUICK_QUESTIONS, summarizeComparison } from './explain'
import type { IntroFocus } from './IntroScene'
import { complementaryPower, costTradeoff, countdown, defaultPower, solarThreshold } from './model'
import type { ArrayMode, Limits, Metadata, Observer, Power, Report, Scenario } from './model'
import type { Request } from './planner.worker'
import type { TerrainOverlay } from './SkyScene'
import './planner.css'

const Scene = lazy(() => import('./SkyScene'))
const IntroScene = lazy(() => import('./IntroScene'))
const ROLE_CARDS = [
  { id: 'Planner', num: '01', title: 'Planner', desc: 'Compare launch windows and search 2,883 candidate pads' },
  { id: 'Scientist', num: '02', title: 'Scientist', desc: 'Inspect 96 km LOLA horizons, DE440 kernels & terrain sensitivity' },
  { id: 'Educator', num: '03', title: 'Educator', desc: 'Guided Apollo 11 vs. South Pole predictions & solar array tests' },
  { id: 'Public', num: '04', title: 'Public', desc: 'Explore the 3D lunar sky, crater rims & Earth libration loops' },
] as const
const VIEW_CARDS = [
  { id: 'orbit', code: 'V1', title: 'Orbit 3D', tag: '3D Terrain' },
  { id: 'pad', code: 'V2', title: 'From the pad', tag: 'Surface Eye' },
  { id: 'polar', code: 'V3', title: '360° Polar', tag: 'Polar Dome' },
  { id: 'chart', code: 'V4', title: '2D & chart', tag: '2D Profile' },
] as const
const initial: [Scenario, Scenario] = [
  { site: 'shackleton-ridge', node: 480, start: 0, mast: 2 },
  { site: 'shackleton-ridge', node: 480, start: 48, mast: 2 },
]
type TabId = 'Decision' | 'Co-Pilot' | 'Power & Cost' | 'Methods'
type Result = {
  report: Report
  pad: Observer
  meta: Metadata
  terrain: SiteData | null
  mastSensitivity: { height: number; lowLight: number; earth: number; complete: boolean }[]
  liveTerrain?: boolean
  padViability?: Uint8Array
  padSolarPct?: Uint8Array
}
type Choice = {
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
type SearchResultState = {
  count: number
  options: Choice[]
  allOptions?: Choice[]
  targetStart?: number | null
  elapsedMs?: number
  engine?: string
}
type Snapshot = {
  scenarios: [Scenario, Scenario]
  days: number
  limits: Limits
  power: Power
  rates: string[]
  equipment: number
  versions?: string[]
}
const defaults: Snapshot = {
  scenarios: initial,
  days: 15,
  limits: { dark: 48, earth: 72, slope: 5 },
  power: defaultPower,
  rates: ['', '', ''],
  equipment: 0,
}

function validScenario(s: Scenario, days: number) {
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

function restore(): Snapshot {
  try {
    const encoded = new URLSearchParams(location.search).get('comparison')
    if (!encoded) return defaults
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

const name = (id: string) => names[id] ?? id
const n = (value: number, digits = 1) => value.toFixed(digits)
const sign = (value: number) => (value >= 0 ? '+' : '') + n(value)
const money = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 })
const utc = (epochIso: string, hours: number) =>
  new Date(Date.parse(epochIso) + hours * 3600000).toISOString().slice(0, 16).replace('T', ' ') + ' UTC'
const epoch = '2026-11-14T00:00:00Z'
const delayedAlternative: Scenario = { ...initial[1], node: 180 }

type ReleaseEvidence = {
  cases: { id: string; title: string; query: string; expected: {
    lowLightHours: number; earthObstructionHours: number; requiredBatteryKg: number
  }[] }[]
  changes: { site: string; eligible: number; lost: number; gained: number }[]
}

function ReleaseCases() {
  const [evidence, setEvidence] = useState<ReleaseEvidence | null>(null)
  const [failed, setFailed] = useState(false)
  useEffect(() => {
    let cancelled = false
    fetch(import.meta.env.BASE_URL + 'release-evidence.json')
      .then(response => { if (!response.ok) throw new Error('Evidence unavailable'); return response.json() })
      .then(data => { if (!cancelled) setEvidence(data) })
      .catch(() => { if (!cancelled) setFailed(true) })
    return () => { cancelled = true }
  }, [])
  return <section className="release-cases" aria-label="Release evidence">
    <h2>Reproduce a decision</h2>
    {failed && <p>Release evidence is unavailable.</p>}
    {evidence && <>
      <ul>{evidence.cases.map(({ id, title, query, expected }) =>
        <li key={id}><a href={query}>{title}</a><span>
          Earth obstruction {n(expected[0].earthObstructionHours)} to {n(expected[1].earthObstructionHours)} h
          {' · '}Battery {n(expected[0].requiredBatteryKg)} to {n(expected[1].requiredBatteryKg)} kg
        </span></li>)}</ul>
      <p>{evidence.changes.reduce((total, site) => total + site.lost, 0)} previously eligible pad/start pairs fail after adding regional terrain samples near tile edges.</p>
      <div className="experiment-actions">
        <a href={import.meta.env.BASE_URL + 'release-evidence.json'}>Inputs, results and dataset hashes</a>
        <a href={import.meta.env.BASE_URL + 'release-timing.json'}>Five-minute vs. one-minute event checks</a>
      </div>
    </>}
  </section>
}
const fingerprint = (x: Result) => [x.meta.vectorHash, x.meta.localHash, x.meta.regional?.regional ?? 'local'].join(':')

function coveredCount(coverage: Uint8Array) {
  let count = 0
  for (let i = 0; i < coverage.length; i++) {
    if (coverage[i]) count++
  }
  return count
}

function download(filename: string, value: string, type: string) {
  const url = URL.createObjectURL(new Blob([value], { type }))
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

function requirement(value: number | null, max: number, covered = true, reference?: number) {
  return value === null || !covered
    ? 'Insufficient evidence'
    : reference !== undefined && (value <= max) !== (reference <= max)
      ? 'Sensitive to terrain extent'
      : value <= max
        ? 'Meets'
        : 'Exceeds'
}

function statusClass(label: string) {
  if (label === 'Meets') return 'badge-meets'
  if (label === 'Exceeds') return 'badge-exceeds'
  if (label === 'Sensitive to terrain extent') return 'badge-warn'
  return 'badge-muted'
}

function NumberField({
  label,
  value,
  onChange,
  min = 0,
  max = 10000000,
  step = 1,
}: {
  label: string
  value: number
  onChange: (v: number) => void
  min?: number
  max?: number
  step?: number
}) {
  return (
    <label>
      {label}
      <input
        type="number"
        value={value}
        min={min}
        max={max}
        step={step}
        onChange={e => {
          const v = e.target.valueAsNumber
          if (Number.isFinite(v)) onChange(Math.min(max, Math.max(min, v)))
        }}
      />
    </label>
  )
}

function webglAvailable() {
  if (new URLSearchParams(location.search).get('view') === '2d') return false
  try {
    const context = document.createElement('canvas').getContext('webgl2')
    context?.getExtension('WEBGL_lose_context')?.loseContext()
    return Boolean(context)
  } catch {
    return false
  }
}

function azTrackSegments(
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

function Horizon({
  items,
  active,
  index,
  compareOverlay,
  sigma,
  hoverAz,
  onHoverAz,
}: {
  items: Result[]
  active: number
  index: number
  compareOverlay: boolean
  sigma: number
  hoverAz: number | null
  onHoverAz: (az: number | null) => void
}) {
  const primary = items[active]
  const other = items[1 - active]
  const sky = primary.report.sky[index]
  const otherSky = other?.report.sky[index]
  const showAlt = compareOverlay && Boolean(other && otherSky)
  const hasRegional = Boolean((primary.terrain || primary.liveTerrain) && primary.meta.regional)
  const horizons = [...primary.pad.horizon]
  if (hasRegional) horizons.push(...primary.pad.reference)
  if (showAlt) horizons.push(...other.pad.horizon)
  const elevations = [sky.sun.el, sky.earth.el]
  if (showAlt && otherSky) elevations.push(otherSky.sun.el, otherSky.earth.el)
  const low = Math.min(-8, ...elevations.map(v => v - 2), ...horizons)
  const high = Math.max(8, ...elevations.map(v => v + 2), ...horizons)
  const x = (az: number) => 44 + az * 1.44
  const y = (el: number) => 162 - (136 * (el - low)) / Math.max(1e-3, high - low)
  const yTicks = [-10, -5, 0, 5, 10, 15, 20].filter(v => v > low + 1 && v < high - 1)

  const linePts = Array.from({ length: 361 }, (_, i) => `${x(i).toFixed(1)},${y(primary.pad.horizon[i % 360]).toFixed(1)}`)
  const fillPts = [`44,${y(low).toFixed(1)}`, ...linePts, `562.4,${y(low).toFixed(1)}`].join(' ')
  const refLine = hasRegional
    ? Array.from({ length: 361 }, (_, i) => `${x(i).toFixed(1)},${y(primary.pad.reference[i % 360]).toFixed(1)}`).join(' ')
    : null
  const sigmaPolygon =
    sigma > 0 && primary.terrain && primary.pad.horizonError
      ? [
          ...Array.from({ length: 361 }, (_, i) => {
            const idx = i % 360
            return `${x(i).toFixed(1)},${y(primary.pad.horizon[idx] + sigma * primary.pad.horizonError![idx]).toFixed(1)}`
          }),
          ...Array.from({ length: 361 }, (_, k) => {
            const i = 360 - k
            const idx = i % 360
            return `${x(i).toFixed(1)},${y(primary.pad.horizon[idx] - sigma * primary.pad.horizonError![idx]).toFixed(1)}`
          }),
        ].join(' ')
      : null
  const altLine = showAlt
    ? Array.from({ length: 361 }, (_, i) => `${x(i).toFixed(1)},${y(other.pad.horizon[i % 360]).toFixed(1)}`).join(' ')
    : null
  const sunTracks = azTrackSegments(primary.report.sky, s => s.sun, x, y)
  const earthTracks = azTrackSegments(primary.report.sky, s => s.earth, x, y)

  const gapBands: { start: number; end: number }[] = []
  let gStart = -1
  for (let i = 0; i <= 360; i++) {
    const unc = i < 360 && !primary.pad.coverage[i]
    if (unc && gStart < 0) gStart = i
    if (!unc && gStart >= 0) {
      gapBands.push({ start: gStart, end: i })
      gStart = -1
    }
  }

  return (
    <svg
      viewBox="0 0 596 204"
      role="img"
      aria-label="Sun and Earth positions and trajectories against terrain elevation by azimuth"
      onMouseMove={e => {
        const rect = e.currentTarget.getBoundingClientRect()
        const svgX = ((e.clientX - rect.left) / rect.width) * 596
        if (svgX >= 44 && svgX <= 562.4) {
          onHoverAz(Math.round(((svgX - 44) / 518.4) * 360) % 360)
        }
      }}
      onMouseLeave={() => onHoverAz(null)}
    >
      <rect x="44" y="16" width="518.4" height="148" fill="#080a0f" stroke="rgba(236,235,230,0.18)" strokeWidth="0.75" />
      {gapBands.map(b => (
        <rect
          key={`gap-${b.start}`}
          x={x(b.start)}
          y={16}
          width={Math.max(1.5, x(b.end) - x(b.start))}
          height={148}
          fill="#fbbf24"
          opacity="0.14"
        />
      ))}
      {yTicks.map(t => (
        <g key={`yt-${t}`}>
          <line
            x1="44"
            x2="562.4"
            y1={y(t)}
            y2={y(t)}
            stroke={t === 0 ? 'rgba(236,235,230,0.42)' : 'rgba(236,235,230,0.11)'}
            strokeDasharray={t === 0 ? '4 4' : '2 4'}
            strokeWidth={t === 0 ? '0.95' : '0.65'}
          />
          <text x="38" y={y(t) + 3.5} textAnchor="end" fill="#8e949f" fontSize="9">
            {t}°
          </text>
        </g>
      ))}
      {[0, 90, 180, 270, 360].map(az => (
        <line key={`az-${az}`} x1={x(az)} x2={x(az)} y1="16" y2="164" stroke="rgba(236,235,230,0.08)" strokeWidth="0.65" />
      ))}
      <text x="38" y={22} textAnchor="end" fill="#686e78" fontSize="8.5">{n(high, 0)}°</text>
      <text x="38" y={162} textAnchor="end" fill="#686e78" fontSize="8.5">{n(low, 0)}°</text>
      <polygon points={fillPts} fill="#161920" opacity="0.92" />
      {sigmaPolygon && <polygon points={sigmaPolygon} fill="#ffc36d" opacity="0.18" />}
      {refLine && <polyline points={refLine} fill="none" stroke="#8e949f" strokeWidth="1.05" strokeDasharray="2 3" />}
      {altLine && <polyline points={altLine} fill="none" stroke="#8ec9ff" strokeWidth="1.2" strokeDasharray="5 3" opacity="0.85" />}
      <polyline points={linePts.join(' ')} fill="none" stroke="#ecebe6" strokeWidth="1.65" />
      {sunTracks.map((pts, i) => (
        <polyline key={'st' + i} points={pts} fill="none" stroke="#ffc36d" strokeWidth="1.2" opacity="0.52" />
      ))}
      {earthTracks.map((pts, i) => (
        <polyline key={'et' + i} points={pts} fill="none" stroke="#8ec9ff" strokeWidth="1.2" opacity="0.52" />
      ))}
      {showAlt &&
        otherSky &&
        [
          ['Alt Sun', otherSky.sun, '#ffc36d'],
          ['Alt Earth', otherSky.earth, '#8ec9ff'],
        ].map(([label, p, color]) => {
          const body = p as typeof sky.sun
          return (
            <g key={String(label)} fill="none" stroke={String(color)} strokeWidth="1.4">
              <circle cx={x(body.az)} cy={y(body.el)} r="3.8" />
              <text x={x(body.az)} y={y(body.el) + 13} textAnchor="middle" fill={String(color)} stroke="#080a0f" strokeWidth="2.5" paintOrder="stroke" fontSize="9">
                {String(label)}
              </text>
            </g>
          )
        })}
      {[
        ['Sun', sky.sun, '#ffc36d'],
        ['Earth', sky.earth, '#8ec9ff'],
      ].map(([label, p, color]) => {
        const body = p as typeof sky.sun
        return (
          <g key={String(label)} fill={String(color)}>
            <circle cx={x(body.az)} cy={y(body.el)} r="4.5" stroke="#080a0f" strokeWidth="1.5" />
            <text x={x(body.az)} y={y(body.el) - 9} textAnchor="middle" fill={String(color)} stroke="#080a0f" strokeWidth="3" paintOrder="stroke" fontSize="9.5" fontWeight="600">
              {String(label)}
            </text>
          </g>
        )
      })}
      {hoverAz !== null && (
        <g pointerEvents="none">
          <line x1={x(hoverAz)} x2={x(hoverAz)} y1="16" y2="164" stroke="#ffc36d" strokeWidth="1" strokeDasharray="3 3" opacity="0.85" />
          <text x={Math.min(524, Math.max(76, x(hoverAz)))} y="28" textAnchor="middle" fill="#ffc36d" fontSize="9" fontWeight="600">
            {hoverAz}° · Rim {n(primary.pad.horizon[hoverAz % 360], 1)}°
          </text>
        </g>
      )}
      {['N 000°', 'E 090°', 'S 180°', 'W 270°', 'N 360°'].map((label, i) => (
        <text key={i} x={44 + i * 129.6} y="182" textAnchor="middle" fill="#c5c8ce" fontSize="9.5" fontWeight="500">
          {label}
        </text>
      ))}
    </svg>
  )
}

function PolarSky({
  items,
  active,
  index,
  compareOverlay,
  sigma,
  hoverAz,
  onHoverAz,
}: {
  items: Result[]
  active: number
  index: number
  compareOverlay: boolean
  sigma: number
  hoverAz: number | null
  onHoverAz: (az: number | null) => void
}) {
  const primary = items[active]
  const other = items[1 - active]
  const sky = primary.report.sky[index]
  const otherSky = other?.report.sky[index]
  const showAlt = compareOverlay && Boolean(other && otherSky)
  const hasRegional = Boolean((primary.terrain || primary.liveTerrain) && primary.meta.regional)
  const vals = [
    ...primary.pad.horizon.map(Math.abs),
    ...primary.report.sky.map(s => Math.abs(s.sun.el)),
    ...primary.report.sky.map(s => Math.abs(s.earth.el)),
  ]
  if (showAlt) vals.push(...other.pad.horizon.map(Math.abs))
  const span = Math.min(90, Math.max(15, ...vals))
  const cx = 168
  const cy = 160
  const r0 = 94
  const scale = 36
  const pt = (az: number, el: number): [number, number] => {
    const r = r0 - scale * Math.max(-1, Math.min(1, el / span))
    const a = (az * Math.PI) / 180
    return [cx + r * Math.sin(a), cy - r * Math.cos(a)]
  }
  const poly = (arr: Float32Array, add = 0) =>
    Array.from({ length: 361 }, (_, i) => {
      const idx = i % 360
      return pt(idx, arr[idx] + add).map(v => v.toFixed(1)).join(',')
    }).join(' ')
  const track = (sArr: Report['sky'], pick: (s: Report['sky'][number]) => { az: number; el: number }) =>
    sArr
      .filter((_, i) => i % 6 === 0 || i === sArr.length - 1)
      .map(s => {
        const d = pick(s)
        return pt(d.az, d.el).map(v => v.toFixed(1)).join(',')
      })
      .join(' ')
  const [sx, sy] = pt(sky.sun.az, sky.sun.el)
  const [ex, ey] = pt(sky.earth.az, sky.earth.el)
  const [dx, dy] = pt(sky.station.az, sky.station.el)
  const uncoveredCount = 360 - coveredCount(primary.pad.coverage)
  const inspectAz = hoverAz ?? Math.round(sky.sun.az) % 360
  const inspectRim = primary.pad.horizon[inspectAz % 360]
  const [hx, hy] = pt(inspectAz, inspectRim)

  return (
    <div className="polar-wrap">
      <svg
        viewBox="0 0 336 320"
        role="img"
        aria-label="360-degree polar sky dome showing Sun and Earth tracks relative to terrain horizon"
        onMouseMove={e => {
          const rect = e.currentTarget.getBoundingClientRect()
          const sx = ((e.clientX - rect.left) / rect.width) * 336
          const sy = ((e.clientY - rect.top) / rect.height) * 320
          const deg = (Math.atan2(sx - cx, -(sy - cy)) * 180) / Math.PI
          onHoverAz((Math.round(deg) + 360) % 360)
        }}
        onMouseLeave={() => onHoverAz(null)}
      >
        <circle cx={cx} cy={cy} r={r0 + scale} fill="#080a0f" stroke="rgba(236,235,230,0.22)" strokeWidth="0.75" />
        {[r0 - scale, r0 - scale / 2, r0, r0 + scale].map((r, idx) => (
          <circle
            key={idx}
            cx={cx}
            cy={cy}
            r={r}
            fill="none"
            stroke={r === r0 ? 'rgba(236,235,230,0.52)' : 'rgba(236,235,230,0.14)'}
            strokeWidth={r === r0 ? '1.15' : '0.75'}
            strokeDasharray={r === r0 ? undefined : '2.5 3.5'}
          />
        ))}
        <path d={`M${cx} ${cy - r0 - scale}V${cy + r0 + scale} M${cx - r0 - scale} ${cy}H${cx + r0 + scale}`} stroke="rgba(236,235,230,0.12)" strokeDasharray="2.5 3.5" />
        {[
          ['N 000°', cx, cy - r0 - scale - 8],
          ['E 090°', cx + r0 + scale + 18, cy + 3.5],
          ['S 180°', cx, cy + r0 + scale + 14],
          ['W 270°', cx - r0 - scale - 18, cy + 3.5],
        ].map(([label, tx, ty]) => (
          <text key={String(label)} x={tx} y={ty} textAnchor="middle" fill="#ecebe6" fontSize="9.5" fontWeight="600">
            {label}
          </text>
        ))}
        {hasRegional && <polyline points={poly(primary.pad.reference)} fill="none" stroke="#8e949f" strokeWidth="1" strokeDasharray="2 3" />}
        {sigma > 0 && primary.terrain && primary.pad.horizonError && (
          <polyline
            points={Array.from({ length: 361 }, (_, i) => {
              const idx = i % 360
              return pt(idx, primary.pad.horizon[idx] + sigma * primary.pad.horizonError![idx])
                .map(v => v.toFixed(1))
                .join(',')
            }).join(' ')}
            fill="none"
            stroke="#ffc36d"
            strokeWidth="1.1"
            strokeDasharray="2 2"
            opacity="0.8"
          />
        )}
        {showAlt && <polyline points={poly(other.pad.horizon)} fill="none" stroke="#8ec9ff" strokeWidth="1.25" strokeDasharray="5 3" opacity="0.85" />}
        <polyline points={poly(primary.pad.horizon)} fill="#15181e" fillOpacity="0.65" stroke="#ecebe6" strokeWidth="1.75" />
        <polyline points={track(primary.report.sky, s => s.sun)} fill="none" stroke="#ffc36d" strokeWidth="1.35" opacity="0.72" />
        <polyline points={track(primary.report.sky, s => s.earth)} fill="none" stroke="#8ec9ff" strokeWidth="1.35" opacity="0.75" />
        {showAlt && (
          <>
            <polyline points={track(other.report.sky, s => s.sun)} fill="none" stroke="#ffc36d" strokeWidth="1" strokeDasharray="2 3" opacity="0.55" />
            <polyline points={track(other.report.sky, s => s.earth)} fill="none" stroke="#8ec9ff" strokeWidth="1" strokeDasharray="2 3" opacity="0.6" />
          </>
        )}
        <circle cx={dx} cy={dy} r="3.2" fill={sky.stationAccess ? '#34d399' : '#686e78'} />
        <circle cx={sx} cy={sy} r="5" fill="#ffc36d" stroke="#080a0f" strokeWidth="1.6" />
        <circle cx={ex} cy={ey} r="4.5" fill="#8ec9ff" stroke="#080a0f" strokeWidth="1.6" />
        <text x={sx + 8} y={sy - 6} fill="#ffc36d" stroke="#080a0f" strokeWidth="2.8" paintOrder="stroke" fontSize="10.5" fontWeight="600">Sun</text>
        <text x={ex + 8} y={ey + 12} fill="#8ec9ff" stroke="#080a0f" strokeWidth="2.8" paintOrder="stroke" fontSize="10.5" fontWeight="600">Earth</text>
        {showAlt && otherSky && (
          <>
            <circle cx={pt(otherSky.sun.az, otherSky.sun.el)[0]} cy={pt(otherSky.sun.az, otherSky.sun.el)[1]} r="4" fill="none" stroke="#ffc36d" strokeWidth="1.4" />
            <circle cx={pt(otherSky.earth.az, otherSky.earth.el)[0]} cy={pt(otherSky.earth.az, otherSky.earth.el)[1]} r="4" fill="none" stroke="#8ec9ff" strokeWidth="1.4" />
          </>
        )}
        {hoverAz !== null && (
          <g pointerEvents="none">
            <line
              x1={cx}
              y1={cy}
              x2={cx + (r0 + scale) * Math.sin((inspectAz * Math.PI) / 180)}
              y2={cy - (r0 + scale) * Math.cos((inspectAz * Math.PI) / 180)}
              stroke="#ffc36d"
              strokeWidth="0.9"
              strokeDasharray="3 3"
              opacity="0.75"
            />
            <circle cx={hx} cy={hy} r="3.4" fill="#ffc36d" />
          </g>
        )}
      </svg>
      <div className="polar-legend">
        <strong>360° Polar Sky Dome</strong>
        <div className="polar-readout">
          <span>{hoverAz !== null ? 'Cursor Azimuth' : 'Solar Azimuth'}</span>
          <strong>{String(inspectAz).padStart(3, '0')}° · Rim {sign(inspectRim)}°</strong>
        </div>
        <p>Solid ring marks 0° level horizon; center is +{n(span, 0)}° zenith; outer ring is −{n(span, 0)}°.</p>
        <ul>
          <li><i style={{ background: '#ecebe6' }} /> Active terrain skyline (96 km LOLA)</li>
          {hasRegional && <li><i style={{ background: '#8e949f' }} /> 48 km terrain sensitivity</li>}
          {showAlt && <li><i style={{ background: '#8ec9ff' }} /> Alternative scenario skyline &amp; bodies</li>}
          <li><i style={{ background: '#ffc36d' }} /> Sun path &amp; position ({sign(sky.sun.el)}°)</li>
          <li><i style={{ background: '#60a5fa' }} /> Earth libration loop ({sign(sky.earth.el)}°)</li>
          <li><i style={{ background: '#34d399' }} /> Goldstone DSS-14 line of sight</li>
          {uncoveredCount > 0 && <li><i style={{ background: '#fbbf24' }} /> {uncoveredCount} azimuths clipped by 80°S edge</li>}
        </ul>
      </div>
    </div>
  )
}

function LunarLocator({ coordinates }: { coordinates: Observer['coordinates'] }) {
  const [lat, lon] = coordinates
  const phi = (lat * Math.PI) / 180
  const lambda = (lon * Math.PI) / 180
  return (
    <svg className="lunar-locator" viewBox="0 0 76 92" role="img" aria-label="Schematic south-pole view of landing site location">
      <circle cx="38" cy="38" r="31" fill="#11151e" stroke="rgba(243,241,235,0.45)" />
      <circle cx="38" cy="38" r="15.5" fill="none" stroke="rgba(243,241,235,0.2)" />
      <path d="M7 38h62M38 7v62" stroke="rgba(243,241,235,0.2)" />
      <circle cx={38 + 31 * Math.cos(phi) * Math.sin(lambda)} cy={38 - 31 * Math.cos(phi) * Math.cos(lambda)} r="3.6" fill="#ffc36d" />
      <text x="38" y="85" textAnchor="middle" fontSize="8.5">
        {lat < 0 ? 'SOUTH POLE' : 'LUNAR LOC'}
      </text>
    </svg>
  )
}

function Hillshade({
  site,
  node,
  secondaryNode,
  overlay,
  padViability,
  hoverAz,
  onSelect,
}: {
  site: SiteData
  node: number
  secondaryNode?: number | null
  overlay: TerrainOverlay
  padViability?: Uint8Array
  hoverAz?: number | null
  onSelect: (i: number) => void
}) {
  const canvas = useRef<HTMLCanvasElement>(null)
  useEffect(() => {
    const context = canvas.current?.getContext('2d')
    if (!context) return
    const im = context.createImageData(256, 256)
    const grid = site.manifest.analysis_grid
    const halfStep = grid.step_pixel / 2
    for (let i = 0; i < 65536; i++) {
      const h = site.dem_elev
      const dx = h[Math.min(i + 1, 65535)] - h[Math.max(0, i - 1)]
      const dy = h[Math.min(i + 256, 65535)] - h[Math.max(0, i - 256)]
      const gray = Math.max(20, Math.min(245, 132 + 110 * (0.6 + dx / 70 + dy / 70) / Math.hypot(1, dx / 40, dy / 40)))
      let r = gray
      let g = gray
      let b = gray
      if (overlay === 'viable' && padViability) {
        const py = Math.floor(i / 256)
        const px = i % 256
        const cellR = Math.round((py - grid.start_pixel) / grid.step_pixel)
        const cellC = Math.round((px - grid.start_pixel) / grid.step_pixel)
        if (
          cellR >= 0 && cellR < grid.rows && cellC >= 0 && cellC < grid.cols &&
          py >= grid.start_pixel - halfStep && py <= grid.start_pixel + (grid.rows - 1) * grid.step_pixel + halfStep &&
          px >= grid.start_pixel - halfStep && px <= grid.start_pixel + (grid.cols - 1) * grid.step_pixel + halfStep
        ) {
          const v = padViability[cellR * grid.cols + cellC]
          if (v === 2) {
            r = r * 0.42 + 16 * 0.58; g = g * 0.42 + 185 * 0.58; b = b * 0.42 + 129 * 0.58
          } else if (v === 1) {
            r = r * 0.44 + 245 * 0.56; g = g * 0.44 + 158 * 0.56; b = b * 0.44 + 11 * 0.56
          } else {
            r = r * 0.55 + 239 * 0.45; g = g * 0.55 + 68 * 0.45; b = b * 0.55 + 68 * 0.45
          }
        } else {
          r *= 0.72; g *= 0.72; b *= 0.72
        }
      } else if (overlay === 'slope') {
        const sl = site.dem_slope[i]
        if (sl < 5) {
          r = r * 0.55 + 16 * 0.45
          g = g * 0.55 + 185 * 0.45
          b = b * 0.55 + 129 * 0.45
        } else {
          const w = Math.min(0.75, 0.25 + sl / 42)
          r = r * (1 - w) + 239 * w
          g = g * (1 - w) + 68 * w
          b = b * (1 - w) + 68 * w
        }
      } else if (overlay === 'psr' && site.psr_mask[i]) {
        r = r * 0.28 + 168 * 0.72
        g = g * 0.28 + 85 * 0.72
        b = b * 0.28 + 247 * 0.72
      }
      im.data.set([r, g, b, 255], i * 4)
    }
    context.putImageData(im, 0, 0)
    const g = site.manifest.analysis_grid
    context.strokeStyle = '#8eaecf'
    context.strokeRect(g.start_pixel, g.start_pixel, 30 * g.step_pixel, 30 * g.step_pixel)
    if (secondaryNode != null && secondaryNode !== node) {
      const sec = padPixel(site, secondaryNode)
      context.fillStyle = '#8ec9ff'
      context.beginPath()
      context.arc(sec % 256, Math.floor(sec / 256), 4, 0, Math.PI * 2)
      context.fill()
    }
    const pixel = padPixel(site, node)
    const px0 = pixel % 256
    const py0 = Math.floor(pixel / 256)
    if (hoverAz !== null && hoverAz !== undefined) {
      const a = (hoverAz * Math.PI) / 180
      context.save()
      context.strokeStyle = 'rgba(255, 195, 109, 0.85)'
      context.lineWidth = 1.4
      context.setLineDash([4, 3])
      context.beginPath()
      context.moveTo(px0, py0)
      context.lineTo(px0 + Math.sin(a) * 140, py0 - Math.cos(a) * 140)
      context.stroke()
      context.restore()
    }
    context.fillStyle = '#ffc36d'
    context.beginPath()
    context.arc(px0, py0, 4.5, 0, Math.PI * 2)
    context.fill()
  }, [site, node, secondaryNode, overlay, padViability, hoverAz])
  return (
    <div className="hillshade-frame">
      <div className="hillshade-meta">
        <span>20m LOLA DEM</span>
        <span>Pad #{node + 1}</span>
      </div>
      <canvas
        width="256"
        height="256"
        aria-label="LOLA terrain map and candidate footprint. Click to select a pad or use the pad field."
        ref={canvas}
        onClick={e => {
          const bounds = e.currentTarget.getBoundingClientRect()
          const grid = site.manifest.analysis_grid
          const cell = (p: number) => Math.max(0, Math.min(30, Math.round((p - grid.start_pixel) / grid.step_pixel)))
          onSelect(cell(((e.clientY - bounds.top) * 256) / bounds.height) * 31 + cell(((e.clientX - bounds.left) * 256) / bounds.width))
        }}
      />
    </div>
  )
}

function Timeline({
  items,
  index,
  onIndex,
  power,
}: {
  items: Result[]
  index: number
  onIndex: (i: number, scenario?: number) => void
  power: Power
}) {
  const count = items[0].report.sky.length
  const totalDays = Math.max(1, Math.round(count / 288))
  const dayTicks = Array.from({ length: Math.min(6, totalDays + 1) }, (_, idx) =>
    Math.round((idx * totalDays) / Math.max(1, Math.min(5, totalDays))),
  )
  return (
    <div className="mission-timeline">
      <label className="timeline-scrubber">
        <span className="timeline-scrubber-head">
          <span>
            Elapsed mission time: <strong>{n(index / 12)} h</strong> (Day {n(index / 288, 2)})
          </span>
          <output>Step {index + 1} / {count}</output>
        </span>
        <input type="range" min={0} max={count - 1} value={index} onChange={e => onIndex(+e.target.value)} />
      </label>
      <div className="timeline-axis" aria-hidden="true">
        <span />
        <div className="timeline-ticks">
          {dayTicks.map((d, idx) => (
            <span key={idx}>Day {d}</span>
          ))}
        </div>
      </div>
      {items.map(({ report }, j) => (
        <div key={j} className="timeline-group">
          <b>{j ? '02 / Alternative' : '01 / Baseline'}</b>
          {[
            { label: 'Solar exposure', events: report.dark, color: '#d97706', unknownHours: 0 },
            { label: 'Earth-center visibility', events: report.earth, color: '#2563eb', unknownHours: 0 },
            { label: 'NASA DSN (3-Complex)', events: report.dsn, color: '#0f766e', available: true, unknownHours: report.dsnUnknownHours },
            { label: 'Goldstone DSS-14 only', events: report.station, color: '#525760', available: true, unknownHours: report.stationUnknownHours },
          ].map(track => (
            <div className="lane" key={track.label}>
              <span>{track.label}{track.available && track.unknownHours > 0 && ` (${n(track.unknownHours)} h unk)`}</span>
              <div className="lane-track" style={{ background: track.available ? '#0e1014' : track.color }}>
                {track.events.map(e => (
                  <button
                    key={e.start}
                    className={track.available ? 'available' : 'outage'}
                    style={{ left: (e.start / count) * 100 + '%', width: ((e.end - e.start) / count) * 100 + '%' }}
                    aria-label={track.label + ' ' + (track.available ? 'window' : 'obstruction') + ' at ' + n(e.start / 12) + ' hours, ' + n(e.hours) + ' hours long'}
                    onClick={() => onIndex(e.start, j)}
                  />
                ))}
                <i style={{ left: (index / count) * 100 + '%' }} />
              </div>
            </div>
          ))}
          <div className="lane">
            <span>PV generation ({n(report.generation[index], 0)} W)</span>
            <svg viewBox="0 0 1000 24" preserveAspectRatio="none" aria-label={n(report.generation[index], 0) + ' watts at the cursor'} role="img">
              <polyline
                points={report.generation.map((v, i) => [(i * 1000) / count, 23 - (v / Math.max(1, power.arrayW)) * 21].join(',')).join(' ')}
                fill="none"
                stroke="#ffc36d"
                strokeWidth="1.5"
                vectorEffect="non-scaling-stroke"
              />
              <line x1={(index * 1000) / count} x2={(index * 1000) / count} y1={0} y2={24} stroke="#f87171" strokeWidth="1.5" vectorEffect="non-scaling-stroke" />
            </svg>
          </div>
          <div className="lane">
            <span>Battery charge ({n(report.soc[index] * 100, 0)}%)</span>
            <svg viewBox="0 0 1000 24" preserveAspectRatio="none" aria-label="Battery charge trend" role="img">
              <polyline
                points={report.soc.map((v, i) => [(i * 1000) / count, 23 - v * 21].join(',')).join(' ')}
                fill="none"
                stroke="#34d399"
                strokeWidth="1.5"
                vectorEffect="non-scaling-stroke"
              />
              <line x1={(index * 1000) / count} x2={(index * 1000) / count} y1={0} y2={24} stroke="#f87171" strokeWidth="1.5" vectorEffect="non-scaling-stroke" />
            </svg>
          </div>
        </div>
      ))}
    </div>
  )
}

export default function Planner() {
  const [saved] = useState(restore)
  const [scenarios, setScenarios] = useState(saved.scenarios)
  const [days, setDays] = useState(saved.days)
  const [limits, setLimits] = useState(saved.limits)
  const [power, setPower] = useState<Power>(saved.power)
  const [rates, setRates] = useState(saved.rates)
  const [equipment, setEquipment] = useState(saved.equipment)
  const [transferW, setTransferW] = useState(150)
  const [transferPct, setTransferPct] = useState(80)
  const [twinKg, setTwinKg] = useState(15)
  const [items, setItems] = useState<Result[] | null>(null)
  const [pending, setPending] = useState(true)
  const [notice, setNotice] = useState('')
  const [error, setError] = useState('')
  const [retry, setRetry] = useState(0)
  const [active, setActive] = useState(0)
  const [index, setIndex] = useState(0)
  const [canRender3D] = useState(webglAvailable)
  const [view, setView] = useState<'orbit' | 'pad' | 'polar' | 'chart'>(canRender3D ? 'pad' : 'chart')
  const [overlay, setOverlay] = useState<TerrainOverlay>('relief')
  const [compareOverlay, setCompareOverlay] = useState(true)
  const [look, setLook] = useState<'sun' | 'earth' | 'north'>('sun')
  const [tab, setTab] = useState<TabId>('Decision')
  const [hoverAz, setHoverAz] = useState<number | null>(null)
  const [editorOpen, setEditorOpen] = useState(false)
  const [experiment, setExperiment] = useState(() => new URLSearchParams(location.search).has('comparison') ? 'custom' : 'delay')
  const [role, setRole] = useState<'Planner' | 'Scientist' | 'Educator' | 'Public'>('Planner')
  const [showIntro, setShowIntro] = useState(false)
  const entered = useRef(!showIntro)
  const [introFocus, setIntroFocus] = useState<IntroFocus>('system')
  const [prediction, setPrediction] = useState('')
  const [playing, setPlaying] = useState(false)
  const [progress, setProgress] = useState('')
  const [search, setSearch] = useState<SearchResultState | null>(null)
  const [searchSort, setSearchSort] = useState<'target' | 'dark' | 'earth' | 'slope' | 'starts'>('target')
  const [question, setQuestion] = useState(QUICK_QUESTIONS[0])
  const worker = useRef<Worker | null>(null)
  const serial = useRef(0)
  const searchId = useRef(0)
  const restoreVersion = useRef(saved.versions)

  useEffect(() => {
    const instance = new Worker(new URL('./planner.worker.ts', import.meta.url), { type: 'module' })
    instance.onmessage = ({ data }) => {
      if (data.kind === 'compare' && data.id === serial.current) {
        const version = restoreVersion.current
        restoreVersion.current = undefined
        if (version && data.items.some((x: Result, i: number) => fingerprint(x) !== version[i])) {
          setError('This shared comparison references a different data release.')
          setPending(false)
          return
        }
        setItems(data.items)
        setPending(false)
      } else if (data.id === searchId.current && data.kind === 'progress') {
        setProgress(name(data.site) + ' · pad ' + (data.node + 1) + ' of 961')
      } else if (data.id === searchId.current && data.kind === 'search') {
        setProgress('')
        setSearch(data)
      } else if (data.kind === 'error' && data.id === serial.current) {
        setPending(false)
        setError(data.message)
      } else if (data.kind === 'error' && data.id === searchId.current) {
        setProgress('')
        setNotice(data.message)
      }
    }
    instance.onerror = () => {
      setPending(false)
      setError('The analysis worker stopped. Reload to restart it.')
    }
    worker.current = instance
    return () => {
      instance.terminate()
      worker.current = null
    }
  }, [])

  useEffect(() => {
    setPending(true)
    setError('')
    setProgress('')
    setSearch(null)
    searchId.current = 0
    const id = ++serial.current
    worker.current?.postMessage({ id, kind: 'compare', scenarios, days, power, limits } satisfies Request)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scenarios, days, power, retry])

  useEffect(() => {
    if (!playing || !items) return
    const id = setInterval(() => setIndex(i => (i + 12) % items[0].report.sky.length), 160)
    return () => clearInterval(id)
  }, [playing, items])

  useEffect(() => {
    worker.current?.postMessage({ kind: 'cancel' })
    searchId.current = 0
    setSearch(null)
    setProgress('')
  }, [limits])

  const result = items?.[active]
  const cursor = Math.min(index, (result?.report.sky.length ?? 1) - 1)
  const sky = result?.report.sky[cursor]
  const start = result?.meta.start ?? epoch
  const sigma = power.sigma ?? 0
  const arrayMode = power.arrayMode ?? 'tracked'
  const centralRate = rates[1] !== '' && Number.isFinite(Number(rates[1])) ? Number(rates[1]) : null

  const comparisonRecord = useMemo(() => {
    if (!items || items.length < 2) return null
    return buildComparisonRecord({
      scenarios,
      items: [
        {
          report: items[0].report,
          pad: items[0].pad,
          meta: items[0].meta,
          hasRegionalTerrain: Boolean((items[0].terrain || items[0].liveTerrain) && items[0].meta.regional),
          siteName: name(scenarios[0].site),
        },
        {
          report: items[1].report,
          pad: items[1].pad,
          meta: items[1].meta,
          hasRegionalTerrain: Boolean((items[1].terrain || items[1].liveTerrain) && items[1].meta.regional),
          siteName: name(scenarios[1].site),
        },
      ],
      days,
      limits,
      power,
      deliveryRatePerKg: centralRate,
    })
  }, [items, scenarios, days, limits, power, centralRate])

  const groundedAnswer = useMemo(() => {
    if (!comparisonRecord) return null
    return answerScenarioQuestion(comparisonRecord, question)
  }, [comparisonRecord, question])

  const sunCD = result ? countdown(result.report.sky.map(s => s.solar < solarThreshold), cursor, 1 / 12) : null
  const earthCD = result ? countdown(result.report.sky.map(s => s.earthMargin <= 0), cursor, 1 / 12) : null
  const dsnCD = result && !result.report.dsnUnknownHours ? countdown(result.report.sky.map(s => !s.dsnAccess), cursor, 1 / 12) : null

  const sortedSearchOptions = useMemo(() => {
    const raw = search?.allOptions ?? search?.options ?? []
    const target = search?.targetStart ?? scenarios[1].start
    const copy = [...raw]
    copy.sort((a, b) => {
      if (searchSort === 'dark') return (a.longestDark ?? 0) - (b.longestDark ?? 0) || a.slope - b.slope
      if (searchSort === 'earth') return (a.longestEarth ?? 0) - (b.longestEarth ?? 0) || a.slope - b.slope
      if (searchSort === 'slope') return a.slope - b.slope || (a.longestDark ?? 0) - (b.longestDark ?? 0)
      if (searchSort === 'starts') return b.starts - a.starts || a.slope - b.slope
      return (
        Number(b.targetStartMatch ?? false) - Number(a.targetStartMatch ?? false) ||
        Math.abs((a.nearestStart ?? a.scenario.start) - target) - Math.abs((b.nearestStart ?? b.scenario.start) - target) ||
        (a.longestDark ?? 0) - (b.longestDark ?? 0) ||
        a.slope - b.slope
      )
    })
    return copy
  }, [search, searchSort, scenarios])

  const update = (i: number, patch: Partial<Scenario>) => {
    restoreVersion.current = undefined
    setExperiment('custom')
    setScenarios(previous => previous.map((s, j) => (j === i ? { ...s, ...patch } : s)) as [Scenario, Scenario])
  }

  const swapScenarios = () => {
    restoreVersion.current = undefined
    setExperiment('custom')
    setScenarios([scenarios[1], scenarios[0]])
    setActive(a => 1 - a)
  }

  const applyPreset = (
    nextScenarios: [Scenario, Scenario],
    options: { active?: number; tab?: TabId; arrayMode?: ArrayMode; view?: 'orbit' | 'pad' | 'polar' | 'chart'; overlay?: TerrainOverlay } = {},
  ) => {
    restoreVersion.current = undefined
    setExperiment('custom')
    setDays(15)
    setLimits(defaults.limits)
    setScenarios(nextScenarios)
    setActive(options.active ?? 0)
    setIndex(0)
    if (options.tab) setTab(options.tab)
    if (options.arrayMode) setPower(p => ({ ...p, arrayMode: options.arrayMode }))
    if (options.view) setView(options.view)
    if (options.overlay) setOverlay(options.overlay)
  }

  const two = items?.map(x => x.report)
  const delta = two && two[0].totalKg - two[1].totalKg
  const canCompareTwin =
    polarSites.includes(scenarios[0].site) &&
    scenarios[0].site === scenarios[1].site &&
    scenarios[0].start === scenarios[1].start &&
    scenarios[0].node !== scenarios[1].node
  const twin =
    two && canCompareTwin
      ? complementaryPower(two[0].generation, two[1].generation, power, transferW, transferPct / 100, twinKg, 1 / 12)
      : null
  const searchReady = items?.some(x => x.terrain && x.meta.regional)
  const samePolarSite = polarSites.includes(scenarios[0].site) && scenarios[0].site === scenarios[1].site && scenarios[0].node !== scenarios[1].node
  const secondaryNode = samePolarSite ? scenarios[1 - active].node : null

  const runAlternativeSearch = () => {
    if (!result || !searchReady || progress) return
    const id = (searchId.current = ++serial.current)
    setProgress('Scanning 48 km & 96 km regional profiles…')
    setSearch(null)
    worker.current?.postMessage({
      kind: 'search',
      id,
      days,
      power,
      limits,
      mast: scenarios[active].mast,
      targetStart: scenarios[1].start,
      version: result.meta.vectorHash,
    } satisfies Request)
  }

  const exportData = (format: 'json' | 'csv' | 'samples') => {
    if (!items) return
    if (format === 'samples') {
      const rows = [
        'scenario,utc,sun_az_deg,sun_el_deg,sun_horizon_deg,sun_sigma_deg,earth_az_deg,earth_el_deg,earth_horizon_deg,solar_fraction,array_incidence_factor,pv_w,station_geometry',
      ]
      items.forEach((x, i) =>
        x.report.sky.forEach((s, j) =>
          rows.push(
            [
              i ? 'alternative' : 'baseline',
              utc(x.meta.start, scenarios[i].start + j / 12),
              s.sun.az,
              s.sun.el,
              s.sunHorizon,
              s.sunSigma,
              s.earth.az,
              s.earth.el,
              s.earthHorizon,
              s.solar,
              s.incidenceFactor,
              x.report.generation[j],
              s.stationCovered ? s.stationAccess : 'unknown',
            ].join(','),
          ),
        ),
      )
      download('umbra-x-samples.csv', rows.join('\n'), 'text/csv')
      return
    }
    if (format === 'json') {
      download(
        'umbra-x-comparison.json',
        JSON.stringify(
          {
            schema: 1,
            scenarios,
            days,
            limits,
            power,
            rates,
            equipment,
            versions: items.map(fingerprint),
            comparisonRecord,
            solarThreshold,
            results: items.map(x => ({ report: x.report, metadata: x.meta })),
          },
          null,
          2,
        ),
        'application/json',
      )
      return
    }
    const rows = ['scenario,interval,start_utc,end_utc,duration_hours,already_underway,continues_at_end']
    items.forEach((x, i) => {
      for (const key of ['dark', 'earth', 'station'] as const) {
        for (const e of x.report[key]) {
          rows.push(
            [
              i ? 'alternative' : 'baseline',
              key,
              utc(x.meta.start, scenarios[i].start + e.start / 12),
              utc(x.meta.start, scenarios[i].start + e.end / 12),
              e.hours,
              e.atStart,
              e.atEnd,
            ].join(','),
          )
        }
      }
    })
    download('umbra-x-events.csv', rows.join('\n'), 'text/csv')
  }

  const selectRole = (r: 'Planner' | 'Scientist' | 'Educator' | 'Public') => {
    setRole(r)
    setTab(r === 'Scientist' ? 'Methods' : 'Decision')
    setPrediction('')
    if (r === 'Educator' && !scenarios.some(s => s.site === 'apollo-11')) {
      applyPreset(
        [
          { site: 'apollo-11', node: 480, start: 0, mast: 0 },
          { site: 'shackleton-ridge', node: 480, start: 0, mast: 2 },
        ],
        { tab: 'Decision', arrayMode: 'horizontal' },
      )
      setExperiment('apollo')
    }
  }

  const openExperiment = (id: string) => {
    const alternative: Record<string, Scenario> = {
      delay: initial[1],
      recovery: delayedAlternative,
      ridge: { ...initial[0], node: 481 },
      mast: { ...initial[0], mast: 4 },
      sites: { site: 'mons-mouton', node: 565, start: 0, mast: 2 },
      power: { ...initial[0], node: 511 },
      custom: { site: 'custom', node: 480, start: 0, mast: 2, customLat: -89.45, customLon: -138.0 },
    }
    if (id === 'apollo') applyPreset([{ ...initial[0], site: 'apollo-11', mast: 0 }, initial[0]], { tab: 'Decision', arrayMode: 'horizontal' })
    else if (alternative[id]) applyPreset([initial[0], alternative[id]], { tab: id === 'power' ? 'Power & Cost' : 'Decision' })
    if (id === 'search') {
      setTab('Decision')
      runAlternativeSearch()
    } else if (id === 'power') {
      setTab('Power & Cost')
    }
    setExperiment(id)
  }

  const inspectWorstBlackout = (targetMetric: 'sun' | 'earth') => {
    if (!items) return
    const evidence = items[active].report
    const events = targetMetric === 'sun' ? evidence.dark : evidence.earth
    const longest = events.reduce<(typeof events)[number] | undefined>(
      (best, event) => !best || event.hours > best.hours ? event : best, undefined,
    )
    if (longest) setIndex(longest.start)
    setPlaying(false)
    setLook(targetMetric === 'sun' ? 'sun' : 'earth')
    setView(canRender3D ? 'pad' : 'chart')
  }

  if (showIntro) {
    return (
      <div className="mission">
        <div className="intro-shell">
          <section className="intro-content" aria-label="Welcome to Umbra-X">
            <div className="intro-eyebrow">
              <Globe2 size={13} color="#a24e00" /> NASA SPACE APPS 2026 · JPL DE440 · LRO LOLA 96 KM
            </div>
            <div className="intro-greeting">
              <span className="intro-hi">Selenographic Mission Atlas</span>
              <h1>
                <em>Umbra-X</em><br />Lunar Landing Site Navigator
              </h1>
              <p>Compare landing sites and dates by sunlight, Earth visibility, and battery requirements.</p>
            </div>

            <div className="intro-section">
              <div className="intro-section-head">
                <span className="intro-prompt">Choose a role</span>
                <span className="intro-code">SEC. 01 // AUDIENCE</span>
              </div>
              <div className="intro-ledger" role="group" aria-label="Select your role">
                {ROLE_CARDS.map((card, idx) => (
                  <button
                    key={card.id}
                    type="button"
                    className="intro-row"
                    aria-pressed={role === card.id}
                    onClick={() => selectRole(card.id)}
                  >
                    <span className="row-idx">0{idx + 1}</span>
                    <strong>{card.title}</strong>
                    <span className="row-desc">{card.desc}</span>
                    <ArrowRight size={13} className="row-arrow" />
                  </button>
                ))}
              </div>
            </div>

            <div className="intro-section">
              <div className="intro-section-head">
                <span className="intro-prompt">Starting view</span>
                <span className="intro-code">SEC. 02 // PROJECTION</span>
              </div>
              <div className="intro-view-strip" role="group" aria-label="Select your starting view">
                {VIEW_CARDS.map((card, idx) => (
                  <button
                    key={card.id}
                    type="button"
                    className="view-cell"
                    aria-pressed={view === card.id}
                    disabled={(card.id === 'orbit' || card.id === 'pad') && !canRender3D}
                    onClick={() => setView(card.id)}
                  >
                    <span className="view-code">V.0{idx + 1}</span>
                    <strong>{card.title}</strong>
                    <span className="view-tag">{card.tag}</span>
                  </button>
                ))}
              </div>
            </div>

            <div className="intro-actions">
              <div className="intro-actions-left">
                <button type="button" className="intro-enter-btn" onClick={() => {
                  if (!entered.current && role === 'Educator') openExperiment('apollo')
                  if (role === 'Scientist') setTab('Methods')
                  entered.current = true
                  setShowIntro(false)
                }}>
                  Enter Navigator <ArrowRight size={14} />
                </button>
                <span className="intro-status">
                  <i className={`status-dot ${pending ? 'dot-warn' : 'dot-good'}`} />
                  {error ? 'Data unavailable' : pending ? 'Loading ephemerides…' : 'Terrain and ephemerides ready'}
                </span>
              </div>
            </div>
          </section>

          <section className="intro-stage" aria-label="Interactive 3D Moon, Earth, and Sun sculpture">
            {canRender3D ? (
              <Suspense
                fallback={
                  <div className="intro-fallback">
                    <span style={{ color: 'var(--muted)', fontSize: 13 }}>Loading 3D celestial scene…</span>
                  </div>
                }
              >
                <IntroScene focus={introFocus} selectedView={view} />
              </Suspense>
            ) : (
              <div className="intro-fallback">
                <LunarLocator coordinates={[-89.5, 0, 0]} />
              </div>
            )}
            <div className="intro-stage-hud">
              <div className="segmented" role="group" aria-label="Focus celestial body">
                {(['system', 'moon', 'earth', 'sun'] as const).map(body => (
                  <button key={body} type="button" aria-pressed={introFocus === body} onClick={() => setIntroFocus(body)}>
                    {{ system: 'System', moon: 'Moon', earth: 'Earth', sun: 'Sun' }[body]}
                  </button>
                ))}
              </div>
              <span className="intro-hint">Move cursor to shift orbital field · Drag to rotate</span>
            </div>
          </section>
        </div>
      </div>
    )
  }

  return (
    <div className="mission">
      <header className="mission-header">
        <div className="mission-brand">
          <span className="brand-mark" aria-hidden="true">
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
              <circle cx="8" cy="7.5" r="5" stroke="currentColor" strokeWidth="1.4" />
              <path d="M9.5 3a4.6 4.6 0 0 0 0 9 4.5 4.5 0 1 1 0-9Z" fill="currentColor" opacity="0.85" />
              <line x1="1" y1="12.5" x2="15" y2="12.5" stroke="#ffc36d" strokeWidth="1.2" />
            </svg>
          </span>
          UMBRA X
          <span className="brand-meta">DE440 · LRO LOLA 96 KM</span>
        </div>
        <nav className="segmented" aria-label="Audience">
          {(['Planner', 'Scientist', 'Educator', 'Public'] as const).map(r => (
            <button key={r} aria-pressed={role === r} onClick={() => selectRole(r)}>
              {r}
            </button>
          ))}
        </nav>
        <div className="mission-header-actions">
          <button
            disabled={!items || pending || !!error}
            onClick={async () => {
              if (!items) return
              const url = new URL(location.href)
              url.search = ''
              url.searchParams.set(
                'comparison',
                JSON.stringify({ schema: 1, scenarios, days, limits, power, rates, equipment, versions: items.map(fingerprint) }),
              )
              try {
                await navigator.clipboard.writeText(url.href)
                setNotice('Comparison link copied.')
              } catch {
                setNotice(url.href)
              }
            }}
          >
            <Share2 size={13} /> Share
          </button>
          <button type="button" onClick={() => setShowIntro(true)}>
            Intro
          </button>
        </div>
      </header>

      <div className="mobile-bar" role="region" aria-label="Mobile quick controls">
        <div className="mobile-switch">
          {([0, 1] as const).map(i => (
            <button
              key={i}
              type="button"
              aria-pressed={active === i}
              onClick={() => setActive(i)}
            >
              {i ? '02 Alt' : '01 Base'} · {name(scenarios[i].site).split(' ')[0]}
            </button>
          ))}
        </div>
        <button
          type="button"
          className="mobile-edit-btn"
          aria-expanded={editorOpen}
          onClick={() => setEditorOpen(x => !x)}
        >
          <SlidersHorizontal size={12} /> {editorOpen ? 'Done' : 'Edit'}
        </button>
      </div>

      <main className="mission-body">
        <div className="atlas-command-strip">
          <div className="atlas-title-block experiment-title">
            <h1>
              {role === 'Educator'
                ? 'Lunar sky lesson'
                : role === 'Public'
                  ? 'Explore the Lunar Sky & Horizon'
                  : 'Lunar site navigator'}
            </h1>
            <p className="atlas-subtitle">
              {role === 'Educator'
                ? 'Predict which site sees a higher Sun or Earth, then scrub time to discover why polar ridges drive mast geometry.'
                : role === 'Public'
                  ? 'Follow Sun and Earth trajectories across polar crater rims and multi-day shadow windows.'
                  : '5-minute JPL DE440 trajectories against 20 m local & 96 km LOLA horizons.'}
            </p>
          </div>
          <div className="preset-actions">
            <label className="study-select-wrap">
              <span>Study</span>
              <select
                aria-label="Mission study preset"
                value={experiment}
                onChange={e => openExperiment(e.target.value)}
              >
                <option value="delay">48h Launch Delay</option>
                <option value="recovery">Ridge Pad Recovery</option>
                <option value="ridge">Ridge vs Basin Pad</option>
                <option value="mast">1.5m vs 20m Mast</option>
                <option value="sites">Shackleton vs Mons Mouton</option>
                <option value="apollo">Apollo 11 vs South Pole</option>
                <option value="custom">Custom Lat/Lon</option>
              </select>
            </label>
            {role === 'Educator' && <button type="button" onClick={() => openExperiment('apollo')}>Load Apollo lesson</button>}
            <button
              type="button"
              aria-expanded={editorOpen}
              className={editorOpen ? 'btn-config is-open' : 'btn-config'}
              onClick={() => setEditorOpen(x => !x)}
            >
              <SlidersHorizontal size={13} /> {editorOpen ? 'Hide Parameters' : 'Configure Scenarios'}
              {editorOpen ? <ChevronUp size={13} /> : <ChevronDown size={13} />}
            </button>
            <button type="button" className="btn-copilot" onClick={() => setTab('Co-Pilot')}>Ask Co-Pilot</button>
          </div>
        </div>

        {notice && (
          <p className="mission-note" role="status">
            <span>{notice}</span> <button onClick={() => setNotice('')}>Dismiss</button>
          </p>
        )}

        <div className="comparison-strip" role="region" aria-label="Scenario comparison summary">
          {scenarios.map((s, i) => {
            const isPolar = polarSites.includes(s.site)
            const itemResult = items?.[i]
            const covNum = itemResult ? coveredCount(itemResult.pad.coverage) : 360
            const hasRegional = Boolean(itemResult && (itemResult.terrain || itemResult.liveTerrain) && itemResult.meta.regional)
            const sideRecord = comparisonRecord ? (i === 0 ? comparisonRecord.baseline : comparisonRecord.alternative) : null
            const statusDot = !sideRecord
              ? 'dot-muted'
              : !sideRecord.hasRegionalTerrain || !sideRecord.complete
                ? 'dot-warn'
                : sideRecord.viable
                  ? 'dot-good'
                  : 'dot-danger'
            const statusText = !sideRecord
              ? 'Calculating'
              : !sideRecord.hasRegionalTerrain || !sideRecord.complete
                ? hasRegional && covNum < 360
                  ? `Partial ${covNum}/360°`
                  : 'Level sphere'
                : sideRecord.viable
                  ? 'Meets limits'
                  : 'Exceeds limits'
            return (
              <Fragment key={i}>
                <div
                  className={active === i ? 'compare-pill selected' : 'compare-pill'}
                  onClick={() => setActive(i)}
                >
                  <div className="compare-pill-top">
                    <span className="compare-pill-idx">
                      <span className="mono-idx">{i ? '02 /' : '01 /'}</span> {i ? 'Alternative' : 'Baseline'}
                    </span>
                    {sideRecord && (
                      <span className="status-pill">
                        <i className={`status-dot ${statusDot}`} />
                        {statusText}
                      </span>
                    )}
                  </div>
                  <div className="compare-pill-main">
                    <select
                      aria-label={`${i ? 'Alternative' : 'Baseline'} site`}
                      className="inline-site-select"
                      value={s.site}
                      onClick={e => e.stopPropagation()}
                      onChange={e => {
                        const nextSite = e.target.value
                        if (nextSite === 'custom') {
                          update(i, { site: 'custom', customLat: s.customLat ?? -89.45, customLon: s.customLon ?? -138.0 })
                          setEditorOpen(true)
                        } else {
                          update(i, { site: nextSite, node: 480 })
                        }
                      }}
                    >
                      <optgroup label="LOLA 96 km South Pole">
                        {polarSites.map(id => (
                          <option key={id} value={id}>{names[id]}</option>
                        ))}
                      </optgroup>
                      <optgroup label="Reference Missions">
                        {Object.entries(referenceSites)
                          .filter(([id]) => id !== 'custom')
                          .map(([id, info]) => (
                            <option key={id} value={id}>{info.label}</option>
                          ))}
                      </optgroup>
                      <option value="custom">{referenceSites.custom.label}</option>
                    </select>
                    <div className="inline-quick-controls" onClick={e => e.stopPropagation()}>
                      {isPolar && role !== 'Public' && (
                        <>
                          <label className="inline-mini-field">
                            <span>Pad</span>
                            <input
                              type="number"
                              min={1}
                              max={961}
                              value={s.node + 1}
                              onChange={e => {
                                const v = e.target.valueAsNumber
                                if (Number.isFinite(v)) update(i, { node: Math.min(960, Math.max(0, Math.round(v) - 1)) })
                              }}
                            />
                          </label>
                          <select
                            aria-label={`${i ? 'Alternative' : 'Baseline'} mast height`}
                            value={s.mast}
                            onChange={e => update(i, { mast: +e.target.value })}
                          >
                            {[1.5, 3, 5, 10, 20].map((m, j) => (
                              <option key={m} value={j}>{m}m</option>
                            ))}
                          </select>
                        </>
                      )}
                      <span className="inline-utc-chip">{utc(start, s.start).slice(5, 16)}</span>
                      <button
                        type="button"
                        className="inline-shift-btn"
                        title="Shift −24h"
                        onClick={() => update(i, { start: Math.max(0, s.start - 24) })}
                      >−24h</button>
                      <button
                        type="button"
                        className="inline-shift-btn"
                        title="Shift +48h"
                        onClick={() => update(i, { start: Math.min(720 - days * 24, s.start + 48) })}
                      >+48h</button>
                    </div>
                  </div>
                </div>
                {i === 0 && (
                  <button
                    type="button"
                    className="swap-btn swap-btn-inline"
                    onClick={swapScenarios}
                    aria-label="Swap Baseline and Alternative scenarios"
                    title="Swap Baseline and Alternative"
                  >
                    <ArrowLeftRight size={13} />
                  </button>
                )}
              </Fragment>
            )
          })}
        </div>

        {editorOpen && (
          <div className="scenario-grid">
          {scenarios.map((s, i) => {
            const isPolar = polarSites.includes(s.site)
            const refInfo = referenceSites[s.site]
            const itemResult = items?.[i]
            const covNum = itemResult ? coveredCount(itemResult.pad.coverage) : 360
            const hasRegional = Boolean(itemResult && (itemResult.terrain || itemResult.liveTerrain) && itemResult.meta.regional)
            const sideRecord = comparisonRecord ? (i === 0 ? comparisonRecord.baseline : comparisonRecord.alternative) : null
            const baseRecord = comparisonRecord?.baseline ?? null
            const statusDot = !sideRecord
              ? 'dot-muted'
              : !sideRecord.hasRegionalTerrain || !sideRecord.complete
                ? 'dot-warn'
                : sideRecord.viable
                  ? 'dot-good'
                  : 'dot-danger'
            const statusText = !sideRecord
              ? 'Calculating'
              : !sideRecord.hasRegionalTerrain || !sideRecord.complete
                ? hasRegional && covNum < 360
                  ? `Partial ${covNum}/360°`
                  : 'Level sphere'
                : sideRecord.viable
                  ? 'Meets limits'
                  : 'Exceeds limits'
            const darkDelta = i === 1 && sideRecord && baseRecord ? sideRecord.longestDark - baseRecord.longestDark : 0
            const earthDelta = i === 1 && sideRecord && baseRecord ? sideRecord.longestEarth - baseRecord.longestEarth : 0

            return (
              <Fragment key={i}>
                <section aria-label={i ? 'Alternative' : 'Baseline'} className={active === i ? 'scenario selected' : 'scenario'}>
                  <div>
                    <div className="scenario-header">
                      <div className="scenario-select-group">
                        <button className="scenario-title" aria-pressed={active === i} onClick={() => setActive(i)}>
                          <span className="mono-idx">{i ? '02 /' : '01 /'}</span> {i ? 'Alternative' : 'Baseline'}
                        </button>
                        {sideRecord && (
                          <span className="status-pill">
                            <i className={`status-dot ${statusDot}`} />
                            {statusText}
                          </span>
                        )}
                      </div>
                      <span className="scenario-badge">
                        {isPolar
                          ? `LOLA 20m / 96km · Pad #${s.node + 1}`
                          : itemResult?.liveTerrain
                            ? `Live 80m LOLA`
                            : refInfo
                              ? `${refInfo.agency} · Level horizon`
                              : 'Level horizon'}
                        {itemResult ? ` · ${n(itemResult.pad.coordinates[0], 2)}°, ${n(itemResult.pad.coordinates[1], 2)}°` : ''}
                      </span>
                    </div>

                    <div className={(isPolar && role !== 'Public') || s.site === 'custom' ? 'scenario-fields' : 'scenario-fields two-cols'}>
                      <label>
                        Site
                        <select
                          value={s.site}
                          onChange={e => {
                            const nextSite = e.target.value
                            if (nextSite === 'custom') {
                              update(i, {
                                site: 'custom',
                                customLat: s.customLat ?? -89.45,
                                customLon: s.customLon ?? -138.0,
                              })
                            } else {
                              update(i, { site: nextSite, node: 480 })
                            }
                          }}
                        >
                          <optgroup label="LOLA 96 km South Pole Regions">
                            {polarSites.map(id => (
                              <option key={id} value={id}>
                                {names[id]}
                              </option>
                            ))}
                          </optgroup>
                          <optgroup label="Notable Lunar Missions (DE440 Level Horizon)">
                            {Object.entries(referenceSites)
                              .filter(([id]) => id !== 'custom')
                              .map(([id, info]) => (
                                <option key={id} value={id}>
                                  {info.label}
                                </option>
                              ))}
                          </optgroup>
                          <optgroup label="Custom Coordinates">
                            <option value="custom">{referenceSites.custom.label}</option>
                          </optgroup>
                        </select>
                      </label>
                      {isPolar && role !== 'Public' && (
                        <>
                          <NumberField label="Pad (1–961)" value={s.node + 1} min={1} max={961} onChange={v => update(i, { node: Math.round(v) - 1 })} />
                          <label>
                            Mast
                            <select value={s.mast} onChange={e => update(i, { mast: +e.target.value })}>
                              {[1.5, 3, 5, 10, 20].map((m, j) => (
                                <option key={m} value={j}>
                                  {m} m
                                </option>
                              ))}
                            </select>
                          </label>
                        </>
                      )}
                      {s.site === 'custom' && (
                        <>
                          <NumberField
                            label="Lat (°)"
                            value={s.customLat ?? -89.45}
                            min={-90}
                            max={90}
                            step={0.01}
                            onChange={v => update(i, { customLat: v })}
                          />
                          <NumberField
                            label="Lon (°)"
                            value={s.customLon ?? -138.0}
                            min={-180}
                            max={360}
                            step={0.01}
                            onChange={v => update(i, { customLon: v })}
                          />
                        </>
                      )}
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 4, minWidth: 0 }}>
                        <div className="label-row">
                          <label htmlFor={`start-utc-${i}`}>Start (UTC)</label>
                          <div className="shift-inline">
                            {[-24, 24, 48].map(deltaH => (
                              <button
                                key={deltaH}
                                type="button"
                                onClick={() => update(i, { start: Math.max(0, Math.min(720 - days * 24, s.start + deltaH)) })}
                              >
                                {deltaH > 0 ? `+${deltaH}h` : `${deltaH}h`}
                              </button>
                            ))}
                          </div>
                        </div>
                        <input
                          id={`start-utc-${i}`}
                          type="datetime-local"
                          step={3600}
                          min={utc(start, 0).slice(0, 16).replace(' ', 'T')}
                          max={utc(start, 720 - days * 24).slice(0, 16).replace(' ', 'T')}
                          value={utc(start, s.start).slice(0, 16).replace(' ', 'T')}
                          onChange={e => {
                            const elapsed = Math.round((Date.parse(e.target.value + 'Z') - Date.parse(start)) / 3600000)
                            if (Number.isFinite(elapsed)) update(i, { start: Math.max(0, Math.min(720 - days * 24, elapsed)) })
                          }}
                        />
                      </div>
                    </div>

                    {s.site === 'custom' && (
                      <div className="custom-actions">
                        <button
                          type="button"
                          onClick={async () => {
                            const lat = s.customLat ?? -89.45
                            const lon = s.customLon ?? -138.0
                            try {
                              const match = await findNearestPolarPad(lat, lon)
                              if (match.insideTile) {
                                update(i, { site: match.site, node: match.node })
                                setNotice(`Snapped to LOLA 96 km ${name(match.site)} pad #${match.node + 1} (${n(match.distanceM, 0)} m from coordinate).`)
                              } else {
                                setNotice(
                                  `Coordinate is ${n(match.distanceM / 1000, 1)} km from nearest compiled pad (${name(match.site)}). ${lat <= -80 ? 'Querying live 80 m LOLA service if available, else level horizon.' : 'Evaluating DE440 level horizon.'}`,
                                )
                              }
                            } catch (err) {
                              setNotice(err instanceof Error ? err.message : 'Unable to query polar tiles.')
                            }
                          }}
                        >
                          <Compass size={13} /> Snap to nearest LOLA pad
                        </button>
                        <span>Exact DE440 angles Moon-wide; LOLA horizon inside 80°S–90°S.</span>
                      </div>
                    )}
                  </div>

                  {sideRecord && !pending && !error && (
                    <div className="scenario-kpis">
                      <div className="scenario-kpi">
                        <span>Low light</span>
                        <strong>{n(sideRecord.longestDark)} h</strong>
                        <small className={i === 1 && darkDelta !== 0 ? (darkDelta < 0 ? 'delta-good' : 'delta-warn') : undefined}>
                          {i === 1 && darkDelta !== 0
                            ? `${sign(darkDelta)} h vs Base · ≤${limits.dark} h`
                            : `Limit ≤ ${limits.dark} h`}
                        </small>
                      </div>
                      <div className="scenario-kpi">
                        <span>Earth outage</span>
                        <strong>{n(sideRecord.longestEarth)} h</strong>
                        <small className={i === 1 && earthDelta !== 0 ? (earthDelta < 0 ? 'delta-good' : 'delta-danger') : undefined}>
                          {i === 1 && earthDelta !== 0
                            ? `${sign(earthDelta)} h vs Base · ≤${limits.earth} h`
                            : `Limit ≤ ${limits.earth} h`}
                        </small>
                      </div>
                      <div className="scenario-kpi">
                        <span>Slope · Batt</span>
                        <strong>
                          {sideRecord.slopeDeg === null ? '—' : `${n(sideRecord.slopeDeg)}°`} · {n(sideRecord.batteryKg)} kg
                        </strong>
                        <small className={!sideRecord.feasible ? 'delta-danger' : undefined}>
                          {n(sideRecord.totalKg)} / {power.budgetKg} kg total
                        </small>
                      </div>
                    </div>
                  )}
                </section>
                {i === 0 && (
                  <div className="swap-column">
                    <button
                      type="button"
                      className="swap-btn"
                      onClick={swapScenarios}
                      aria-label="Swap Baseline and Alternative scenarios"
                      title="Swap Baseline and Alternative"
                    >
                      <ArrowLeftRight size={14} />
                    </button>
                  </div>
                )}
              </Fragment>
            )
          })}
          </div>
        )}

        {error && (
          <p role="alert" className="mission-note">
            <span>{error}</span> <button onClick={() => setRetry(x => x + 1)}>Retry</button>
          </p>
        )}
        {pending && (
          <p role="status" className="mission-note">
            Calculating mission windows…
          </p>
        )}
        {role === 'Educator' && (
          <section className="mission-note">
            <label>
              Predict which site has the higher Sun elevation at this moment
              <select value={prediction} onChange={e => setPrediction(e.target.value)}>
                <option value="">Choose a prediction</option>
                <option value="0">Baseline</option>
                <option value="1">Alternative</option>
              </select>
            </label>
            {prediction && items && !pending && (
              <span>
                Baseline {n(items[0].report.sky[cursor].sun.el)}° · Alternative {n(items[1].report.sky[cursor].sun.el)}°. Open <b>Power & Cost</b> and test <b>Horizontal Deck</b> vs <b>Vertical Mast</b>.
              </span>
            )}
          </section>
        )}

        {result && sky && comparisonRecord && !pending && !error && (
          <>
            <div className="mission-workspace">
              <section className="sky-panel" aria-label="Lunar sky">
                <div className="sky-toolbar">
                  <div className="sky-toolbar-meta">
                    <span className="sky-fig-label">FIG. 01 · TERRAIN &amp; CELESTIAL PLATE</span>
                    <strong>
                      {active ? '02 / Alternative: ' : '01 / Baseline: '}
                      {name(scenarios[active].site)}
                    </strong>
                    <span className="sky-utc">{utc(result.meta.start, scenarios[active].start + cursor / 12)}</span>
                  </div>
                  <div className="toolbar-controls">
                    {result.terrain && (view === 'orbit' || view === 'chart') && (
                      <div className="segmented" aria-label="Terrain overlay">
                        {(['relief', 'viable', 'slope', 'psr'] as const).map(ov => (
                          <button key={ov} aria-pressed={overlay === ov} onClick={() => setOverlay(ov)}>
                            <Layers size={12} /> {{ relief: 'Relief', viable: 'Viable Pads', slope: 'Slope <5°', psr: 'Mapped PSR' }[ov]}
                          </button>
                        ))}
                      </div>
                    )}
                    {(view === 'polar' || view === 'chart') && (
                      <button aria-pressed={compareOverlay} onClick={() => setCompareOverlay(x => !x)}>
                        Overlay alt
                      </button>
                    )}
                    <div className="segmented" aria-label="Sky view">
                      {(['orbit', 'pad', 'polar', 'chart'] as const).map(v => (
                        <button
                          key={v}
                          aria-pressed={v === view}
                          disabled={(v === 'orbit' || v === 'pad') && !canRender3D}
                          onClick={() => setView(v)}
                        >
                          {{ orbit: 'Orbit 3D', pad: 'From the pad', polar: '360° Polar', chart: '2D & chart' }[v]}
                        </button>
                      ))}
                    </div>
                  </div>
                </div>

                <div
                  className={
                    'sky-stage ' +
                    (view === 'chart'
                      ? 'sky-chart sky-stage-paper'
                      : view === 'polar'
                        ? 'sky-polar sky-stage-paper'
                        : '')
                  }
                >
                  {view === 'chart' ? (
                    <>
                      {result.terrain && (
                        <Hillshade
                          site={result.terrain}
                          node={scenarios[active].node}
                          secondaryNode={secondaryNode}
                          overlay={overlay}
                          padViability={result.padViability}
                          hoverAz={hoverAz}
                          onSelect={node => update(active, { node })}
                        />
                      )}
                      <Horizon
                        items={items!}
                        active={active}
                        index={cursor}
                        compareOverlay={compareOverlay}
                        sigma={sigma}
                        hoverAz={hoverAz}
                        onHoverAz={setHoverAz}
                      />
                    </>
                  ) : view === 'polar' ? (
                    <PolarSky
                      items={items!}
                      active={active}
                      index={cursor}
                      compareOverlay={compareOverlay}
                      sigma={sigma}
                      hoverAz={hoverAz}
                      onHoverAz={setHoverAz}
                    />
                  ) : (
                    <Suspense fallback={<p>Loading lunar terrain…</p>}>
                      <Scene
                        site={result.terrain}
                        node={scenarios[active].node}
                        pad={result.pad}
                        sky={sky}
                        mode={view}
                        look={look}
                        overlay={overlay}
                        series={result.report.sky}
                        secondaryNode={secondaryNode}
                        padViability={result.padViability}
                      />
                    </Suspense>
                  )}
                  {view === 'orbit' && result.terrain && <LunarLocator coordinates={result.pad.coordinates} />}
                </div>
                {overlay === 'viable' && result.padViability && (view === 'orbit' || view === 'chart') && (
                  <div className="viable-legend" role="status">
                    <span><i className="dot-good" /> Meets all limits ({result.padViability.filter(v => v === 2).length})</span>
                    <span><i className="dot-warn" /> Solar &amp; slope OK; Earth/48km warning ({result.padViability.filter(v => v === 1).length})</span>
                    <span><i className="dot-danger" /> Steep, missing coverage, or dark ({result.padViability.filter(v => v === 0).length})</span>
                    {result.padSolarPct && <strong>Active pad sun: {result.padSolarPct[scenarios[active].node]}%</strong>}
                  </div>
                )}

                {view === 'pad' && (
                  <div className="sky-caption">
                    <div className="segmented" aria-label="Look direction">
                      {(['sun', 'earth', 'north'] as const).map(body => (
                        <button key={body} aria-pressed={look === body} onClick={() => setLook(body)}>
                          {{ sun: 'Look at Sun', earth: 'Look at Earth', north: 'Face north' }[body]}
                        </button>
                      ))}
                    </div>
                    <span className="horizon-key">Drag to inspect 96 km rim · markers enlarged for legibility.</span>
                  </div>
                )}

                {sunCD && earthCD && (
                  <div className="countdowns" aria-label="Live operational countdowns">
                    <section>
                      <span className="cd-label">
                        <i className={`status-dot ${sunCD.visible ? 'dot-good' : 'dot-warn'}`} />
                        Solar Power · {sunCD.visible ? `${n(sky.solar * 100, 0)}% disk` : 'Low light'}
                      </span>
                      <strong>
                        {sunCD.visible
                          ? sunCD.persistsToEnd
                            ? `Lit to end (${n(sunCD.hoursRemaining)} h)`
                            : `T−${n(sunCD.hoursRemaining)} h to low light`
                          : sunCD.persistsToEnd
                            ? `Low light to end (${n(sunCD.hoursRemaining)} h)`
                            : `T−${n(sunCD.hoursRemaining)} h to 10% solar`}
                      </strong>
                      <small>
                        El {sign(sky.sun.el)}° · Az {n(sky.sun.az)}° · Clear {sign(sky.sunMargin)}° · {n(result.report.generation[cursor], 0)} W
                      </small>
                    </section>
                    <section>
                      <span className="cd-label">
                        <i className={`status-dot ${earthCD.visible ? 'dot-good' : 'dot-warn'}`} />
                        Earth Visibility · {earthCD.visible ? 'In view' : 'Obstructed'}
                      </span>
                      <strong>
                        {earthCD.visible
                          ? earthCD.persistsToEnd
                            ? `Visible to end (${n(earthCD.hoursRemaining)} h)`
                            : `T−${n(earthCD.hoursRemaining)} h to Earthset`
                          : earthCD.persistsToEnd
                            ? `Blocked to end (${n(earthCD.hoursRemaining)} h)`
                            : `T−${n(earthCD.hoursRemaining)} h to Earthrise`}
                      </strong>
                      <small>
                        El {sign(sky.earth.el)}° · Az {n(sky.earth.az)}° · Clear {sign(sky.earthMargin)}°
                        {sky.obstructionM > 0 ? ` · Ridge ${n(sky.obstructionM / 1000)} km` : ''}
                      </small>
                    </section>
                    <section>
                      <span className="cd-label">
                        <i className={`status-dot ${dsnCD?.visible ? 'dot-good' : 'dot-muted'}`} />
                        NASA DSN · {!sky.dsnCovered ? 'Unknown' : sky.dsnAccess ? 'Open' : 'Blocked'}
                      </span>
                      <strong>
                        {!dsnCD
                          ? 'Gaps in 80°S coverage'
                          : dsnCD.visible
                            ? dsnCD.persistsToEnd
                              ? `Open to end (${n(dsnCD.hoursRemaining)} h)`
                              : `T−${n(dsnCD.hoursRemaining)} h to close`
                            : dsnCD.persistsToEnd
                              ? `Blocked to end (${n(dsnCD.hoursRemaining)} h)`
                              : `T−${n(dsnCD.hoursRemaining)} h to open`}
                      </strong>
                      <small>
                        {sky.dsnActiveStation ?? 'No complex ≥10°'} · Max {n(sky.dsnMaxUp)}° · SoC {n(result.report.soc[cursor] * 100, 0)}%
                      </small>
                    </section>
                  </div>
                )}
              </section>

              <div className="inspector-column">
                <section className="verdict-strip" aria-label="Mission executive summary">
                  <div className="verdict-copy">
                    <div className="verdict-badges">
                      <span
                        className={`verdict-badge ${
                          comparisonRecord.baseline.viable && comparisonRecord.alternative.viable
                            ? 'badge-meets'
                            : comparisonRecord.alternative.viable || comparisonRecord.baseline.viable
                              ? 'badge-warn'
                              : 'badge-exceeds'
                        }`}
                      >
                        {comparisonRecord.baseline.viable && comparisonRecord.alternative.viable
                          ? 'Both Scenarios Viable'
                          : comparisonRecord.alternative.viable
                            ? 'Alternative Viable · Baseline Fails'
                            : comparisonRecord.baseline.viable
                              ? 'Baseline Viable · Alternative Fails'
                              : 'Neither Scenario Meets Limits'}
                      </span>
                      {result.padViability && (
                        <span className="verdict-badge badge-neutral">
                          {result.padViability.filter(v => v === 2).length} / 961 viable pads
                        </span>
                      )}
                    </div>
                    <h2 className="verdict-headline">
                      {comparisonRecord.baseline.viable && comparisonRecord.alternative.viable
                        ? 'Both launch windows satisfy geometry and power limits.'
                        : comparisonRecord.alternative.viable
                          ? 'Alternative window resolves the baseline constraint failure.'
                          : `Earth outage shifts ${sign(comparisonRecord.alternative.longestEarth - comparisonRecord.baseline.longestEarth)} h; illumination remains limiting.`}
                    </h2>
                    <p>{summarizeComparison(comparisonRecord)}</p>
                  </div>
                  <div className="verdict-actions">
                    <button type="button" onClick={() => inspectWorstBlackout('earth')}>
                      Inspect Worst Blackout
                    </button>
                    {result.terrain && (
                      <button
                        type="button"
                        aria-pressed={overlay === 'viable'}
                        onClick={() => {
                          setOverlay('viable')
                          if (view === 'pad' || view === 'polar') setView(canRender3D ? 'orbit' : 'chart')
                        }}
                      >
                        <Layers size={12} /> Viable Pads Map
                      </button>
                    )}
                    <button
                      type="button"
                      className="btn-primary-action"
                      disabled={!searchReady || !!progress}
                      onClick={() => {
                        setTab('Decision')
                        runAlternativeSearch()
                      }}
                    >
                      <Search size={12} /> Find Viable Pads for Alt Date
                    </button>
                  </div>
                </section>

                <section className="mission-inspector" aria-label="Comparison details">
                  <div className="tab-bar" role="tablist" aria-label="Details">
                    {(['Decision', 'Co-Pilot', 'Power & Cost', 'Methods'] as const).map(t => (
                      <button key={t} role="tab" aria-selected={t === tab} onClick={() => setTab(t)}>
                        {t}
                      </button>
                    ))}
                  </div>
                  <div className="tab-body">

                {tab === 'Decision' && (
                  <>
                    <div className="kpi-delta-grid" aria-label="Key trade-off deltas">
                      <div className="kpi-delta-card">
                        <span>Max Low Light</span>
                        <strong>{n(two![1].longestDark)} h</strong>
                        <small className={two![1].longestDark <= limits.dark ? 'delta-good' : 'delta-danger'}>
                          {sign(two![1].longestDark - two![0].longestDark)} h vs Base
                        </small>
                      </div>
                      <div className="kpi-delta-card">
                        <span>Max Earth Outage</span>
                        <strong>{n(two![1].longestEarth)} h</strong>
                        <small className={two![1].longestEarth <= limits.earth ? 'delta-good' : 'delta-danger'}>
                          {sign(two![1].longestEarth - two![0].longestEarth)} h vs Base
                        </small>
                      </div>
                      <div className="kpi-delta-card">
                        <span>Sunlit Hours</span>
                        <strong>{n(two![1].solarHours)} h</strong>
                        <small className={two![1].solarHours >= two![0].solarHours ? 'delta-good' : 'delta-warn'}>
                          {sign(two![1].solarHours - two![0].solarHours)} h vs Base
                        </small>
                      </div>
                      <div className="kpi-delta-card">
                        <span>DSN 3-Complex</span>
                        <strong>{n(two![1].dsnHours)} h</strong>
                        <small className={two![1].dsnHours >= two![0].dsnHours ? 'delta-good' : 'delta-warn'}>
                          {sign(two![1].dsnHours - two![0].dsnHours)} h vs Base
                        </small>
                      </div>
                    </div>
                    <details className="tuning-drawer">
                      <summary>
                        Full comparison ledger
                        <span>9 geometry, DSN &amp; slope metrics</span>
                      </summary>
                      <table>
                      <thead>
                        <tr>
                          <th scope="col">Mission metric</th>
                          <th scope="col">Baseline</th>
                          <th scope="col">Alternative</th>
                        </tr>
                      </thead>
                      <tbody>
                        <tr>
                          <th scope="row">Longest low light<span>Max single interval &lt;10% solar disk</span></th>
                          {two!.map((x, i) => {
                            const req = requirement(x.longestDark, limits.dark, x.complete, x.referenceLongestDark)
                            return (
                              <td key={i}>
                                {n(x.longestDark)} h<span className={statusClass(req)}>{req}</span>
                              </td>
                            )
                          })}
                        </tr>
                        <tr>
                          <th scope="row">Longest Earth obstruction<span>Longest continuous Earth-center obstruction</span></th>
                          {two!.map((x, i) => {
                            const req = requirement(x.longestEarth, limits.earth, x.complete, x.referenceLongestEarth)
                            return (
                              <td key={i}>
                                {n(x.longestEarth)} h<span className={statusClass(req)}>{req}</span>
                              </td>
                            )
                          })}
                        </tr>
                        <tr>
                          <th scope="row">Above 10% solar disk</th>
                          {two!.map((x, i) => (
                            <td key={i}>
                              {n(x.solarHours)} h<span>{n((x.solarHours / (days * 24)) * 100, 0)}% of window</span>
                            </td>
                          ))}
                        </tr>
                        <tr>
                          <th scope="row">Earth center visible</th>
                          {two!.map((x, i) => (
                            <td key={i}>
                              {n(x.earthHours)} h<span>{n((x.earthHours / (days * 24)) * 100, 0)}% of window</span>
                            </td>
                          ))}
                        </tr>
                        <tr>
                          <th scope="row">NASA DSN (3-Complex)<span>Goldstone DSS-14 · Madrid DSS-65 · Canberra DSS-43</span></th>
                          {two!.map((x, i) => (
                            <td key={i}>
                              {n(x.dsnHours)} h
                              <span>max blackout {n(x.longestDsnBlackout)} h · {n(x.dsnDisagreementHours)} h vs Earth center</span>
                            </td>
                          ))}
                        </tr>
                        <tr>
                          <th scope="row">Goldstone DSS-14 only</th>
                          {two!.map((x, i) => (
                            <td key={i}>
                              {n(x.stationHours)} h
                              <span>{n(x.disagreementHours)} h vs Earth center{x.stationUnknownHours ? ` · ${n(x.stationUnknownHours)} h unknown` : ''}</span>
                            </td>
                          ))}
                        </tr>
                        <tr>
                          <th scope="row">Solar elevation range</th>
                          {two!.map((x, i) => (
                            <td key={i}>
                              {sign(x.minSunEl)}° to {sign(x.maxSunEl)}°
                            </td>
                          ))}
                        </tr>
                        <tr>
                          <th scope="row">Earth elevation range</th>
                          {two!.map((x, i) => (
                            <td key={i}>
                              {sign(x.minEarthEl)}° to {sign(x.maxEarthEl)}°
                            </td>
                          ))}
                        </tr>
                        <tr>
                          <th scope="row">Coarse slope & PSR</th>
                          {two!.map((x, i) => {
                            const req = requirement(x.slope, limits.slope)
                            return (
                              <td key={i}>
                                {x.slope == null ? '—' : n(x.slope) + '°'}
                                {items![i].terrain ? (x.psr ? ' · Mapped PSR' : ' · Non-PSR') : ''}
                                <span className={statusClass(req)}>{req}</span>
                              </td>
                            )
                          })}
                        </tr>
                      </tbody>
                    </table>
                    </details>

                    <details className="tuning-drawer">
                      <summary>
                        Mission constraints & array geometry
                        <span>
                          {days}d · ≤{limits.dark}h dark · ≤{limits.earth}h Earth · {sigma}σ
                        </span>
                      </summary>
                      <div className="decision-controls">
                        <NumberField
                          label="Mission days"
                          min={1}
                          max={15}
                          value={days}
                          onChange={value => {
                            const duration = Math.round(value)
                            setDays(duration)
                            setScenarios(previous => previous.map(s => ({ ...s, start: Math.min(s.start, 720 - duration * 24) })) as [Scenario, Scenario])
                          }}
                        />
                        {(role === 'Planner' || role === 'Scientist') && (
                          <>
                            <label>
                              Solar array geometry
                              <select value={arrayMode} onChange={e => setPower({ ...power, arrayMode: e.target.value as ArrayMode })}>
                                <option value="tracked">2-axis sun-tracking</option>
                                <option value="vertical">Vertical mast (cos el)</option>
                                <option value="horizontal">Horizontal deck (sin el)</option>
                              </select>
                            </label>
                            <label>
                              Local LOLA error sensitivity
                              <select value={sigma} onChange={e => setPower({ ...power, sigma: +e.target.value })}>
                                <option value={0}>0σ (Nominal DEM)</option>
                                <option value={1}>1σ Conservative</option>
                                <option value={2}>2σ Conservative</option>
                                <option value={3}>3σ Worst-case</option>
                              </select>
                            </label>
                          </>
                        )}
                        {role === 'Planner' && (
                          <>
                            <NumberField
                              label="Low-light limit (h)"
                              max={360}
                              value={limits.dark}
                              onChange={dark => {
                                setLimits({ ...limits, dark })
                                setSearch(null)
                              }}
                            />
                            <NumberField
                              label="Earth blackout limit (h)"
                              max={360}
                              value={limits.earth}
                              onChange={earth => {
                                setLimits({ ...limits, earth })
                                setSearch(null)
                              }}
                            />
                            <NumberField
                              label="Coarse slope limit (°)"
                              max={90}
                              value={limits.slope}
                              onChange={slope => {
                                setLimits({ ...limits, slope })
                                setSearch(null)
                              }}
                            />
                          </>
                        )}
                      </div>
                    </details>

                    <details className="decision-explanation" open={role === 'Educator' || role === 'Public'}>
                      <summary>Why lunar south-pole conditions are extreme</summary>
                      <p>
                        The alternative shifts longest low light by <strong>{sign(two![1].longestDark - two![0].longestDark)} h</strong> and longest
                        Earth obstruction by <strong>{sign(two![1].longestEarth - two![0].longestEarth)} h</strong>.
                      </p>
                      <p>
                        Because the Moon has only a 1.54° axial tilt, the polar Sun skims the horizon ({sign(two![0].minSunEl)}° to{' '}
                        {sign(two![0].maxSunEl)}° here). A 50 m ridge casts multi-day shadows, and Earth’s ±6.5° libration swings DTE links above and below distant crater rims.
                      </p>
                    </details>

                    {role === 'Planner' && (
                      <div className="pareto-panel">
                        <div className="pareto-head">
                          <strong>Window Optimization Search</strong>
                          <button disabled={!searchReady || !!progress} onClick={runAlternativeSearch}>
                            <Search size={13} /> Scan 2,883 pads × {721 - days * 24} starts
                          </button>
                        </div>
                        {progress && (
                          <p role="status">
                            {progress}{' '}
                            <button
                              className="link-btn"
                              onClick={() => {
                                worker.current?.postMessage({ kind: 'cancel' })
                                searchId.current = 0
                                setProgress('')
                              }}
                            >
                              Cancel
                            </button>
                          </p>
                        )}
                        {!searchReady && <p>Window search scans the 3 compiled polar terrain bundles (select a polar site first).</p>}
                        {search && (
                          <>
                            <p role="status" className="search-meta">
                              {search.count
                                ? `${search.count.toLocaleString()} eligible pad/start pairs across 48 km & 96 km profiles${search.elapsedMs != null ? ` · ${search.elapsedMs} ms (${search.engine})` : ''}`
                                : 'No scenario meets all geometry limits in both terrain profiles.'}
                            </p>
                            {!!sortedSearchOptions.length && (
                              <div className="pareto-sorts" role="group" aria-label="Rank Pareto alternatives">
                                {([
                                  ['target', `Match Alt Date (${utc(start, scenarios[1].start).slice(5, 16)})`],
                                  ['dark', 'Min Darkness'],
                                  ['earth', 'Min Earth Blackout'],
                                  ['slope', 'Flattest Slope'],
                                  ['starts', 'Widest Window'],
                                ] as const).map(([key, label]) => (
                                  <button key={key} type="button" aria-pressed={searchSort === key} onClick={() => setSearchSort(key)}>
                                    {label}
                                  </button>
                                ))}
                              </div>
                            )}
                            <div className="search-results">
                              {sortedSearchOptions.slice(0, 12).map(({ scenario: s, slope, starts, targetStartMatch, longestDark, longestEarth, solarPct }) => (
                                <div className="search-option" key={s.site + s.node}>
                                  <div>
                                    <strong>
                                      {name(s.site)} · Pad #{s.node + 1} · {utc(start, s.start)}
                                      {targetStartMatch ? ' · Exact Date' : ''}
                                    </strong>
                                    <span>
                                      {longestDark != null ? `Dark ${n(longestDark)}h` : ''}
                                      {longestEarth != null ? ` · Earth ${n(longestEarth)}h` : ''}
                                      {solarPct != null ? ` · Sun ${solarPct}%` : ''}
                                      {` · ${n(slope)}° · ${starts} windows`}
                                    </span>
                                  </div>
                                  <button
                                    type="button"
                                    onClick={() => {
                                      update(1, s)
                                      setActive(1)
                                    }}
                                  >
                                    Use Alt
                                  </button>
                                </div>
                              ))}
                            </div>
                          </>
                        )}
                      </div>
                    )}
                  </>
                )}

                {tab === 'Co-Pilot' && (
                  <div className="copilot-panel">
                    <div className="copilot-study-wrap">
                      <AskStudy
                        scenarios={scenarios}
                        active={active}
                        days={days}
                        limits={limits}
                        power={power}
                        epoch={start}
                        hours={result ? ((result.meta.count - 1) * result.meta.stepMinutes) / 60 : 720}
                        version={pending || error ? undefined : result?.meta.vectorHash}
                        onCompare={(next, duration, nextLimits) => {
                          restoreVersion.current = undefined
                          setScenarios(next)
                          setDays(duration)
                          if (nextLimits) setLimits(nextLimits)
                          setExperiment('custom')
                          setActive(1)
                          setIndex(0)
                          setPlaying(false)
                          setTab('Decision')
                          setView(canRender3D ? 'pad' : 'chart')
                        }}
                        onTerrain={(scenario, duration) => {
                          if (scenario) {
                            restoreVersion.current = undefined
                            setScenarios(previous =>
                              previous.map((s, i) =>
                                i === active
                                  ? scenario
                                  : { ...s, start: Math.min(s.start, 720 - 24 * (duration ?? days)) },
                              ) as [Scenario, Scenario],
                            )
                            setExperiment('custom')
                            setIndex(0)
                            setPlaying(false)
                          }
                          if (duration) setDays(duration)
                          setTab('Methods')
                          setView('chart')
                          setCompareOverlay(true)
                        }}
                      />
                    </div>
                    <div className="copilot-chips" aria-label="Quick scenario questions">
                      {QUICK_QUESTIONS.map(qq => (
                        <button key={qq} aria-pressed={question === qq} onClick={() => setQuestion(qq)}>
                          {qq}
                        </button>
                      ))}
                    </div>
                    <div className="copilot-input">
                      <Sparkles size={14} color="#1d4ed8" />
                      <input
                        type="text"
                        value={question}
                        aria-label="Ask a question about the current scenario comparison"
                        placeholder="Ask about coverage, kWh power, RF links, PSR ice, or launch delays…"
                        onChange={e => setQuestion(e.target.value)}
                      />
                    </div>
                    {groundedAnswer && (
                      <div className="copilot-answer">
                        <h3>{groundedAnswer.headline}</h3>
                        <p>{groundedAnswer.explanation}</p>
                        {groundedAnswer.caveats.map((c, idx) => (
                          <div className="copilot-caveat" key={idx}>
                            {c}
                          </div>
                        ))}
                        <table>
                          <thead>
                            <tr>
                              <th>Verified field</th>
                              <th>Baseline</th>
                              <th>Alternative</th>
                            </tr>
                          </thead>
                          <tbody>
                            {groundedAnswer.factsUsed.map(f => (
                              <tr key={f.label}>
                                <th>{f.label}</th>
                                <td>{f.baseline}</td>
                                <td>{f.alternative}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                        <div className="citation-list">
                          {groundedAnswer.citations.map(cit => (
                            <div className="citation-card" key={cit.id}>
                              <strong>{cit.title}</strong>
                              <span>{cit.citation}</span>
                              <a href={cit.url} target="_blank" rel="noreferrer">
                                {cit.url} <ArrowUpRight size={11} />
                              </a>
                            </div>
                          ))}
                        </div>
                      </div>
                    )}
                    <div className="record-chip" title="All numbers are rendered strictly from this deterministic comparison record.">
                      Record lock: {comparisonRecord.pairId}
                    </div>
                  </div>
                )}

                {tab === 'Power & Cost' && (
                  <div className="cost-panel">
                    <div className="mass-meter">
                      <div className="mass-meter-head">
                        <span>Baseline mass usage ({n(two![0].totalKg)} / {power.budgetKg} kg budget)</span>
                        <span>{n((two![0].totalKg / Math.max(1, power.budgetKg)) * 100, 0)}%</span>
                      </div>
                      <div className="mass-track">
                        <div style={{ width: `${Math.min(100, (power.hardwareKg / Math.max(1, power.budgetKg)) * 100)}%`, background: '#525760' }} title="Hardware mass" />
                        <div style={{ width: `${Math.min(100, (two![0].batteryKg / Math.max(1, power.budgetKg)) * 100)}%`, background: two![0].feasible ? '#0f6e49' : '#b91c1c' }} title="Battery mass" />
                      </div>
                    </div>
                    <div className="decision-controls">
                      {(
                        [
                          ['arrayW', 'Array peak (W)'],
                          ['loadW', 'Load (W)'],
                          ['specificWh', 'Battery (Wh/kg)'],
                          ['hardwareKg', 'Other hardware (kg)'],
                          ['budgetKg', 'Mass budget (kg)'],
                        ] as const
                      ).map(([key, label]) => (
                        <NumberField
                          key={key}
                          label={label}
                          min={key === 'specificWh' ? 1 : 0}
                          value={power[key]}
                          onChange={v => setPower({ ...power, [key]: v })}
                        />
                      ))}
                      <label>
                        Array orientation
                        <select value={arrayMode} onChange={e => setPower({ ...power, arrayMode: e.target.value as ArrayMode })}>
                          <option value="tracked">2-axis sun-tracking</option>
                          <option value="vertical">Vertical mast (cos el)</option>
                          <option value="horizontal">Horizontal deck (sin el)</option>
                        </select>
                      </label>
                    </div>
                    <table>
                      <thead>
                        <tr>
                          <th>Model output</th>
                          <th>Baseline</th>
                          <th>Alternative</th>
                        </tr>
                      </thead>
                      <tbody>
                        {(
                          [
                            ['usableWh', 'Usable storage (Wh)'],
                            ['batteryKg', 'Battery (kg)'],
                            ['totalKg', 'Installed mass (kg)'],
                            ['headroomKg', 'Payload headroom (kg)'],
                            ['unmetWh', 'Unmet load (Wh)'],
                          ] as const
                        ).map(([key, label]) => (
                          <tr key={key}>
                            <th scope="row">{label}</th>
                            {two!.map((x, i) => (
                              <td key={i}>{n(x[key])}</td>
                            ))}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                    <p>
                      {two?.every(x => x.feasible)
                        ? `Alternative installed mass delta: ${sign(-delta!)} kg`
                        : 'At least one scenario exceeds the modeled power or mass budget.'}
                    </p>
                    <div className="decision-controls">
                      {rates.map((r, i) => (
                        <label key={i}>
                          {['Low', 'Central', 'High'][i]} ($/kg)
                          <input
                            type="number"
                            min="0"
                            placeholder="Optional"
                            value={r}
                            onChange={e => {
                              if (e.target.value === '' || +e.target.value >= 0) {
                                setRates(rates.map((v, j) => (i === j ? e.target.value : v)))
                              }
                            }}
                          />
                        </label>
                      ))}
                      <NumberField label="Extra equipment cost ($)" min={-10000000} value={equipment} onChange={setEquipment} />
                    </div>
                    {two?.every(x => x.feasible) && (
                      <div className="cost-output">
                        {rates.map(
                          (r, i) =>
                            r !== '' && (
                              <p key={i}>
                                {['Low', 'Central', 'High'][i]} delivery cost avoided{' '}
                                <strong>{money.format(costTradeoff(delta!, equipment, +r).avoided!)}</strong>
                              </p>
                            ),
                        )}
                        {costTradeoff(delta!, equipment, null).breakEven !== null && (
                          <p>Break-even delivery rate {money.format(costTradeoff(delta!, equipment, null).breakEven!)} / kg</p>
                        )}
                      </div>
                    )}
                    <details className="decision-explanation" open={canCompareTwin}>
                      <summary>Two-pad power grid sensitivity</summary>
                      <p>Set two distinct pads at the same site and UTC start to model shared PV beaming or tethered power transfer.</p>
                      {twin && (
                        <>
                          <div className="decision-controls">
                            <NumberField label="Transfer cap (W)" value={transferW} onChange={setTransferW} />
                            <NumberField label="Transfer eff (%)" value={transferPct} max={100} onChange={setTransferPct} />
                            <NumberField label="Extra cable/relay (kg)" value={twinKg} onChange={setTwinKg} />
                          </div>
                          <p>
                            Unmet load avoided {sign(twin.avoidedUnmetWh)} Wh · installed mass change {sign(twin.installedMassDeltaKg)} kg.
                          </p>
                        </>
                      )}
                    </details>
                  </div>
                )}

                {tab === 'Methods' && (
                  <div className="methods-panel">
                    <h2>
                      {result.terrain
                        ? result.meta.regional
                          ? 'Regional 96 km LOLA horizon'
                          : 'Local 5.12 km LOLA horizon'
                        : result.liveTerrain
                          ? `Live 80 m LOLA horizon (${coveredCount(result.pad.coverage)}/360° covered)`
                          : `${name(scenarios[active].site)} level-horizon reference`}
                    </h2>
                    <p>
                      Observer {n(result.pad.coordinates[0], 4)}°, {n(result.pad.coordinates[1], 4)}° · {result.pad.mast} m mast · {sigma}σ uncertainty
                    </p>
                    <p>
                      Sun az {n(sky.sun.az, 2)}°, el {n(sky.sun.el, 2)}°, rim {n(sky.sunHorizon, 2)}°. Earth az {n(sky.earth.az, 2)}°, el{' '}
                      {n(sky.earth.el, 2)}°, rim {n(sky.earthHorizon, 2)}°.
                    </p>
                    <p>Terrain posting: 20 m local + 80 m regional LRO LOLA DEM. Solar disk integrates circular segment above straight rim bin.</p>
                    <button onClick={() => exportData('samples')}>Download five-minute samples (CSV)</button>
                    <p>
                      Window {utc(result.meta.start, 0)} to {utc(result.meta.start, 720)}. Ephemeris SHA-256 {result.meta.vectorHash.slice(0, 12)}.
                    </p>
                    {result.meta.regional && (result.terrain || result.liveTerrain) && (
                      <p>
                        48 km → 96 km sensitivity: longest darkness {n(result.report.referenceLongestDark)} → {n(result.report.longestDark)} h; Earth
                        blackout {n(result.report.referenceLongestEarth)} → {n(result.report.longestEarth)} h.
                      </p>
                    )}
                    {result.mastSensitivity.length > 0 && (
                      <table>
                        <thead>
                          <tr>
                            <th>Mast</th>
                            <th>Longest low light</th>
                            <th>Longest Earth blackout</th>
                          </tr>
                        </thead>
                        <tbody>
                          {result.mastSensitivity.map(x => (
                            <tr key={x.height}>
                              <th>{x.height} m</th>
                              <td>
                                {n(x.lowLight)} h<span>{requirement(x.lowLight, limits.dark, x.complete)}</span>
                              </td>
                              <td>
                                {n(x.earth)} h<span>{requirement(x.earth, limits.earth, x.complete)}</span>
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    )}
                    <details>
                      <summary>JPL DE440 & NAIF Kernel Provenance</summary>
                      <ul>
                        <li><a href="https://pgda.gsfc.nasa.gov/products/90" target="_blank" rel="noreferrer">NASA LOLA terrain archive</a></li>
                        <li><a href="https://ssd.jpl.nasa.gov/doc/de440_de441.html" target="_blank" rel="noreferrer">JPL DE440 ephemerides</a></li>
                        <li><a href={result.meta.station.source} target="_blank" rel="noreferrer">NAIF DSS-14 ITRF position</a></li>
                        <li><a href="https://www.nasa.gov/wp-content/uploads/2024/01/lunar-site-selection.pdf">NASA lunar site selection and mission constraints</a></li>
                        <li><a href="https://ntrs.nasa.gov/citations/20080045536">NASA polar illumination and energy storage analysis</a></li>
                        <li><a href="https://www.nasa.gov/wp-content/uploads/2024/01/lunar-communications-and-navigation-architecture.pdf">NASA lunar communications architecture</a></li>
                        {Object.entries(result.meta.kernels).map(([key, k]) => (
                          <li key={key}><a href={k.url} target="_blank" rel="noreferrer">{key}</a></li>
                        ))}
                      </ul>
                    </details>
                  </div>
                )}
                  </div>
                </section>
              </div>
            </div>

            {items!.some(x => !x.report.complete) && (
              <p className="mission-note">
                At least one scenario has incomplete regional horizon coverage (azimuth rays exited LDEM_80S). Affected windows are marked Preliminary.
              </p>
            )}

            <section className="mission-events">
              <div className="events-title">
                <div>
                  <h2>FIG. 02 · MISSION TIMELINE &amp; TELEMETRY</h2>
                  <p className="timeline-align-note">
                    Aligned by Mission Elapsed Time (0–{days}d) · Base {utc(start, scenarios[0].start).slice(5, 16)} vs Alt {utc(start, scenarios[1].start).slice(5, 16)} UTC
                  </p>
                  <div className="timeline-legend">
                    <span className="legend-dot"><i className="legend-swatch" style={{ background: '#d97706' }} /> Lit</span>
                    <span className="legend-dot"><i className="legend-swatch" style={{ background: '#2563eb' }} /> Earth clear</span>
                    <span className="legend-dot"><i className="legend-swatch" style={{ background: '#0f766e' }} /> 3-Complex DSN / DSS-14 open</span>
                    <span className="legend-dot"><i className="legend-swatch" style={{ background: '#2f333b' }} /> Shadow / obstructed</span>
                  </div>
                </div>
                <div className="events-controls">
                  <div className="segmented">
                    <button onClick={() => setIndex(i => Math.max(0, i - 72))}>−6h</button>
                    <button onClick={() => setIndex(i => Math.max(0, i - 12))}>−1h</button>
                    <button onClick={() => setPlaying(x => !x)}>
                      {playing ? <Pause size={12} /> : <Play size={12} />} {playing ? 'Pause' : 'Play'}
                    </button>
                    <button onClick={() => setIndex(i => Math.min(items![0].report.sky.length - 1, i + 12))}>+1h</button>
                    <button onClick={() => setIndex(i => Math.min(items![0].report.sky.length - 1, i + 72))}>+6h</button>
                  </div>
                  <button onClick={() => exportData('csv')}><Download size={13} /> Events</button>
                  <button onClick={() => exportData('json')}><Download size={13} /> Analysis</button>
                </div>
              </div>
              <Timeline
                items={items!}
                index={cursor}
                power={power}
                onIndex={(step, scenario) => {
                  setIndex(step)
                  if (scenario !== undefined) setActive(scenario)
                }}
              />
              <details>
                <summary>Event table</summary>
                <table>
                  <thead>
                    <tr>
                      <th>Scenario</th>
                      <th>Event</th>
                      <th>UTC start</th>
                      <th>Duration</th>
                    </tr>
                  </thead>
                  <tbody>
                    {items!.flatMap((x, i) =>
                      (['dark', 'earth', 'station'] as const).flatMap(key =>
                        x.report[key].map(e => (
                          <tr key={i + key + e.start}>
                            <td>{i ? 'Alternative' : 'Baseline'}</td>
                            <td>{{ dark: 'Low light', earth: 'Earth obstruction', station: 'DSS-14 opportunity' }[key]}</td>
                            <td>
                              <button
                                onClick={() => {
                                  setActive(i)
                                  setIndex(e.start)
                                }}
                              >
                                {utc(x.meta.start, scenarios[i].start + e.start / 12)}
                              </button>
                            </td>
                            <td>
                              {n(e.hours)} h {e.atStart ? '· underway at start ' : ''}
                              {e.atEnd ? '· reaches mission end' : ''}
                            </td>
                          </tr>
                        )),
                      ),
                    )}
                  </tbody>
                </table>
              </details>
            </section>
          </>
        )}
        {role !== 'Public' && <ReleaseCases />}
      </main>
    </div>
  )
}
