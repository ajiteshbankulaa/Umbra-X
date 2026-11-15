import { useEffect, useMemo, useState } from 'react'
import { padPixel } from './data'
import type { Observer, Power, Report, Scenario } from './model'
import { azTrackSegments, coveredCount, n, requirement, sign, statusClass, utc, type Result } from './missionHelpers'
import { computeOverlayRgba, type TerrainOverlay } from './terrainOverlay'
import type { SiteData } from '../types/helios'

type ReleaseEvidence = {
  cases: {
    id: string
    title: string
    query: string
    expected: { lowLightHours: number; earthObstructionHours: number; requiredBatteryKg: number }[]
  }[]
  changes: { site: string; eligible: number; lost: number; gained: number }[]
}

export function ReleaseCases() {
  const [evidence, setEvidence] = useState<ReleaseEvidence | null>(null)
  const [failed, setFailed] = useState(false)
  useEffect(() => {
    let cancelled = false
    fetch(import.meta.env.BASE_URL + 'release-evidence.json')
      .then(response => {
        if (!response.ok) throw new Error('Evidence unavailable')
        return response.json()
      })
      .then(data => {
        if (!cancelled) setEvidence(data)
      })
      .catch(() => {
        if (!cancelled) setFailed(true)
      })
    return () => {
      cancelled = true
    }
  }, [])
  return (
    <section className="release-cases" aria-label="Release evidence">
      <h2>Reproduce a decision</h2>
      {failed && <p>Release evidence is unavailable.</p>}
      {evidence && (
        <>
          <ul>
            {evidence.cases.map(({ id, title, query, expected }) => (
              <li key={id}>
                <a href={query}>{title}</a>
                <span>
                  Earth obstruction {n(expected[0].earthObstructionHours)} to {n(expected[1].earthObstructionHours)} h · Battery{' '}
                  {n(expected[0].requiredBatteryKg)} to {n(expected[1].requiredBatteryKg)} kg
                </span>
              </li>
            ))}
          </ul>
          <p>
            {evidence.changes.reduce((total, site) => total + site.lost, 0)} previously eligible pad/start pairs fail after adding
            regional terrain samples near tile edges.
          </p>
          <div className="experiment-actions">
            <a href={import.meta.env.BASE_URL + 'release-evidence.json'}>Inputs, results and dataset hashes</a>
            <a href={import.meta.env.BASE_URL + 'release-timing.json'}>Five-minute vs. one-minute event checks</a>
          </div>
        </>
      )}
    </section>
  )
}

export function NumberField({
  label,
  value,
  onChange,
  min = 0,
  max = 10000000,
  decimal = false,
  className,
}: {
  label: string
  value: number
  onChange: (v: number) => void
  min?: number
  max?: number
  decimal?: boolean
  className?: string
}) {
  const [draft, setDraft] = useState(() => String(value))
  useEffect(() => {
    setDraft(String(value))
  }, [value])

  return (
    <label className={className}>
      <span>{label}</span>
      <input
        type="text"
        inputMode={decimal ? 'decimal' : 'numeric'}
        value={draft}
        onChange={e => {
          const next = e.target.value
          setDraft(next)
          if (next === '' || next === '-' || next === '.' || next === '-.') return
          const v = Number(next)
          if (Number.isFinite(v)) onChange(Math.min(max, Math.max(min, v)))
        }}
        onBlur={() => {
          const v = Number(draft)
          const clamped = Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : value
          setDraft(String(clamped))
          if (clamped !== value) onChange(clamped)
        }}
      />
    </label>
  )
}

export function Horizon({
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
          [active === 0 ? 'Alt Sun' : 'Base Sun', otherSky.sun, '#ffc36d'],
          [active === 0 ? 'Alt Earth' : 'Base Earth', otherSky.earth, '#8ec9ff'],
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

export function PolarSky({
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
          const sxp = ((e.clientX - rect.left) / rect.width) * 336
          const syp = ((e.clientY - rect.top) / rect.height) * 320
          const deg = (Math.atan2(sxp - cx, -(syp - cy)) * 180) / Math.PI
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
        <p>Solid ring marks 0° level horizon; center is the upper plot limit (+{n(span, 0)}°); outer ring is −{n(span, 0)}°.</p>
        <ul>
          <li><i style={{ background: '#ecebe6' }} /> Active terrain skyline (96 km LOLA)</li>
          {hasRegional && <li><i style={{ background: '#8e949f' }} /> 48 km terrain sensitivity</li>}
          {showAlt && <li><i style={{ background: '#8ec9ff' }} /> Other scenario skyline &amp; bodies</li>}
          <li><i style={{ background: '#ffc36d' }} /> Sun path &amp; position ({sign(sky.sun.el)}°)</li>
          <li><i style={{ background: '#60a5fa' }} /> Earth libration loop ({sign(sky.earth.el)}°)</li>
          <li><i style={{ background: '#34d399' }} /> Goldstone DSS-14 line of sight</li>
          {uncoveredCount > 0 && <li><i style={{ background: '#fbbf24' }} /> {uncoveredCount} azimuths clipped by 80°S edge</li>}
        </ul>
      </div>
    </div>
  )
}

export function LunarLocator({ coordinates }: { coordinates: Observer['coordinates'] }) {
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

export function Hillshade({
  site, node, secondaryNode, overlay, sky, lngDeg, padViability, padSolarPct, padEarthPct, hoverAz, slopeLimit, onSelect,
}: {
  site: SiteData
  node: number
  secondaryNode?: number | null
  overlay: TerrainOverlay
  sky?: Report['sky'][number]
  lngDeg?: number
  padViability?: Uint8Array
  padSolarPct?: Uint8Array
  padEarthPct?: Uint8Array
  hoverAz?: number | null
  slopeLimit: number
  onSelect: (i: number) => void
}) {
  const g = site.manifest.analysis_grid
  const mapSky = overlay === 'illumination' ? sky : undefined
  // Paint offscreen, then mount a single immutable image. The visible SVG owns the
  // pad markers and selection, so WebGL and the map never share a canvas context.
  const raster = useMemo(() => {
    const canvas = document.createElement('canvas')
    canvas.width = canvas.height = 256
    const context = canvas.getContext('2d')
    if (!context) return null
    const image = context.createImageData(256, 256)
    image.data.set(computeOverlayRgba({ site, overlay, sky: mapSky, lngDeg, padViability, padSolarPct, padEarthPct, slopeLimit, mode: 'hillshade' }))
    context.putImageData(image, 0, 0)
    return canvas.toDataURL('image/png')
  }, [site, overlay, mapSky, lngDeg, padViability, padSolarPct, padEarthPct, slopeLimit])
  const pixel = padPixel(site, node)
  const x = pixel % 256
  const y = Math.floor(pixel / 256)
  const secondary = secondaryNode != null && secondaryNode !== node ? padPixel(site, secondaryNode) : null
  const az = hoverAz == null ? null : hoverAz * Math.PI / 180
  const clamp = (n: number, size: number) => Math.max(0, Math.min(size - 1, Math.round(n)))
  if (!raster) return <p className="hillshade-unavailable" role="status">Terrain map unavailable. Use the horizon chart or enter a pad number.</p>
  return (
    <div className="hillshade-frame">
      <div className="hillshade-meta"><span>LOLA relief · 5.12 km</span><span>Pad #{node + 1}</span></div>
      <svg className="hillshade-map" viewBox="0 0 256 256" role="img" tabIndex={0}
        aria-label={`Selectable lunar terrain map. Pad ${node + 1}. Use arrow keys to choose an adjacent pad.`}
        onKeyDown={e => {
          const step = { ArrowLeft: [0, -1], ArrowRight: [0, 1], ArrowUp: [-1, 0], ArrowDown: [1, 0] }[e.key]
          if (!step) return
          e.preventDefault()
          const row = clamp(Math.floor(node / g.cols) + step[0], g.rows)
          const col = clamp(node % g.cols + step[1], g.cols)
          const next = row * g.cols + col
          if (next !== node) onSelect(next)
        }}
        onClick={e => {
          const r = e.currentTarget.getBoundingClientRect()
          const row = clamp(((e.clientY - r.top) * 256 / r.height - g.start_pixel) / g.step_pixel, g.rows)
          const col = clamp(((e.clientX - r.left) * 256 / r.width - g.start_pixel) / g.step_pixel, g.cols)
          onSelect(row * g.cols + col)
        }}>
        <image href={raster} width="256" height="256" />
        <rect x={g.start_pixel} y={g.start_pixel} width={(g.cols - 1) * g.step_pixel} height={(g.rows - 1) * g.step_pixel} fill="none" stroke="#79a8d0" />
        {secondary !== null && <circle cx={secondary % 256} cy={Math.floor(secondary / 256)} r="4" fill="#8ec9ff" stroke="#111" />}
        {az !== null && <line x1={x} y1={y} x2={x + Math.sin(az) * 150} y2={y - Math.cos(az) * 150} stroke="#ffc36d" strokeWidth="1.4" strokeDasharray="4 3" />}
        <circle cx={x} cy={y} r="4.5" fill="#ffc36d" stroke="#251900" strokeWidth="1.2" />
      </svg>
    </div>
  )
}

export type TimelineEventSelection = {
  scenario: number
  key: 'dark' | 'earth' | 'dsn' | 'station'
  label: string
  start: number
  end: number
  hours: number
}

export function Timeline({
  items,
  index,
  onIndex,
  power,
  scenarios,
  start,
  alignMode = 'met',
  active = 0,
  showExtraTracks = false,
  selectedEvent,
  onSelectEvent,
}: {
  items: Result[]
  index: number
  onIndex: (i: number, scenario?: number) => void
  power: Power
  scenarios?: [Scenario, Scenario]
  start?: string
  alignMode?: 'met' | 'utc'
  active?: number
  showExtraTracks?: boolean
  selectedEvent?: TimelineEventSelection | null
  onSelectEvent?: (ev: TimelineEventSelection | null) => void
}) {
  const count = items[0].report.sky.length
  const totalDays = Math.max(1, Math.round(count / 288))
  const dayTicks = Array.from({ length: Math.min(6, totalDays + 1) }, (_, idx) =>
    Math.round((idx * totalDays) / Math.max(1, Math.min(5, totalDays))),
  )
  const useUtc = alignMode === 'utc' && Boolean(scenarios?.length)
  const minStartH = useUtc ? Math.min(...scenarios!.map(s => s.start)) : 0
  const maxEndH = useUtc ? Math.max(...scenarios!.map(s => s.start + count / 12)) : count / 12
  const spanH = Math.max(1, maxEndH - minStartH)
  const activeStart = scenarios?.[active]?.start ?? 0
  const cursorLabel = useUtc && start && scenarios
    ? `${utc(start, activeStart + index / 12)} · ${active === 0 ? 'Baseline' : 'Alternative'} +${n(index / 12)} h`
    : `Elapsed mission time (MET): +${n(index / 12)} h (Day ${n(index / 288, 2)})`

  return (
    <div className="mission-timeline">
      <label className="timeline-scrubber">
        <span className="timeline-scrubber-head">
          <span>
            <strong>{cursorLabel}</strong>
          </span>
          <output>Step {index + 1} / {count}</output>
        </span>
        <input type="range" min={0} max={count - 1} value={index} onChange={e => onIndex(+e.target.value)} />
      </label>
      <div className="timeline-axis" aria-hidden="true">
        <span />
        <div className="timeline-ticks">
          {useUtc && start
            ? Array.from({ length: 6 }, (_, idx) => minStartH + (spanH * idx) / 5).map((h, idx) => (
                <span key={idx}>{utc(start, h).slice(5, 11)}</span>
              ))
            : dayTicks.map((d, idx) => (
                <span key={idx}>Day {d}</span>
              ))}
        </div>
      </div>
      {items.map(({ report }, j) => {
        const scenarioStartH = useUtc && scenarios ? scenarios[j].start : 0
        const laneCursor = useUtc ? index + (activeStart - scenarioStartH) * 12 : index
        const cursorOnLane = laneCursor >= 0 && laneCursor < count
        const laneLeftPct = useUtc ? ((scenarioStartH - minStartH) / spanH) * 100 : 0
        const laneWidthPct = useUtc ? ((count / 12) / spanH) * 100 : 100
        return (
          <div key={j} className="timeline-group">
            <b>
              {j ? '02 / Alternative' : '01 / Baseline'}
              {scenarios ? ` (${scenarios[j].start >= 0 ? `T+${scenarios[j].start}h` : ''})` : ''}
            </b>
            {([
              { key: 'dark' as const, label: 'Solar exposure', events: report.dark, color: '#d97706', unknownHours: 0 },
              { key: 'earth' as const, label: 'Earth-center visibility', events: report.earth, color: '#2563eb', unknownHours: 0 },
              { key: 'dsn' as const, label: 'Three-station geometry', events: report.dsn, color: '#0f766e', available: true, unknownHours: report.dsnUnknownHours },
              { key: 'station' as const, label: 'Goldstone DSS-14 only', events: report.station, color: '#525760', available: true, unknownHours: report.stationUnknownHours },
            ]).filter(track => showExtraTracks || !track.available).map(track => (
              <div className="lane" key={track.key}>
                <span>{track.label}{track.available && track.unknownHours > 0 && ` (${n(track.unknownHours)} h unk)`}</span>
                <div className="lane-track lane-track-host">
                  <div
                    className="lane-track"
                    style={{
                      background: track.available ? '#0e1014' : track.color,
                      marginLeft: `${laneLeftPct}%`,
                      width: `${laneWidthPct}%`,
                    }}
                  >
                    {track.events.map(e => {
                      const isSelected =
                        selectedEvent?.scenario === j &&
                        selectedEvent.key === track.key &&
                        selectedEvent.start === e.start
                      return (
                        <button
                          key={e.start}
                          type="button"
                          className={`${track.available ? 'available' : 'outage'}${isSelected ? ' is-selected' : ''}`}
                          style={{ left: (e.start / count) * 100 + '%', width: Math.max(0.4, ((e.end - e.start) / count) * 100) + '%' }}
                          aria-label={track.label + ' ' + (track.available ? 'window' : 'obstruction') + ' at ' + n(e.start / 12) + ' hours, ' + n(e.hours) + ' hours long'}
                          onClick={() => {
                            onIndex(e.start, j)
                            onSelectEvent?.({
                              scenario: j,
                              key: track.key,
                              label: track.label,
                              start: e.start,
                              end: e.end,
                              hours: e.hours,
                            })
                          }}
                        />
                      )
                    })}
                    {cursorOnLane && <i style={{ left: (laneCursor / count) * 100 + '%' }} />}
                  </div>
                </div>
              </div>
            ))}
            {showExtraTracks && <><div className="lane">
              <span>PV generation{cursorOnLane ? ` (${n(report.generation[laneCursor], 0)} W)` : ''}</span>
              <div className="lane-track-host">
                <svg
                  style={{ marginLeft: `${laneLeftPct}%`, width: `${laneWidthPct}%` }}
                  viewBox="0 0 1000 24"
                  preserveAspectRatio="none"
                  aria-label={cursorOnLane ? n(report.generation[laneCursor], 0) + ' watts at the cursor' : 'PV generation trend'}
                  role="img"
                >
                  <polyline
                    points={report.generation.map((v, i) => [(i * 1000) / count, 23 - (v / Math.max(1, power.arrayW)) * 21].join(',')).join(' ')}
                    fill="none"
                    stroke="#ffc36d"
                    strokeWidth="1.5"
                    vectorEffect="non-scaling-stroke"
                  />
                  {cursorOnLane && <line x1={(laneCursor * 1000) / count} x2={(laneCursor * 1000) / count} y1={0} y2={24} stroke="#f87171" strokeWidth="1.5" vectorEffect="non-scaling-stroke" />}
                </svg>
              </div>
            </div>
            <div className="lane">
              <span>Battery charge{cursorOnLane ? ` (${n(report.soc[laneCursor] * 100, 0)}%)` : ''}</span>
              <div className="lane-track-host">
                <svg
                  style={{ marginLeft: `${laneLeftPct}%`, width: `${laneWidthPct}%` }}
                  viewBox="0 0 1000 24"
                  preserveAspectRatio="none"
                  aria-label="Battery charge trend"
                  role="img"
                >
                  <polyline
                    points={report.soc.map((v, i) => [(i * 1000) / count, 23 - v * 21].join(',')).join(' ')}
                    fill="none"
                    stroke="#34d399"
                    strokeWidth="1.5"
                    vectorEffect="non-scaling-stroke"
                  />
                  {cursorOnLane && <line x1={(laneCursor * 1000) / count} x2={(laneCursor * 1000) / count} y1={0} y2={24} stroke="#f87171" strokeWidth="1.5" vectorEffect="non-scaling-stroke" />}
                </svg>
              </div>
            </div></>}
          </div>
        )
      })}
    </div>
  )
}

export function RequirementStatusPill({ value, max, covered = true, reference }: { value: number | null; max: number; covered?: boolean; reference?: number }) {
  const req = requirement(value, max, covered, reference)
  return <span className={statusClass(req)}>{req}</span>
}
