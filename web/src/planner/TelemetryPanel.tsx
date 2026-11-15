import { lazy, Suspense, useState } from 'react'
import { Download, Layers, Pause, Play } from 'lucide-react'
import { badgeClassForTier } from './confidence'
import { summarizeComparison } from './explain'
import { countdown, solarThreshold, type ArrayMode, type Limits, type Power, type Scenario } from './model'
import {
  buildConfidencePair,
  n,
  name,
  requirement,
  sign,
  statusClass,
  utc,
  type ComparisonRecord,
  type Result,
  type SearchResultState,
} from './missionHelpers'
import type { TerrainOverlay } from './terrainOverlay'
import { Hillshade, Horizon, LunarLocator, PolarSky, Timeline, NumberField, type TimelineEventSelection } from './TelemetryCharts'

const Scene = lazy(() => import('./SkyScene'))

const OVERLAY_OPTIONS: ReadonlyArray<{ id: TerrainOverlay; label: string }> = [
  { id: 'relief', label: 'Relief' },
  { id: 'viable', label: 'Geometry pass' },
  { id: 'illumination', label: 'Illumination' },
  { id: 'earth', label: 'Earth %' },
  { id: 'solar_hours', label: 'Solar %' },
  { id: 'slope', label: 'Slope <5°' },
  { id: 'psr', label: 'Mapped PSR' },
]

interface TelemetryPanelProps {
  items: Result[]
  result: Result
  scenarios: [Scenario, Scenario]
  active: number
  setActive: (index: number) => void
  comparisonRecord: ComparisonRecord
  view: 'orbit' | 'pad' | 'polar' | 'chart'
  setView: (view: 'orbit' | 'pad' | 'polar' | 'chart') => void
  overlay: TerrainOverlay
  setOverlay: (overlay: TerrainOverlay) => void
  compareOverlay: boolean
  setCompareOverlay: (fn: (prev: boolean) => boolean) => void
  look: 'sun' | 'earth' | 'north'
  setLook: (look: 'sun' | 'earth' | 'north') => void
  cursor: number
  setIndex: (fn: number | ((prev: number) => number)) => void
  playing: boolean
  setPlaying: (fn: (prev: boolean) => boolean) => void
  hoverAz: number | null
  setHoverAz: (az: number | null) => void
  canRender3D: boolean
  secondaryNode: number | null
  alignMode: 'met' | 'utc'
  setAlignMode: (mode: 'met' | 'utc') => void
  days: number
  setDays: (days: number) => void
  limits: Limits
  setLimits: (limits: Limits) => void
  power: Power
  setPower: (power: Power) => void
  sigma: number
  arrayMode: ArrayMode
  start: string
  search: SearchResultState | null
  update: (index: number, patch: Partial<Scenario>) => void
  setScenarios: (fn: (prev: [Scenario, Scenario]) => [Scenario, Scenario]) => void
  onClearSearch: () => void
  onInspectWorstBlackout: (metric: 'sun' | 'earth') => void
  onExport: (format: 'json' | 'csv' | 'samples') => void
}

export function TelemetryPanel({
  items,
  result,
  scenarios,
  active,
  setActive,
  comparisonRecord,
  view,
  setView,
  overlay,
  setOverlay,
  compareOverlay,
  setCompareOverlay,
  look,
  setLook,
  cursor,
  setIndex,
  playing,
  setPlaying,
  hoverAz,
  setHoverAz,
  canRender3D,
  secondaryNode,
  alignMode,
  setAlignMode,
  days,
  setDays,
  limits,
  setLimits,
  power,
  setPower,
  sigma,
  arrayMode,
  start,
  search,
  update,
  setScenarios,
  onClearSearch,
  onInspectWorstBlackout,
  onExport,
}: TelemetryPanelProps) {
  const [selectedEvent, setSelectedEvent] = useState<TimelineEventSelection | null>(null)
  const [showExtraTracks, setShowExtraTracks] = useState(false)
  const alt = comparisonRecord.alternative
  const failingGeometry = [
    alt.longestDark > limits.dark ? 'low light' : null,
    alt.longestEarth > limits.earth ? 'Earth obstruction' : null,
    alt.slopeDeg != null && alt.slopeDeg > limits.slope ? 'coarse slope' : null,
  ].filter(Boolean)
  const sky = result.report.sky[cursor]
  if (!sky) return null

  const sunCD = countdown(result.report.sky.map(s => s.solar < solarThreshold), cursor, 1 / 12)
  const earthCD = countdown(result.report.sky.map(s => s.earthMargin <= 0), cursor, 1 / 12)
  const dsnCD = !result.report.dsnUnknownHours ? countdown(result.report.sky.map(s => !s.dsnAccess), cursor, 1 / 12) : null
  const two = items.map(x => x.report)
  const padIndex = scenarios[active].node

  return (
    <>
      {items.some(x => !x.report.complete) && (
        <p className="mission-note">
          At least one scenario has incomplete regional horizon coverage (azimuth rays exited LDEM_80S). Affected windows are marked Preliminary.
        </p>
      )}

      <div className="mission-workspace">
        <section id="lunar-sky" className="sky-panel" aria-label="Lunar sky" tabIndex={-1}>
          <div className="sky-toolbar">
            <div className="sky-toolbar-meta">
              <strong>
                {active ? 'Alternative · ' : 'Baseline · '}
                {name(scenarios[active].site)}
              </strong>
              <span className="sky-utc">
                MET +{n(cursor / 12, 1)}h · {utc(result.meta.start, scenarios[active].start + cursor / 12)}
              </span>
            </div>
            <div className="toolbar-controls">
              {(result.terrain || scenarios[active].site !== 'apollo-11') && (view === 'orbit' || view === 'chart') && (
                <div className="segmented segmented-wrap" aria-label="Terrain overlay">
                  {OVERLAY_OPTIONS.map(ov => (
                    <button key={ov.id} aria-pressed={overlay === ov.id} onClick={() => setOverlay(ov.id)}>
                      <Layers size={12} /> {ov.id === 'slope' ? 'Coarse slope' : ov.label}
                    </button>
                  ))}
                </div>
              )}
              {(view === 'polar' || view === 'chart') && (
                <button aria-pressed={compareOverlay} onClick={() => setCompareOverlay(x => !x)}>
                  Compare other scenario
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
                ? 'sky-chart sky-stage-paper' + (result.terrain ? '' : ' sky-chart-single')
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
                    node={padIndex}
                    secondaryNode={secondaryNode}
                    overlay={overlay}
                    sky={sky}
                    lngDeg={result.pad.coordinates[1]}
                    padViability={result.padViability}
                    padSolarPct={result.padSolarPct}
                    padEarthPct={result.padEarthPct}
                    hoverAz={hoverAz}
                    slopeLimit={limits.slope}
                    onSelect={node => update(active, { node })}
                  />
                )}
                <Horizon
                  items={items}
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
                items={items}
                active={active}
                index={cursor}
                compareOverlay={compareOverlay}
                sigma={sigma}
                hoverAz={hoverAz}
                onHoverAz={setHoverAz}
              />
            ) : (
              <Suspense
                fallback={
                  <div className="sky-loading-profile">
                    <Horizon items={items} active={active} index={cursor} compareOverlay={false} sigma={sigma} hoverAz={hoverAz} onHoverAz={setHoverAz} />
                    <p role="status">The horizon is ready. Loading the 3D terrain…</p>
                  </div>
                }
              >
                <Scene
                  site={result.terrain}
                  node={padIndex}
                  pad={result.pad}
                  sky={sky}
                  mode={view}
                  look={look}
                  overlay={overlay}
                  series={result.report.sky}
                  secondaryNode={secondaryNode}
                  padViability={result.padViability}
                  padSolarPct={result.padSolarPct}
                  padEarthPct={result.padEarthPct}
                  slopeLimit={limits.slope}
                />
              </Suspense>
            )}
            {view === 'orbit' && result.terrain && <LunarLocator coordinates={result.pad.coordinates} />}
          </div>

          {view === 'orbit' && result.terrain && <p className="sky-extent">Local 5.12 km relief · terrain skyline modeled within 96 km</p>}
          {view === 'pad' && look === 'earth' && (
            <p className="sky-extent sky-earth-caption">
              {earthCD ? (sky.earthMargin > 0 ? 'Earth center is above the modeled skyline' : 'Earth center is below the modeled skyline') : 'Earth visibility is unknown at this time'}
              {earthCD && <strong>{n(Math.abs(sky.earthMargin))}° {sky.earthMargin > 0 ? 'clearance' : 'below the skyline'}</strong>}
            </p>
          )}
          {(view === 'orbit' || view === 'chart') && overlay !== 'relief' && !result.terrain && scenarios[active].site !== 'apollo-11' && (
            <div className="viable-legend" role="status">
              <span>Loading 96 km LOLA terrain for {overlay} overlay…</span>
            </div>
          )}
          {(view === 'orbit' || view === 'chart') && overlay !== 'relief' && result.terrain && (
            <div className="viable-legend" role="status">
              {overlay === 'viable' && result.padViability && (
                <>
                  <span><i className="dot-good" /> Passes geometry limits ({result.padViability.filter(v => v === 2).length})</span>
                  <span><i className="dot-warn" /> Earth visibility fails ({result.padViability.filter(v => v === 1).length})</span>
                  <span><i className="dot-danger" /> Light, slope, or terrain coverage fails ({result.padViability.filter(v => v === 0).length})</span>
                  {result.padSolarPct && <strong>Active pad sun: {result.padSolarPct[padIndex]}%</strong>}
                </>
              )}
              {overlay === 'illumination' && (
                <>
                  <span><i className="dot-amber" /> Local light preview (Sun el {sign(sky.sun.el)}°, az {n(sky.sun.az, 0)}°)</span>
                  <span><i className="dot-shadow" /> Local terrain shadow</span>
                </>
              )}
              {overlay === 'earth' && (
                <>
                  <span><i className="dot-blue" /> Earth-center visibility: blue ≥70% · amber 30–69% · red &lt;30%</span>
                  {result.padEarthPct && <strong>Active pad Earth: {result.padEarthPct[padIndex]}%</strong>}
                </>
              )}
              {overlay === 'solar_hours' && (
                <>
                  <span><i className="dot-amber" /> At least 10% solar disk: yellow ≥75% · amber 45–74% · slate &lt;45%</span>
                  {result.padSolarPct && <strong>Active pad sun: {result.padSolarPct[padIndex]}%</strong>}
                </>
              )}
              {overlay === 'slope' && (
                <>
                  <span><i className="dot-good" /> Coarse slope ≤{n(limits.slope, 1)}°</span>
                  <span><i className="dot-danger" /> Above {n(limits.slope, 1)}° limit</span>
                </>
              )}
              {overlay === 'psr' && (
                <span><i className="dot-purple" /> Mapped permanently shadowed areas · shading does not establish ice</span>
              )}
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
            <div className="countdowns" aria-label="Live operational countdowns at selected time">
              <section>
                <span className="cd-label">
                  At +{n(cursor / 12)}h · Solar {sunCD.visible ? `${n(sky.solar * 100, 0)}% disk` : 'Low light'}
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
                  Elevation {sign(sky.sun.el)}° · Bearing {n(sky.sun.az)}° · Clearance {sign(sky.sunMargin)}° · {n(result.report.generation[cursor], 0)} W
                </small>
              </section>
              <section>
                <span className="cd-label">
                  Earth center · {earthCD.visible ? 'In view' : 'Obstructed'}
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
                  Elevation {sign(sky.earth.el)}° · Bearing {n(sky.earth.az)}° · Clearance {sign(sky.earthMargin)}°
                  {sky.obstructionM > 0 ? ` · Ridge ${n(sky.obstructionM / 1000)} km` : ''}
                </small>
              </section>
              <section>
                <span className="cd-label">
                  Station geometry (Earth-side mask ≥10°) · {!sky.dsnCovered ? 'Unknown' : sky.dsnAccess ? 'Open' : 'Blocked'}
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
                  {sky.dsnActiveStation ?? 'No station clears both masks'} · Max {n(sky.dsnMaxUp)}°
                </small>
              </section>
            </div>
          )}
        </section>

        <div className="inspector-column">
          <section className="mission-inspector" aria-label="Comparison details">
            <div className="tab-body">
              <div className="kpi-scope-head">
                <span>{days}-day window totals · Alternative (constant while scrubbing)</span>
                <span>Earth: modeled line of sight</span>
              </div>
              <div className="kpi-delta-grid" aria-label="Key trade-off deltas">
                <div className="kpi-delta-card">
                  <span>Longest low light</span>
                  <div className="kpi-delta-vals">
                    <strong>{n(two[1].longestDark)} h</strong>
                    <small className={two[1].longestDark === two[0].longestDark ? undefined : two[1].longestDark <= limits.dark ? 'delta-good' : 'delta-danger'}>
                      {two[1].longestDark === two[0].longestDark ? 'Unchanged' : `${sign(two[1].longestDark - two[0].longestDark)} h vs baseline`}
                    </small>
                  </div>
                </div>
                <div className="kpi-delta-card">
                  <span>Longest Earth obstruction</span>
                  <div className="kpi-delta-vals">
                    <strong>{n(two[1].longestEarth)} h</strong>
                    <small className={two[1].longestEarth <= limits.earth ? 'delta-good' : 'delta-danger'}>
                      {sign(two[1].longestEarth - two[0].longestEarth)} h vs Base
                    </small>
                  </div>
                </div>
                <div className="kpi-delta-card">
                  <span>Coarse slope</span>
                  <div className="kpi-delta-vals">
                    <strong>{alt.slopeDeg == null ? 'Unavailable' : `${n(alt.slopeDeg, 2)}°`}</strong>
                    {alt.slopeDeg != null && (
                      <small className={alt.slopeDeg <= limits.slope ? 'delta-good' : 'delta-danger'}>
                        Limit ≤ {n(limits.slope, 1)}°
                      </small>
                    )}
                  </div>
                </div>
                <div className="kpi-delta-card">
                  <span>Sunlit hours</span>
                  <div className="kpi-delta-vals">
                    <strong>{n(two[1].solarHours)} h</strong>
                    <small className={two[1].solarHours >= two[0].solarHours ? 'delta-good' : 'delta-warn'}>
                      {sign(two[1].solarHours - two[0].solarHours)} h vs Base
                    </small>
                  </div>
                </div>
                <div className="kpi-delta-card">
                  <span>Modeled station time</span>
                  <div className="kpi-delta-vals">
                    <strong>{n(two[1].dsnHours)} h</strong>
                    <small className={two[1].dsnHours >= two[0].dsnHours ? 'delta-good' : 'delta-warn'}>
                      {sign(two[1].dsnHours - two[0].dsnHours)} h vs Base
                    </small>
                  </div>
                </div>
              </div>
              <details className="tuning-drawer">
                <summary>
                  Full comparison ledger
                  <span>Verdict, confidence &amp; 9 metrics</span>
                </summary>
                <div className="verdict-copy">
                  <h3 className="verdict-headline">
                    {comparisonRecord.baseline.viable && comparisonRecord.alternative.viable
                      ? items[0].report.feasible && items[1].report.feasible
                        ? 'Both launch windows satisfy geometry and modeled power limits (screening only).'
                        : 'Both launch windows meet geometry limits, but modeled power or storage budget fails.'
                      : comparisonRecord.alternative.viable
                        ? items[1].report.feasible
                          ? 'The alternative passes the selected geometry and power limits.'
                          : 'Alternative window resolves terrain geometry, but modeled power or storage exceeds budget.'
                        : comparisonRecord.baseline.viable
                          ? items[0].report.feasible
                            ? 'Only the baseline passes the selected geometry and power limits.'
                            : 'Only the baseline passes geometry limits, but its modeled power or storage exceeds budget.'
                          : !alt.hasRegionalTerrain || !alt.complete
                            ? 'Terrain coverage is incomplete for the alternative.'
                            : failingGeometry.length
                              ? `Alternative exceeds the selected limits for ${failingGeometry.join(', ')}.`
                              : 'Review the comparison and modeled limits.'}
                  </h3>
                  <p>{summarizeComparison(comparisonRecord)}</p>
                  {items.length >= 2 && (() => {
                    const activeConf = buildConfidencePair(items, sigma, limits)[active === 0 ? 'baseline' : 'alternative']
                    return (
                      <div className="verdict-top-badges" aria-label="Scientific confidence classifications">
                        {activeConf.domains.map(dom => (
                          <span key={dom.id} className={`verdict-badge ${badgeClassForTier(dom.tier)}`} title={dom.reason}>
                            {dom.label}: {dom.tier}
                          </span>
                        ))}
                      </div>
                    )
                  })()}
                </div>
                <div className="verdict-actions">
                  <button type="button" onClick={() => onInspectWorstBlackout('earth')}>
                    Inspect Earth obstruction
                  </button>
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
                      <th scope="row">Longest low light<span>Max single interval &lt;10% solar disk</span></th>
                      {two.map((x, i) => {
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
                      {two.map((x, i) => {
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
                      {two.map((x, i) => (
                        <td key={i}>
                          {n(x.solarHours)} h<span>{n((x.solarHours / (days * 24)) * 100, 0)}% of window</span>
                        </td>
                      ))}
                    </tr>
                    <tr>
                      <th scope="row">Earth center visible</th>
                      {two.map((x, i) => (
                        <td key={i}>
                          {n(x.earthHours)} h<span>{n((x.earthHours / (days * 24)) * 100, 0)}% of window</span>
                        </td>
                      ))}
                    </tr>
                    <tr>
                      <th scope="row">NASA DSN (3-Complex)<span>Goldstone DSS-14 · Madrid DSS-63 · Canberra DSS-43</span></th>
                      {two.map((x, i) => (
                        <td key={i}>
                          {n(x.dsnHours)} h
                          <span>max blackout {n(x.longestDsnBlackout)} h · {n(x.dsnDisagreementHours)} h vs Earth center</span>
                        </td>
                      ))}
                    </tr>
                    <tr>
                      <th scope="row">Goldstone DSS-14 only</th>
                      {two.map((x, i) => (
                        <td key={i}>
                          {n(x.stationHours)} h
                          <span>{n(x.disagreementHours)} h vs Earth center{x.stationUnknownHours ? ` · ${n(x.stationUnknownHours)} h unknown` : ''}</span>
                        </td>
                      ))}
                    </tr>
                    <tr>
                      <th scope="row">Solar elevation range</th>
                      {two.map((x, i) => (
                        <td key={i}>
                          {sign(x.minSunEl)}° to {sign(x.maxSunEl)}°
                        </td>
                      ))}
                    </tr>
                    <tr>
                      <th scope="row">Earth elevation range</th>
                      {two.map((x, i) => (
                        <td key={i}>
                          {sign(x.minEarthEl)}° to {sign(x.maxEarthEl)}°
                        </td>
                      ))}
                    </tr>
                    <tr>
                      <th scope="row">Coarse slope &amp; PSR</th>
                      {two.map((x, i) => {
                        const req = requirement(x.slope, limits.slope)
                        return (
                          <td key={i}>
                            {x.slope == null ? '—' : n(x.slope) + '°'}
                            {items[i].terrain ? (x.psr ? ' · Mapped PSR' : ' · Non-PSR') : ''}
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
                  Mission constraints &amp; array geometry
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
                      <option value={3}>3σ height margin</option>
                    </select>
                  </label>
                  <NumberField
                    label="Low-light limit (h)"
                    max={360}
                    value={limits.dark}
                    onChange={dark => {
                      setLimits({ ...limits, dark })
                      onClearSearch()
                    }}
                  />
                  <NumberField
                    label="Earth obstruction limit (h)"
                    max={360}
                    value={limits.earth}
                    onChange={earth => {
                      setLimits({ ...limits, earth })
                      onClearSearch()
                    }}
                  />
                  <NumberField
                    label="Coarse slope limit (°)"
                    max={90}
                    value={limits.slope}
                    onChange={slope => {
                      setLimits({ ...limits, slope })
                      onClearSearch()
                    }}
                  />
                </div>
              </details>

              <details className="decision-explanation">
                <summary>Why lunar south-pole conditions are extreme</summary>
                <p>
                  The alternative shifts longest low light by <strong>{sign(two[1].longestDark - two[0].longestDark)} h</strong> and longest
                  Earth obstruction by <strong>{sign(two[1].longestEarth - two[0].longestEarth)} h</strong>.
                </p>
                <p>
                  Because the Moon has only a 1.54° axial tilt, the polar Sun skims the horizon ({sign(two[0].minSunEl)}° to{' '}
                  {sign(two[0].maxSunEl)}° here). A 50 m ridge casts multi-day shadows, and Earth’s ±6.5° libration swings DTE links above and below distant crater rims.
                </p>
              </details>
            </div>
          </section>
        </div>

        <section className="mission-events">
          <div className="events-title">
            <div>
              <h2>Mission Timeline</h2>
              <p className="timeline-align-note">
                {alignMode === 'met'
                  ? `Aligned by Mission Elapsed Time (0–${days}d) · Base ${utc(start, scenarios[0].start).slice(5, 16)} vs Alt ${utc(start, scenarios[1].start).slice(5, 16)} UTC`
                  : `Aligned by Calendar UTC · Shows launch offset (${scenarios[1].start - scenarios[0].start >= 0 ? '+' : ''}${scenarios[1].start - scenarios[0].start}h)`}
              </p>
              <div className="timeline-legend">
                <span className="legend-dot"><i className="legend-swatch" style={{ background: '#d97706' }} /> Lit</span>
                <span className="legend-dot"><i className="legend-swatch" style={{ background: '#2563eb' }} /> Earth clear (LoS)</span>
                {showExtraTracks && <span className="legend-dot"><i className="legend-swatch" style={{ background: '#0f766e' }} /> Modeled station geometry</span>}
                <span className="legend-dot"><i className="legend-swatch" style={{ background: '#2f333b' }} /> Shadow / obstructed</span>
              </div>
            </div>
            <div className="events-controls">
              <div className="segmented" role="group" aria-label="Timeline alignment mode">
                <button type="button" aria-pressed={alignMode === 'met'} onClick={() => setAlignMode('met')}>
                  Align at landing
                </button>
                <button type="button" aria-pressed={alignMode === 'utc'} onClick={() => setAlignMode('utc')}>
                  Align by UTC
                </button>
              </div>
              <div className="segmented" aria-label="Timeline playback controls">
                <button type="button" onClick={() => setIndex(i => Math.max(0, i - 72))}>−6h</button>
                <button type="button" onClick={() => setIndex(i => Math.max(0, i - 12))}>−1h</button>
                <button type="button" onClick={() => setPlaying(x => !x)}>
                  {playing ? <Pause size={12} /> : <Play size={12} />} {playing ? 'Pause' : 'Play'}
                </button>
                <button type="button" onClick={() => setIndex(i => Math.min(items[0].report.sky.length - 1, i + 12))}>+1h</button>
                <button type="button" onClick={() => setIndex(i => Math.min(items[0].report.sky.length - 1, i + 72))}>+6h</button>
              </div>
              <button type="button" aria-pressed={showExtraTracks} onClick={() => setShowExtraTracks(v => !v)}>{showExtraTracks ? 'Hide' : 'Show'} station and power tracks</button>
              <button type="button" onClick={() => onExport('csv')}><Download size={13} /> Events CSV</button>
              <button type="button" onClick={() => onExport('json')}><Download size={13} /> Analysis JSON</button>
            </div>
          </div>
          {selectedEvent && (
            <div className="timeline-selected-banner" role="status">
              <span>
                <strong>{selectedEvent.scenario ? '02 Alternative' : '01 Baseline'} · {selectedEvent.label}:</strong>{' '}
                {utc(start, scenarios[selectedEvent.scenario].start + selectedEvent.start / 12)} →{' '}
                {utc(start, scenarios[selectedEvent.scenario].start + selectedEvent.end / 12)} ({n(selectedEvent.hours)} h)
              </span>
              <button type="button" className="link-btn" onClick={() => setSelectedEvent(null)}>
                Clear
              </button>
            </div>
          )}
          <Timeline
            items={items}
            index={cursor}
            power={power}
            scenarios={scenarios}
            start={start}
            alignMode={alignMode}
            active={active}
            showExtraTracks={showExtraTracks}
            selectedEvent={selectedEvent}
            onSelectEvent={setSelectedEvent}
            onIndex={(step, scenario) => {
              setIndex(step)
              if (scenario !== undefined) setActive(scenario)
            }}
          />
          <details>
            <summary>Event list and UTC times</summary>
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
                {items.flatMap((x, i) =>
                  (['dark', 'earth', 'station', 'dsn', 'dsnBlackout', 'dsnUnknown'] as const).flatMap(key =>
                    x.report[key].map(e => (
                      <tr key={i + key + e.start}>
                        <td>{i ? 'Alternative' : 'Baseline'}</td>
                        <td>{{ dark: 'Low light', earth: 'Earth obstruction', station: 'Goldstone geometry open', dsn: 'Station geometry open', dsnBlackout: 'Station geometry obstructed', dsnUnknown: 'Station geometry unknown' }[key]}</td>
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
      </div>
    </>
  )
}
