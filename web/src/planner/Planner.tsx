import { lazy, Suspense, useEffect, useRef, useState } from 'react'
import { ArrowUpRight, Clock, Compass, Download, Globe2, Layers, Radio, Search, Share2, Sun } from 'lucide-react'
import type { SiteData } from '../types/helios'
import { findNearestPolarPad, names, padPixel, polarSites, referenceSites } from './data'
import { complementaryPower, costTradeoff, countdown, defaultPower, solarThreshold } from './model'
import type { ArrayMode, Limits, Metadata, Observer, Power, Report, Scenario } from './model'
import type { Request } from './planner.worker'
import type { TerrainOverlay } from './SkyScene'
import './planner.css'

const Scene = lazy(() => import('./SkyScene'))
const initial: [Scenario, Scenario] = [
  { site: 'shackleton-ridge', node: 480, start: 0, mast: 2 },
  { site: 'shackleton-ridge', node: 480, start: 48, mast: 2 },
]
type Result = {
  report: Report
  pad: Observer
  meta: Metadata
  terrain: SiteData | null
  mastSensitivity: { height: number; lowLight: number; earth: number; complete: boolean }[]
}
type Choice = { scenario: Scenario; slope: number; starts: number }
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
  if (
    s.customLat !== undefined &&
    (!Number.isFinite(s.customLat) || Math.abs(s.customLat) > 90)
  ) {
    return false
  }
  if (
    s.customLon !== undefined &&
    (!Number.isFinite(s.customLon) || Math.abs(s.customLon) > 360)
  ) {
    return false
  }
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
const utc = (epoch: string, hours: number) =>
  new Date(Date.parse(epoch) + hours * 3600000).toISOString().slice(0, 16).replace('T', ' ') + ' UTC'
const epoch = '2026-11-14T00:00:00Z'
const fingerprint = (x: Result) => [x.meta.vectorHash, x.meta.localHash, x.meta.regional?.regional ?? 'local'].join(':')

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
  try {
    const context = document.createElement('canvas').getContext('webgl2')
    context?.getExtension('WEBGL_lose_context')?.loseContext()
    return Boolean(context)
  } catch {
    return false
  }
}

function azTrackSegments(sky: Report['sky'], pick: (s: Report['sky'][number]) => { az: number; el: number }, xOf: (az: number) => number, yOf: (el: number) => number) {
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
}: {
  items: Result[]
  active: number
  index: number
  compareOverlay: boolean
  sigma: number
}) {
  const primary = items[active]
  const other = items[1 - active]
  const sky = primary.report.sky[index]
  const otherSky = other?.report.sky[index]
  const showAlt = compareOverlay && Boolean(other && otherSky)
  const horizons = [...primary.pad.horizon]
  if (primary.meta.regional && primary.terrain) horizons.push(...primary.pad.reference)
  if (showAlt) horizons.push(...other.pad.horizon)
  const elevations = [sky.sun.el, sky.earth.el]
  if (showAlt && otherSky) elevations.push(otherSky.sun.el, otherSky.earth.el)
  const low = Math.min(-8, ...elevations.map(v => v - 2), ...horizons)
  const high = Math.max(8, ...elevations.map(v => v + 2), ...horizons)
  const x = (az: number) => 40 + az * 1.45
  const y = (el: number) => 152 - (132 * (el - low)) / Math.max(1e-3, high - low)

  const linePts = Array.from({ length: 361 }, (_, i) => `${x(i).toFixed(1)},${y(primary.pad.horizon[i % 360]).toFixed(1)}`)
  const fillPts = [`40,${y(low).toFixed(1)}`, ...linePts, `562,${y(low).toFixed(1)}`].join(' ')
  const refLine =
    primary.terrain && primary.meta.regional
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

  return (
    <svg viewBox="0 0 595 190" role="img" aria-label="Sun and Earth positions and trajectories against terrain elevation by azimuth">
      <line x1="40" x2="562" y1={y(0)} y2={y(0)} stroke="#6e7785" strokeDasharray="4 5" />
      <text x="6" y={y(0) + 4}>0°</text>
      <text x="6" y={18}>{n(high, 0)}°</text>
      <text x="6" y={154}>{n(low, 0)}°</text>
      <polygon points={fillPts} fill="#1d2430" opacity="0.72" />
      {sigmaPolygon && <polygon points={sigmaPolygon} fill="#ffc36d" opacity="0.18" />}
      {refLine && <polyline points={refLine} fill="none" stroke="#7c8798" strokeWidth="1.1" strokeDasharray="2 3" />}
      {altLine && <polyline points={altLine} fill="none" stroke="#67e8f9" strokeWidth="1.3" strokeDasharray="5 3" opacity="0.85" />}
      <polyline points={linePts.join(' ')} fill="none" stroke="#e3e5e8" strokeWidth="1.7" />
      {sunTracks.map((pts, i) => (
        <polyline key={'st' + i} points={pts} fill="none" stroke="#ffc36d" strokeWidth="1.2" opacity="0.4" />
      ))}
      {earthTracks.map((pts, i) => (
        <polyline key={'et' + i} points={pts} fill="none" stroke="#8ec9ff" strokeWidth="1.2" opacity="0.45" />
      ))}
      {showAlt &&
        otherSky &&
        [
          ['Alt Sun', otherSky.sun, '#ffdca8'],
          ['Alt Earth', otherSky.earth, '#67e8f9'],
        ].map(([label, p, color]) => {
          const body = p as typeof sky.sun
          return (
            <g key={String(label)} fill="none" stroke={String(color)} strokeWidth="1.6">
              <circle cx={x(body.az)} cy={y(body.el)} r="4" />
              <text x={x(body.az)} y={y(body.el) + 14} textAnchor="middle" fill={String(color)} stroke="none" fontSize="10">
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
            <circle cx={x(body.az)} cy={y(body.el)} r="4.5" stroke="#0b1017" strokeWidth="1" />
            <text x={x(body.az)} y={y(body.el) - 9} textAnchor="middle">
              {String(label)}
            </text>
          </g>
        )
      })}
      {['N (0°)', 'E (90°)', 'S (180°)', 'W (270°)', 'N (360°)'].map((label, i) => (
        <text key={i} x={40 + i * 130.5} y="176" textAnchor="middle">
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
}: {
  items: Result[]
  active: number
  index: number
  compareOverlay: boolean
  sigma: number
}) {
  const primary = items[active]
  const other = items[1 - active]
  const sky = primary.report.sky[index]
  const otherSky = other?.report.sky[index]
  const showAlt = compareOverlay && Boolean(other && otherSky)
  const vals = [
    ...primary.pad.horizon.map(Math.abs),
    ...primary.report.sky.map(s => Math.abs(s.sun.el)),
    ...primary.report.sky.map(s => Math.abs(s.earth.el)),
  ]
  if (showAlt) vals.push(...other.pad.horizon.map(Math.abs))
  const span = Math.min(90, Math.max(15, ...vals))
  const cx = 165
  const cy = 158
  const r0 = 92
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

  return (
    <div className="polar-wrap">
      <svg viewBox="0 0 330 316" role="img" aria-label="360-degree polar sky dome showing Sun and Earth tracks relative to terrain horizon">
        {[r0 - scale, r0 - scale / 2, r0, r0 + scale].map((r, idx) => (
          <circle
            key={idx}
            cx={cx}
            cy={cy}
            r={r}
            fill="none"
            stroke={r === r0 ? '#6e7f96' : '#2a3342'}
            strokeDasharray={r === r0 ? undefined : '3 4'}
          />
        ))}
        <path d={`M${cx} ${cy - r0 - scale}V${cy + r0 + scale} M${cx - r0 - scale} ${cy}H${cx + r0 + scale}`} stroke="#263040" strokeDasharray="3 4" />
        {[
          ['N', cx, cy - r0 - scale - 8],
          ['E', cx + r0 + scale + 12, cy + 4],
          ['S', cx, cy + r0 + scale + 15],
          ['W', cx - r0 - scale - 13, cy + 4],
        ].map(([label, tx, ty]) => (
          <text key={String(label)} x={tx} y={ty} textAnchor="middle" fill="#cbd5e1" fontSize="12">
            {label}
          </text>
        ))}
        {primary.terrain && primary.meta.regional && (
          <polyline points={poly(primary.pad.reference)} fill="none" stroke="#7c8798" strokeWidth="1" strokeDasharray="2 3" />
        )}
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
            strokeWidth="1"
            strokeDasharray="2 2"
            opacity="0.65"
          />
        )}
        {showAlt && <polyline points={poly(other.pad.horizon)} fill="none" stroke="#67e8f9" strokeWidth="1.4" strokeDasharray="5 3" opacity="0.85" />}
        <polyline points={poly(primary.pad.horizon)} fill="#18202c" fillOpacity="0.45" stroke="#e3e5e8" strokeWidth="1.7" />
        <polyline points={track(primary.report.sky, s => s.sun)} fill="none" stroke="#ffc36d" strokeWidth="1.2" opacity="0.55" />
        <polyline points={track(primary.report.sky, s => s.earth)} fill="none" stroke="#8ec9ff" strokeWidth="1.3" opacity="0.65" />
        {showAlt && (
          <>
            <polyline points={track(other.report.sky, s => s.sun)} fill="none" stroke="#ffdca8" strokeWidth="1" strokeDasharray="2 3" opacity="0.5" />
            <polyline points={track(other.report.sky, s => s.earth)} fill="none" stroke="#67e8f9" strokeWidth="1" strokeDasharray="2 3" opacity="0.6" />
          </>
        )}
        <circle cx={dx} cy={dy} r="3" fill={sky.stationAccess ? '#a5b499' : '#64748b'} />
        <circle cx={sx} cy={sy} r="5" fill="#ffc36d" stroke="#0b1017" strokeWidth="1.5" />
        <circle cx={ex} cy={ey} r="4.5" fill="#8ec9ff" stroke="#0b1017" strokeWidth="1.5" />
        <text x={sx + 8} y={sy - 6} fill="#ffc36d" fontSize="11">Sun</text>
        <text x={ex + 8} y={ey + 12} fill="#8ec9ff" fontSize="11">Earth</text>
        {showAlt && otherSky && (
          <>
            <circle cx={pt(otherSky.sun.az, otherSky.sun.el)[0]} cy={pt(otherSky.sun.az, otherSky.sun.el)[1]} r="4" fill="none" stroke="#ffdca8" strokeWidth="1.5" />
            <circle cx={pt(otherSky.earth.az, otherSky.earth.el)[0]} cy={pt(otherSky.earth.az, otherSky.earth.el)[1]} r="4" fill="none" stroke="#67e8f9" strokeWidth="1.5" />
          </>
        )}
      </svg>
      <div className="polar-legend">
        <strong>360° Polar Sky Dome</strong>
        <p>Solid ring marks 0° level horizon; center is +{n(span, 0)}° zenith; outer ring is −{n(span, 0)}°.</p>
        <ul>
          <li><i style={{ background: '#e3e5e8' }} /> Active terrain skyline (96 km LOLA)</li>
          {primary.terrain && primary.meta.regional && <li><i style={{ background: '#7c8798' }} /> 48 km terrain sensitivity</li>}
          {showAlt && <li><i style={{ background: '#67e8f9' }} /> Alternative scenario skyline & bodies</li>}
          <li><i style={{ background: '#ffc36d' }} /> Sun path & current position ({sign(sky.sun.el)}°)</li>
          <li><i style={{ background: '#8ec9ff' }} /> Earth libration loop & current position ({sign(sky.earth.el)}°)</li>
          <li><i style={{ background: '#a5b499' }} /> Goldstone DSS-14 direction</li>
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
      <circle cx="38" cy="38" r="32" fill="#262d37" stroke="#aeb7c5" />
      <circle cx="38" cy="38" r="16" fill="none" stroke="#586474" />
      <path d="M6 38h64M38 6v64" stroke="#586474" />
      <circle cx={38 + 32 * Math.cos(phi) * Math.sin(lambda)} cy={38 - 32 * Math.cos(phi) * Math.cos(lambda)} r="3.5" fill="#ffc36d" />
      <text x="38" y="86" textAnchor="middle" fill="#cbd2dc" fontSize="9">
        {lat < 0 ? 'South view' : 'Lunar locator'}
      </text>
    </svg>
  )
}

function Hillshade({
  site,
  node,
  secondaryNode,
  overlay,
  onSelect,
}: {
  site: SiteData
  node: number
  secondaryNode?: number | null
  overlay: TerrainOverlay
  onSelect: (i: number) => void
}) {
  const canvas = useRef<HTMLCanvasElement>(null)
  useEffect(() => {
    const context = canvas.current?.getContext('2d')
    if (!context) return
    const im = context.createImageData(256, 256)
    for (let i = 0; i < 65536; i++) {
      const h = site.dem_elev
      const dx = h[Math.min(i + 1, 65535)] - h[Math.max(0, i - 1)]
      const dy = h[Math.min(i + 256, 65535)] - h[Math.max(0, i - 256)]
      const gray = Math.max(20, Math.min(245, 132 + 110 * (0.6 + dx / 70 + dy / 70) / Math.hypot(1, dx / 40, dy / 40)))
      let r = gray
      let g = gray
      let b = gray
      if (overlay === 'slope') {
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
    context.strokeStyle = '#8ec9ff'
    context.strokeRect(g.start_pixel, g.start_pixel, 30 * g.step_pixel, 30 * g.step_pixel)
    if (secondaryNode != null && secondaryNode !== node) {
      const sec = padPixel(site, secondaryNode)
      context.fillStyle = '#06b6d4'
      context.beginPath()
      context.arc(sec % 256, Math.floor(sec / 256), 4, 0, Math.PI * 2)
      context.fill()
    }
    const pixel = padPixel(site, node)
    context.fillStyle = '#ffc36d'
    context.beginPath()
    context.arc(pixel % 256, Math.floor(pixel / 256), 4.5, 0, Math.PI * 2)
    context.fill()
  }, [site, node, secondaryNode, overlay])
  return (
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
  return (
    <div className="mission-timeline">
      <label>
        Mission elapsed time <output>{n(index / 12)} h</output>
        <input type="range" min={0} max={count - 1} value={index} onChange={e => onIndex(+e.target.value)} />
      </label>
      {items.map(({ report }, j) => (
        <div key={j} className="timeline-group">
          <b>{j ? 'Alternative' : 'Baseline'}</b>
          {[
            { label: 'Solar exposure', events: report.dark, color: '#d8a458' },
            { label: 'Earth center', events: report.earth, color: '#79ace4' },
            { label: 'DSS-14 geometry', events: report.station, color: '#a5b499', available: true },
          ].map(track => (
            <div className="lane" key={track.label}>
              <span>{track.label}</span>
              <div className="lane-track" style={{ background: track.available ? '#30353d' : track.color }}>
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
            <span>PV generation</span>
            <svg viewBox="0 0 1000 24" preserveAspectRatio="none" aria-label={n(report.generation[index], 0) + ' watts at the cursor'} role="img">
              <polyline
                points={report.generation.map((v, i) => [(i * 1000) / count, 23 - (v / Math.max(1, power.arrayW)) * 21].join(',')).join(' ')}
                fill="none"
                stroke="#d8a458"
                vectorEffect="non-scaling-stroke"
              />
              <line x1={(index * 1000) / count} x2={(index * 1000) / count} y1={0} y2={24} stroke="white" vectorEffect="non-scaling-stroke" />
            </svg>
          </div>
          <div className="lane">
            <span>Battery charge</span>
            <svg viewBox="0 0 1000 24" preserveAspectRatio="none" aria-label="Battery charge trend" role="img">
              <polyline
                points={report.soc.map((v, i) => [(i * 1000) / count, 23 - v * 21].join(',')).join(' ')}
                fill="none"
                stroke="#a5b499"
                vectorEffect="non-scaling-stroke"
              />
              <line x1={(index * 1000) / count} x2={(index * 1000) / count} y1={0} y2={24} stroke="white" vectorEffect="non-scaling-stroke" />
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
  const [view, setView] = useState<'orbit' | 'pad' | 'polar' | 'chart'>(canRender3D ? 'orbit' : 'chart')
  const [overlay, setOverlay] = useState<TerrainOverlay>('relief')
  const [compareOverlay, setCompareOverlay] = useState(true)
  const [look, setLook] = useState<'sun' | 'earth' | 'north'>('sun')
  const [tab, setTab] = useState<'Decision' | 'Cost' | 'Methods'>('Decision')
  const [role, setRole] = useState<'Planner' | 'Scientist' | 'Educator' | 'Public'>('Planner')
  const [prediction, setPrediction] = useState('')
  const [playing, setPlaying] = useState(false)
  const [progress, setProgress] = useState('')
  const [search, setSearch] = useState<{ count: number; options: Choice[] } | null>(null)
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
    // Geometry and power do not depend on requirement thresholds.
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
  const other = items?.[1 - active]
  const cursor = Math.min(index, (result?.report.sky.length ?? 1) - 1)
  const sky = result?.report.sky[cursor]
  const start = result?.meta.start ?? epoch
  const sigma = power.sigma ?? 0
  const arrayMode = power.arrayMode ?? 'tracked'

  const sunCD = result ? countdown(result.report.sky.map(s => s.solar < solarThreshold), cursor, 1 / 12) : null
  const earthCD = result ? countdown(result.report.sky.map(s => s.earthMargin <= 0), cursor, 1 / 12) : null
  const dssCD = result ? countdown(result.report.sky.map(s => !s.stationAccess), cursor, 1 / 12) : null

  const update = (i: number, patch: Partial<Scenario>) => {
    restoreVersion.current = undefined
    setScenarios(previous => previous.map((s, j) => (j === i ? { ...s, ...patch } : s)) as [Scenario, Scenario])
  }

  const applyPreset = (
    nextScenarios: [Scenario, Scenario],
    options: { active?: number; tab?: 'Decision' | 'Cost' | 'Methods'; arrayMode?: ArrayMode; view?: 'orbit' | 'pad' | 'polar' | 'chart'; overlay?: TerrainOverlay } = {},
  ) => {
    restoreVersion.current = undefined
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
  const samePolarSite =
    polarSites.includes(scenarios[0].site) && scenarios[0].site === scenarios[1].site && scenarios[0].node !== scenarios[1].node
  const secondaryNode = samePolarSite ? scenarios[1 - active].node : null

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
              s.stationAccess,
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

  return (
    <div className="mission">
      <header className="mission-header">
        <div className="mission-brand">
          <Globe2 size={21} /> Umbra-X <span>Lunar Landing Site Navigator · DE440 & 96 km LOLA</span>
        </div>
        <nav aria-label="Audience">
          {(['Planner', 'Scientist', 'Educator', 'Public'] as const).map(r => (
            <button
              key={r}
              aria-pressed={role === r}
              onClick={() => {
                setRole(r)
                setTab(r === 'Scientist' ? 'Methods' : 'Decision')
                setActive(0)
                setPrediction('')
                if (r === 'Educator') {
                  applyPreset([{ site: 'apollo-11', node: 480, start: 0, mast: 2 }, initial[0]])
                } else if (r === 'Planner' && scenarios[0].site === 'apollo-11') {
                  applyPreset(initial)
                }
              }}
            >
              {r}
            </button>
          ))}
        </nav>
        <a href="?legacy=1">
          Experimental workstation <ArrowUpRight size={13} />
        </a>
      </header>
      <main className="mission-body">
        <div className="mission-title">
          <div>
            <h1>
              {role === 'Educator'
                ? 'Apollo vs. the Lunar South Pole'
                : role === 'Public'
                  ? 'Explore the Lunar Sky & Horizon'
                  : 'Compare Lunar Landing Scenarios'}
            </h1>
            <p>
              {role === 'Educator'
                ? 'Predict which site has the higher Sun or Earth, then scrub time to see why south-polar geometry changes solar array design.'
                : role === 'Public'
                  ? 'Follow the Sun and Earth from a landing site and watch how ridges cast multi-day shadows.'
                  : 'Evaluate 5-minute JPL DE440 Sun/Earth/DSS-14 visibility against 20 m local + 96 km regional LOLA terrain.'}
            </p>
          </div>
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
            <Share2 size={15} /> Share
          </button>
        </div>
        {notice && (
          <p className="mission-note" role="status">
            {notice} <button onClick={() => setNotice('')}>Dismiss</button>
          </p>
        )}

        <div className="preset-bar" aria-label="One-click mission scenarios">
          <span className="preset-label">Scenarios:</span>
          <button onClick={() => applyPreset(initial, { tab: 'Decision' })}>48h Launch Delay</button>
          <button
            onClick={() =>
              applyPreset(
                [
                  { site: 'shackleton-ridge', node: 480, start: 0, mast: 2 },
                  { site: 'shackleton-ridge', node: 481, start: 0, mast: 2 },
                ],
                { active: 0, tab: 'Decision', overlay: 'slope' },
              )
            }
          >
            140 m Ridge Shift
          </button>
          <button
            onClick={() =>
              applyPreset([initial[0], { site: 'mons-mouton', node: 565, start: 0, mast: 2 }], { active: 1, tab: 'Decision' })
            }
          >
            Shackleton vs. Mons Mouton
          </button>
          <button
            onClick={() =>
              applyPreset(
                [
                  { site: 'shackleton-ridge', node: 480, start: 0, mast: 2 },
                  { site: 'shackleton-ridge', node: 511, start: 0, mast: 2 },
                ],
                { active: 0, tab: 'Cost' },
              )
            }
          >
            Two-Pad Power Grid
          </button>
          <button
            onClick={() =>
              applyPreset([{ site: 'apollo-11', node: 480, start: 0, mast: 2 }, initial[0]], {
                active: 0,
                tab: 'Decision',
              })
            }
          >
            Apollo 11 vs. South Pole
          </button>
        </div>

        <div className="scenario-grid">
          {scenarios.map((s, i) => {
            const isPolar = polarSites.includes(s.site)
            const refInfo = referenceSites[s.site]
            const itemResult = items?.[i]
            return (
              <section key={i} aria-label={i ? 'Alternative' : 'Baseline'} className={active === i ? 'scenario selected' : 'scenario'}>
                <div className="scenario-header">
                  <button className="scenario-title" aria-pressed={active === i} onClick={() => setActive(i)}>
                    {i ? 'Alternative' : 'Baseline'}
                  </button>
                  <span className="scenario-badge">
                    {isPolar
                      ? `LOLA 20m / 96km · Pad #${s.node + 1}`
                      : refInfo
                        ? `${refInfo.agency} · Level horizon`
                        : 'Level horizon'}
                    {itemResult ? ` · ${n(itemResult.pad.coordinates[0], 2)}°, ${n(itemResult.pad.coordinates[1], 2)}°` : ''}
                  </span>
                </div>
                <div className={isPolar && role !== 'Public' || s.site === 'custom' ? 'scenario-fields' : 'scenario-fields two-cols'}>
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
                  <label>
                    Start (UTC)
                    <input
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
                  </label>
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
                              `Coordinate is ${n(match.distanceM / 1000, 1)} km from nearest LOLA tile (${name(match.site)}). Evaluating exact DE440 level horizon.`,
                            )
                          }
                        } catch (err) {
                          setNotice(err instanceof Error ? err.message : 'Unable to query polar tiles.')
                        }
                      }}
                    >
                      <Compass size={14} /> Snap to nearest LOLA pad
                    </button>
                    <span>Exact DE440 angles everywhere on the Moon; 20 m + 96 km LOLA horizon inside polar tiles.</span>
                  </div>
                )}
              </section>
            )
          })}
        </div>

        {error && (
          <p role="alert" className="mission-note">
            {error} <button onClick={() => setRetry(x => x + 1)}>Retry</button>
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
              <p>
                Baseline {n(items[0].report.sky[cursor].sun.el)}° · Alternative {n(items[1].report.sky[cursor].sun.el)}°. Try switching Solar Array
                Geometry to <strong>Horizontal Deck</strong> to see why Apollo thrives at noon while the South Pole needs a vertical mast!
              </p>
            )}
          </section>
        )}

        {result && sky && !pending && !error && (
          <>
            <div className="mission-workspace">
              <section className="sky-panel" aria-label="Lunar sky">
                <div className="sky-toolbar">
                  <div>
                    <strong>
                      {active ? 'Alternative: ' : 'Baseline: '}
                      {name(scenarios[active].site)}
                    </strong>
                    <span>{utc(result.meta.start, scenarios[active].start + cursor / 12)}</span>
                  </div>
                  <div className="toolbar-controls">
                    {result.terrain && (view === 'orbit' || view === 'chart') && (
                      <div className="sky-buttons" aria-label="Terrain overlay">
                        {(['relief', 'slope', 'psr'] as const).map(ov => (
                          <button key={ov} aria-pressed={overlay === ov} onClick={() => setOverlay(ov)}>
                            <Layers size={13} /> {{ relief: 'Relief', slope: 'Slope <5°', psr: 'Mapped PSR' }[ov]}
                          </button>
                        ))}
                      </div>
                    )}
                    {(view === 'polar' || view === 'chart') && (
                      <button aria-pressed={compareOverlay} onClick={() => setCompareOverlay(x => !x)}>
                        Overlay alternative
                      </button>
                    )}
                    <div className="sky-buttons">
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

                <div className={'sky-stage ' + (view === 'chart' ? 'sky-chart' : view === 'polar' ? 'sky-polar' : '')}>
                  {view === 'chart' ? (
                    <>
                      {result.terrain && (
                        <Hillshade
                          site={result.terrain}
                          node={scenarios[active].node}
                          secondaryNode={secondaryNode}
                          overlay={overlay}
                          onSelect={node => update(active, { node })}
                        />
                      )}
                      <Horizon items={items!} active={active} index={cursor} compareOverlay={compareOverlay} sigma={sigma} />
                    </>
                  ) : view === 'polar' ? (
                    <PolarSky items={items!} active={active} index={cursor} compareOverlay={compareOverlay} sigma={sigma} />
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
                      />
                    </Suspense>
                  )}
                  {view === 'orbit' && result.terrain && <LunarLocator coordinates={result.pad.coordinates} />}
                </div>

                {view === 'pad' && (
                  <div className="sky-caption">
                    <div className="sky-buttons" aria-label="Look direction">
                      {(['sun', 'earth', 'north'] as const).map(body => (
                        <button key={body} aria-pressed={look === body} onClick={() => setLook(body)}>
                          {{ sun: 'Look at Sun', earth: 'Look at Earth', north: 'Face north' }[body]}
                        </button>
                      ))}
                    </div>
                    <span>Drag to look around. Sky markers enlarged for readability.</span>
                  </div>
                )}

                {sunCD && earthCD && dssCD && (
                  <div className="countdown-strip" aria-label="Live operational countdowns">
                    <div className={sunCD.visible ? 'cd-card cd-good' : 'cd-card cd-warn'}>
                      <div className="cd-top">
                        <span><Sun size={14} /> Solar Power</span>
                        <b>{sunCD.visible ? `${n(sky.solar * 100, 0)}% disk` : 'Low light'}</b>
                      </div>
                      <strong>
                        {sunCD.visible
                          ? sunCD.persistsToEnd
                            ? `Lit to mission end (${n(sunCD.hoursRemaining)} h)`
                            : `${n(sunCD.hoursRemaining)} h until sunset`
                          : sunCD.persistsToEnd
                            ? `Dark to mission end (${n(sunCD.hoursRemaining)} h)`
                            : `${n(sunCD.hoursRemaining)} h until sunrise`}
                      </strong>
                      <small>
                        El {sign(sky.sun.el)}° · Az {n(sky.sun.az)}° · Clear {sign(sky.sunMargin)}° · {n(result.report.generation[cursor], 0)} W (
                        {n(sky.incidenceFactor * 100, 0)}% inc.)
                      </small>
                    </div>
                    <div className={earthCD.visible ? 'cd-card cd-good' : 'cd-card cd-warn'}>
                      <div className="cd-top">
                        <span><Radio size={14} /> Earth Direct-to-Earth</span>
                        <b>{earthCD.visible ? 'In view' : 'Obstructed'}</b>
                      </div>
                      <strong>
                        {earthCD.visible
                          ? earthCD.persistsToEnd
                            ? `Visible to end (${n(earthCD.hoursRemaining)} h)`
                            : `${n(earthCD.hoursRemaining)} h until Earthset`
                          : earthCD.persistsToEnd
                            ? `Blocked to end (${n(earthCD.hoursRemaining)} h)`
                            : `${n(earthCD.hoursRemaining)} h until Earthrise`}
                      </strong>
                      <small>
                        El {sign(sky.earth.el)}° · Az {n(sky.earth.az)}° · Clear {sign(sky.earthMargin)}°
                        {sky.obstructionM > 0 ? ` · Ridge ${n(sky.obstructionM / 1000)} km` : ''}
                      </small>
                    </div>
                    <div className={dssCD.visible ? 'cd-card cd-good' : 'cd-card cd-muted'}>
                      <div className="cd-top">
                        <span><Clock size={14} /> Goldstone DSS-14</span>
                        <b>{dssCD.visible ? 'Open' : 'Blocked'}</b>
                      </div>
                      <strong>
                        {dssCD.visible
                          ? dssCD.persistsToEnd
                            ? `Open to end (${n(dssCD.hoursRemaining)} h)`
                            : `${n(dssCD.hoursRemaining)} h until LOS`
                          : dssCD.persistsToEnd
                            ? `Blocked to end (${n(dssCD.hoursRemaining)} h)`
                            : `${n(dssCD.hoursRemaining)} h until AOS`}
                      </strong>
                      <small>
                        Station el {n(sky.stationUp)}° (≥10° mask) · Pad SoC {n(result.report.soc[cursor] * 100, 0)}%
                      </small>
                    </div>
                  </div>
                )}
              </section>

              <section className="mission-inspector" aria-label="Comparison details">
                <nav aria-label="Details">
                  {(['Decision', 'Cost', 'Methods'] as const).map(t => (
                    <button key={t} onClick={() => setTab(t)} aria-pressed={t === tab}>
                      {t}
                    </button>
                  ))}
                </nav>
                {tab === 'Decision' && (
                  <>
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
                            <select
                              value={arrayMode}
                              onChange={e => setPower({ ...power, arrayMode: e.target.value as ArrayMode })}
                            >
                              <option value="tracked">2-axis sun-tracking</option>
                              <option value="vertical">Vertical mast (cos el)</option>
                              <option value="horizontal">Horizontal deck (sin el)</option>
                            </select>
                          </label>
                          <label>
                            LOLA terrain uncertainty
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
                            label="Earth obstruction limit (h)"
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
                          <th scope="row">Longest low light</th>
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
                          <th scope="row">Longest Earth obstruction</th>
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
                          <th scope="row">DSS-14 geometry</th>
                          {two!.map((x, i) => (
                            <td key={i}>{n(x.stationHours)} h</td>
                          ))}
                        </tr>
                        <tr>
                          <th scope="row">Earth / DSS-14 disagreement</th>
                          {two!.map((x, i) => (
                            <td key={i}>{n(x.disagreementHours)} h</td>
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
                    <details className="decision-explanation" open={role === 'Educator' || role === 'Public'}>
                      <summary>Why lunar south-pole conditions are extreme</summary>
                      <p>
                        The alternative shifts longest low light by <strong>{sign(two![1].longestDark - two![0].longestDark)} h</strong> and longest
                        Earth obstruction by <strong>{sign(two![1].longestEarth - two![0].longestEarth)} h</strong>.
                      </p>
                      <p>
                        Because the Moon has no atmosphere and only a 1.54° axial tilt, the polar Sun skims the horizon ({sign(two![0].minSunEl)}° to{' '}
                        {sign(two![0].maxSunEl)}° here). A 50 m ridge casts multi-day shadows, horizontal solar panels suffer steep cosine losses, and
                        Earth’s ±6.5° libration wobble swings DTE links above and below distant crater rims.
                      </p>
                      <p>
                        <a href="https://pgda.gsfc.nasa.gov/products/90" target="_blank" rel="noreferrer">
                          NASA LOLA terrain
                        </a>{' '}
                        ·{' '}
                        <a href="https://ssd.jpl.nasa.gov/horizons/manual.html" target="_blank" rel="noreferrer">
                          JPL observer geometry
                        </a>
                      </p>
                    </details>
                    {role === 'Planner' && (
                      <div className="decision-actions">
                        <button
                          disabled={!searchReady || !!progress}
                          onClick={() => {
                            const id = (searchId.current = ++serial.current)
                            setProgress('Loading regional terrain…')
                            setSearch(null)
                            worker.current?.postMessage({
                              kind: 'search',
                              id,
                              days,
                              power,
                              limits,
                              mast: scenarios[active].mast,
                              version: result.meta.vectorHash,
                            } satisfies Request)
                          }}
                        >
                          <Search size={15} /> Find geometry alternatives (2,883 pads)
                        </button>
                        {progress && (
                          <>
                            <span role="status">{progress}</span>
                            <button
                              onClick={() => {
                                worker.current?.postMessage({ kind: 'cancel' })
                                searchId.current = 0
                                setProgress('')
                              }}
                            >
                              Cancel
                            </button>
                          </>
                        )}
                        {!searchReady && <p>Search requires a regional terrain bundle (select a polar site first).</p>}
                        {search && (
                          <div>
                            <p role="status">
                              {search.count
                                ? search.count + ' eligible pad/start pairs in both terrain profiles. Earliest option per pad shown.'
                                : 'No scenario meets all geometry limits in both terrain profiles.'}
                            </p>
                            {search.options.map(({ scenario: s, slope, starts }) => (
                              <button
                                key={s.site + s.node}
                                onClick={() => {
                                  update(1, s)
                                  setActive(1)
                                }}
                              >
                                {name(s.site)} / pad {s.node + 1} · {utc(start, s.start)} · {n(slope)}° · {starts} starts
                              </button>
                            ))}
                          </div>
                        )}
                      </div>
                    )}
                  </>
                )}
                {tab === 'Cost' && (
                  <div className="cost-panel">
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
                        ? `Alternative installed mass change: ${sign(-delta!)} kg`
                        : 'At least one scenario fails the modeled power or mass budget.'}
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
                      <NumberField label="Extra alternative cost ($)" min={-10000000} value={equipment} onChange={setEquipment} />
                    </div>
                    {two?.every(x => x.feasible) && (
                      <div className="cost-output">
                        {rates.map(
                          (r, i) =>
                            r !== '' && (
                              <p key={i}>
                                {['Low', 'Central', 'High'][i]} modeled cost avoided{' '}
                                <strong>{money.format(costTradeoff(delta!, equipment, +r).avoided!)}</strong>
                              </p>
                            ),
                        )}
                        {costTradeoff(delta!, equipment, null).breakEven !== null && (
                          <p>Break-even incremental rate {money.format(costTradeoff(delta!, equipment, null).breakEven!)} / kg</p>
                        )}
                      </div>
                    )}
                    <p>
                      Array mode: <strong>{arrayMode}</strong>. Full initial charge, 80% usable depth, 95% one-way efficiency and 300 W charge/discharge
                      limits.
                    </p>
                    <details className="decision-explanation" open={canCompareTwin}>
                      <summary>Two-pad power sensitivity</summary>
                      <p>
                        Set two distinct pads at the same site and UTC start. This assumes a transfer path and a shared primary load, with direct load
                        served before battery charging.
                      </p>
                      {twin && (
                        <>
                          <div className="decision-controls">
                            <NumberField label="Transfer cap (W)" value={transferW} onChange={setTransferW} />
                            <NumberField label="Transfer efficiency (%)" value={transferPct} max={100} onChange={setTransferPct} />
                            <NumberField label="Extra installed mass (kg)" value={twinKg} onChange={setTwinKg} />
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
                        : `${name(scenarios[active].site)} level-horizon reference`}
                    </h2>
                    <p>
                      Observer {n(result.pad.coordinates[0], 4)}°, {n(result.pad.coordinates[1], 4)}° · {result.pad.mast} m mast · {sigma}σ terrain
                      uncertainty
                    </p>
                    <p>
                      Sun azimuth {n(sky.sun.az, 2)}°, elevation {n(sky.sun.el, 2)}°, horizon {n(sky.sunHorizon, 2)}°. Earth azimuth {n(sky.earth.az, 2)}°,
                      elevation {n(sky.earth.el, 2)}°, horizon {n(sky.earthHorizon, 2)}°.
                    </p>
                    <p>
                      Terrain posting: 20 m local and 80 m regional where available. The solar disk calculation integrates the circular segment above a
                      locally straight horizon.
                    </p>
                    <button onClick={() => exportData('samples')}>Download five-minute samples</button>
                    <p>
                      Data coverage {utc(result.meta.start, 0)} to {utc(result.meta.start, 720)}. Ephemeris {result.meta.vectorHash.slice(0, 12)}.
                    </p>
                    <p>
                      Geometric DE440 Sun and Earth directions in {result.meta.frame}. Five-minute intervals use the sample at their start. Low light means
                      solar exposure below 10% of the disk. Earth visibility uses its center.
                    </p>
                    <p>
                      {result.meta.regional && result.terrain
                        ? 'Regional terrain radius ' +
                          result.meta.regional.radiusM / 1000 +
                          ' km. Total low-light difference versus ' +
                          result.meta.regional.comparisonRadiusM / 1000 +
                          ' km: ' +
                          sign(days * 24 - result.report.solarHours - result.report.referenceDark) +
                          ' h. Earth obstruction difference ' +
                          sign(days * 24 - result.report.earthHours - result.report.referenceEarth) +
                          ' h.'
                        : result.terrain
                          ? 'Terrain outside the 5.12 km tile is unavailable in this bundle.'
                          : (referenceSites[scenarios[active].site]?.note ?? 'Level lunar sphere horizon reference.')}
                    </p>
                    {result.meta.regional && result.terrain && (
                      <p>
                        48 km → 96 km longest low light: {n(result.report.referenceLongestDark)} → {n(result.report.longestDark)} h. Longest Earth
                        obstruction: {n(result.report.referenceLongestEarth)} → {n(result.report.longestEarth)} h.
                      </p>
                    )}
                    {result.mastSensitivity.length > 0 && (
                      <table>
                        <thead>
                          <tr>
                            <th>Mast</th>
                            <th>Longest low light</th>
                            <th>Longest Earth obstruction</th>
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
                    <p>
                      DSS-14 requires lunar terrain clearance and ≥{result.meta.station.maskDeg}° ground-side elevation. Station schedule and RF performance
                      are outside this model.
                    </p>
                    <ul>
                      <li>
                        <a href="https://pgda.gsfc.nasa.gov/products/90" target="_blank" rel="noreferrer">
                          NASA LOLA terrain
                        </a>
                      </li>
                      <li>
                        <a href="https://ssd.jpl.nasa.gov/doc/de440_de441.html" target="_blank" rel="noreferrer">
                          JPL DE440
                        </a>
                      </li>
                      <li>
                        <a href={result.meta.station.source} target="_blank" rel="noreferrer">
                          NAIF station position
                        </a>
                      </li>
                    </ul>
                    <details>
                      <summary>Kernel versions</summary>
                      <ul>
                        {Object.entries(result.meta.kernels).map(([key, k]) => (
                          <li key={key}>
                            <a href={k.url} target="_blank" rel="noreferrer">
                              {key}
                            </a>
                          </li>
                        ))}
                      </ul>
                    </details>
                  </div>
                )}
              </section>
            </div>
            {items!.some(x => !x.report.complete) && (
              <p className="mission-note">At least one scenario has incomplete regional horizon coverage. Treat affected windows as preliminary.</p>
            )}
            <section className="mission-events">
              <div className="events-title">
                <h2>Mission timeline</h2>
                <div>
                  <button onClick={() => setPlaying(x => !x)}>{playing ? 'Pause' : 'Play'}</button>
                  <button onClick={() => exportData('csv')}>
                    <Download size={15} /> Events
                  </button>
                  <button onClick={() => exportData('json')}>
                    <Download size={15} /> Analysis
                  </button>
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
      </main>
    </div>
  )
}
