import { Fragment } from 'react'
import { ArrowLeftRight, Compass } from 'lucide-react'
import { findNearestPolarPad, names, polarSites, referenceSites } from './data'
import type { Limits, Power, Scenario } from './model'
import { coveredCount, n, name, sign, utc, type ComparisonRecord, type Result } from './missionHelpers'
import { NumberField } from './TelemetryCharts'

interface ScenarioBarProps {
  scenarios: [Scenario, Scenario]
  items: Result[] | null
  comparisonRecord: ComparisonRecord | null
  active: number
  setActive: (index: number) => void
  role: 'Planner' | 'Scientist' | 'Educator' | 'Public'
  days: number
  power: Power
  limits: Limits
  pending: boolean
  error: string
  start: string
  update: (index: number, patch: Partial<Scenario>) => void
  swapScenarios: () => void
  setNotice: (message: string) => void
  onRetry: () => void
}

export function ScenarioBar({
  scenarios,
  items,
  comparisonRecord,
  active,
  setActive,
  role,
  days,
  power,
  limits,
  pending,
  error,
  start,
  update,
  swapScenarios,
  setNotice,
  onRetry,
}: ScenarioBarProps) {
  return (
    <>
      <div className="comparison-strip" role="region" aria-label="Scenario comparison controls">
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
              <section
                aria-label={i ? 'Alternative' : 'Baseline'}
                className={active === i ? 'compare-pill selected' : 'compare-pill'}
                onClick={() => setActive(i)}
              >
                <div className="compare-pill-top">
                  <span className="compare-pill-idx">
                    <span className="mono-idx">{i ? '02' : '01'}</span> {i ? 'Alternative' : 'Baseline'}
                    {itemResult && (
                      <span className="scenario-grid-meta">
                        {' · '}
                        {isPolar
                          ? `96km #${s.node + 1}`
                          : itemResult?.liveTerrain
                            ? 'Live 80m LOLA'
                            : refInfo
                              ? refInfo.agency
                              : 'Level'}
                        {` · ${n(itemResult.pad.coordinates[0], 2)}°, ${n(itemResult.pad.coordinates[1], 2)}°`}
                      </span>
                    )}
                  </span>
                  {sideRecord && (
                    <span className={`status-pill status-${statusDot}`}>
                      {statusText}
                    </span>
                  )}
                </div>

                <div className="compare-pill-main" onClick={e => e.stopPropagation()}>
                  <select
                    aria-label={`${i ? 'Alternative' : 'Baseline'} site`}
                    className="inline-site-select"
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

                  <div className="inline-quick-controls">
                    {isPolar && role !== 'Public' && (
                      <>
                        <NumberField
                          className="inline-mini-field"
                          label="Pad"
                          min={1}
                          max={961}
                          value={s.node + 1}
                          onChange={v => update(i, { node: Math.min(960, Math.max(0, Math.round(v) - 1)) })}
                        />
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
                    <input
                      id={`start-utc-${i}`}
                      aria-label={`${i ? 'Alternative' : 'Baseline'} start UTC`}
                      className="inline-dt-input"
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
                    <div className="shift-inline">
                      {[-24, 24, 48].map(deltaH => (
                        <button
                          key={deltaH}
                          type="button"
                          className="inline-shift-btn"
                          title={`Shift ${deltaH > 0 ? '+' : ''}${deltaH}h`}
                          onClick={() => update(i, { start: Math.max(0, Math.min(720 - days * 24, s.start + deltaH)) })}
                        >
                          {deltaH > 0 ? `+${deltaH}h` : `${deltaH}h`}
                        </button>
                      ))}
                    </div>
                  </div>
                </div>

                {s.site === 'custom' && (
                  <div className="custom-actions" onClick={e => e.stopPropagation()}>
                    <NumberField
                      className="inline-mini-field"
                      label="Lat"
                      min={-90}
                      max={90}
                      decimal
                      value={s.customLat ?? -89.45}
                      onChange={v => update(i, { customLat: v })}
                    />
                    <NumberField
                      className="inline-mini-field"
                      label="Lon"
                      min={-180}
                      max={360}
                      decimal
                      value={s.customLon ?? -138.0}
                      onChange={v => update(i, { customLon: v })}
                    />
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
                      <Compass size={12} /> Snap to nearest LOLA pad
                    </button>
                  </div>
                )}

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

      {error && (
        <p role="alert" className="mission-note">
          <span>{error}</span> <button onClick={onRetry}>Retry</button>
        </p>
      )}
      {pending && (
        <div role="status" className="mission-loading-card" aria-live="polite">
          <div className="orbital-loader" aria-hidden="true">
            <div className="orbital-ring" />
            <div className="orbital-moon" />
          </div>
          <div className="mission-loading-text">
            <strong>Loading</strong>
            <span>Gathering and visualizing data…</span>
          </div>
        </div>
      )}
    </>
  )
}
