import { memo } from 'react'
import type { SiteData, SiteEphemeris } from '../types/helios'
import type { Analysis, Track } from './model'
import { palette } from './TerrainViewport'

export const Tracks = memo(function Tracks({ tracks, hour }: { tracks: Track[]; hour: number }) {
  return <div className="tracks">{tracks.map(track => {
    const max = track.max ?? Math.max(.001, ...track.values)
    return <div className="track" key={track.label}>
      <span><i style={{ background: track.color }} />{track.label}</span>
      <svg viewBox="0 0 359 20" preserveAspectRatio="none" aria-hidden="true">
        <line x1={0} y1={19} x2={359} y2={19} stroke="#202a39" />
        {track.values.length > 0 && <polyline fill="none" vectorEffect="non-scaling-stroke" stroke={track.color}
          strokeWidth="1" points={track.values.map((v, i) => i + ',' + (19 - Math.min(1, v / max) * 17).toFixed(1)).join(' ')} />}
        <line x1={hour} y1={0} x2={hour} y2={20} stroke="#dce8fb" strokeOpacity=".65" />
      </svg>
      <output>{track.values.length ? track.values[hour].toFixed(track.unit === 'W/m²' ? 3 : 0) + ' ' + track.unit : '—'}</output>
    </div>
  })}</div>
})

export function HorizonRing({ ephemeris, site, analysis, mast, hour, delay }:
  { ephemeris: SiteEphemeris; site?: SiteData; analysis?: Analysis; mast: number; hour: number; delay: number }) {
  const active = delay + hour
  const span = Math.min(90, Math.max(10, ...ephemeris.earth_el_deg.map(Math.abs), ...ephemeris.sun_el_deg.map(Math.abs),
    ...(site && analysis ? Array.from({ length: 360 }, (_, az) =>
      Math.max(Math.abs(site.horizons[(analysis.primary * 5 + mast) * 360 + az]),
        analysis.network?.twin == null ? 0 : Math.abs(site.horizons[(analysis.network.twin * 5 + mast) * 360 + az]))) : [])))
  const point = (az: number, el: number) => {
    const r = 63 - 27 * Math.max(-1, Math.min(1, el / span))
    const a = az * Math.PI / 180
    return [110 + r * Math.sin(a), 108 - r * Math.cos(a)]
  }
  const path = (a: number[], e: number[]) => a.map((az, h) => point(az, e[h]).join(',')).join(' ')
  const horizon = (node: number) => Array.from({ length: 361 }, (_, az) => point(az, site!.horizons[(node * 5 + mast) * 360 + az % 360]).join(',')).join(' ')
  const markers = [
    { az: ephemeris.sun_az_deg, el: ephemeris.sun_el_deg, color: palette.gold, label: 'Sun' },
    { az: ephemeris.earth_az_deg, el: ephemeris.earth_el_deg, color: '#92c4ff', label: 'Earth' },
  ]
  return <div className="horizon-content">
    <svg className="horizon-ring" viewBox="0 0 220 215" role="img" aria-label="Polar horizon plot with Sun and Earth tracks. North is up.">
      {[36, 63, 90].map(r => <circle key={r} cx="110" cy="108" r={r} fill="none" stroke={r === 63 ? '#4b6079' : '#243245'}
        strokeDasharray={r === 63 ? undefined : '2 4'} />)}
      <path d="M110 18V198 M20 108H200" stroke="#222f40" strokeDasharray="2 4" />
      {[['N',110,13],['E',208,112],['S',110,211],['W',12,112]].map(([t,x,y]) =>
        <text key={t} x={x} y={y} textAnchor="middle" fill="#91a4bc" fontSize="10">{t}</text>)}
      {site && analysis && <polyline points={horizon(analysis.primary)} fill="none" stroke={palette.gold} strokeOpacity=".65" />}
      {site && analysis?.network?.twin != null && <polyline points={horizon(analysis.network.twin)} fill="none" stroke={palette.cyan} strokeOpacity=".65" />}
      {markers.map(({ az, el, color, label }) => {
        const [x,y] = point(az[active], el[active])
        return <g key={label}><polyline points={path(az.slice(delay, delay + 360), el.slice(delay, delay + 360))} fill="none"
          stroke={color} strokeDasharray="2 3" strokeOpacity=".75" />
          <circle cx={x} cy={y} r={4} fill={color} stroke="#06080d" strokeWidth="1.5"><title>{label}</title></circle></g>
      })}
    </svg>
    <div className="horizon-readouts">
      {markers.map(({az,el,color,label}) => <div key={label}><span style={{color}}>{label}</span>
        <strong>{el[active].toFixed(2)}°</strong><small>Az {az[active].toFixed(1)}°</small></div>)}
      <small>Solid ring = 0° elevation</small>
      {site && <small>Solid traces = terrain at A / B</small>}
    </div>
  </div>
}
