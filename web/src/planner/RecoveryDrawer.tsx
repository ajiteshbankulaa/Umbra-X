import { Download, Search } from 'lucide-react'
import type { Scenario } from './model'
import type { RecoveryCandidate, RobustnessPreference } from './recovery'
import { n, name, robustnessLabel, utc, type Choice, type ComparisonRecord, type SearchResultState } from './missionHelpers'
import { NumberField } from './TelemetryCharts'

interface RecoveryDrawerProps {
  recoveryScope: 'all-polar' | 'same-site'
  setRecoveryScope: (scope: 'all-polar' | 'same-site') => void
  recoveryRobustness: RobustnessPreference
  setRecoveryRobustness: (pref: RobustnessPreference) => void
  recoveryWindowFrom: number
  setRecoveryWindowFrom: (hours: number) => void
  recoveryWindowThrough: number
  setRecoveryWindowThrough: (hours: number) => void
  days: number
  start: string
  scenarios: [Scenario, Scenario]
  searchReady: boolean
  progress: string
  search: SearchResultState | null
  sortedSearchOptions: Choice[]
  searchSort: 'target' | 'dark' | 'earth' | 'slope' | 'starts'
  setSearchSort: (sort: 'target' | 'dark' | 'earth' | 'slope' | 'starts') => void
  showCertificate: boolean
  setShowCertificate: (fn: (prev: boolean) => boolean) => void
  appliedAltKey?: string | null
  currentResult: ComparisonRecord['alternative'] | null
  onRunSearch: () => void
  onCancelSearch: () => void
  onDownloadCertificate: () => void
  onApplyCandidate: (patch: Partial<Scenario>) => void
}

export function RecoveryDrawer({
  recoveryScope,
  setRecoveryScope,
  recoveryRobustness,
  setRecoveryRobustness,
  recoveryWindowFrom,
  setRecoveryWindowFrom,
  recoveryWindowThrough,
  setRecoveryWindowThrough,
  days,
  start,
  scenarios,
  searchReady,
  progress,
  search,
  sortedSearchOptions,
  searchSort,
  setSearchSort,
  showCertificate,
  setShowCertificate,
  appliedAltKey,
  currentResult,
  onRunSearch,
  onCancelSearch,
  onDownloadCertificate,
  onApplyCandidate,
}: RecoveryDrawerProps) {
  const maxWin = Math.max(0, 720 - days * 24)
  const rec = search?.recovery?.selection?.recommended
  const searched = search?.recovery?.certificate.problem.revised
  const current = scenarios[1]
  const previousRecord = Boolean(searched && (searched.site !== current.site || searched.node !== current.node || searched.start !== current.start || searched.mast !== current.mast))
  const currentAltKey = `${scenarios[1].site}:${scenarios[1].node}:${scenarios[1].start}`
  const isCandActive = (site: string, node: number, sStart: number) =>
    appliedAltKey === `${site}:${node}:${sStart}` || currentAltKey === `${site}:${node}:${sStart}`
  return (
    <div className="side-dock-body">
      <div className="tool-card">
        <div className="tool-form-grid">
          <label>
            Scope
            <select value={recoveryScope} onChange={e => setRecoveryScope(e.target.value as 'all-polar' | 'same-site')}>
              <option value="all-polar">All 3 Polar Regions</option>
              <option value="same-site">Revised Site Only ({name(scenarios[1].site)})</option>
            </select>
          </label>
          <label>
            Robustness
            <select value={recoveryRobustness} onChange={e => setRecoveryRobustness(e.target.value as RobustnessPreference)}>
              <option value="dual-extent-and-sigma">48/96 km + 2σ Error</option>
              <option value="dual-extent-48-96km">48/96 km Dual Extent</option>
              <option value="nominal-only">Nominal 96 km Only</option>
            </select>
          </label>
          <NumberField
            label="Earliest start (hours from catalog)"
            min={0}
            max={maxWin}
            value={recoveryWindowFrom}
            onChange={v => setRecoveryWindowFrom(Math.max(0, Math.round(v)))}
          />
          <NumberField
            label="Latest start (hours from catalog)"
            min={0}
            max={maxWin}
            value={Math.min(maxWin, recoveryWindowThrough)}
            onChange={v => setRecoveryWindowThrough(Math.max(0, Math.round(v)))}
          />
        </div>
        <button
          type="button"
          className="tool-cta-btn"
          disabled={!searchReady || !!progress}
          onClick={onRunSearch}
        >
          <Search size={13} /> Search {recoveryScope === 'same-site' ? 'this region' : '2,883 pads'}
        </button>
        <p className="tool-muted-note">
          {utc(start, Math.min(maxWin, recoveryWindowFrom))} through {utc(start, Math.min(maxWin, Math.max(recoveryWindowFrom, recoveryWindowThrough)))} · using Alternative mast
        </p>
        {progress && (
          <div className="tool-status-row" role="status">
            <span>{progress}</span>
            <button type="button" className="link-btn" onClick={onCancelSearch}>
              Cancel
            </button>
          </div>
        )}
        {!searchReady && <p className="tool-muted-note">Select terrain-backed polar sites for both plans to run this search.</p>}
      </div>

      {search && (
        <>
          {rec && (
            <div className="tool-card tool-recommended-card">
              <div className="tool-cand-top">
                <div>
                  <span className="tool-tag">Recommended Alternative</span>
                  <div><strong>{name(rec.site)} · Pad #{rec.pad}</strong></div>
                  <span className="tool-cand-date">{utc(start, rec.start)} (Δ{n(rec.displacementKm, 2)} km, {rec.scheduleShiftHours >= 0 ? '+' : ''}{rec.scheduleShiftHours}h)</span>
                </div>
                <button
                  type="button"
                  className={isCandActive(rec.site, rec.node, rec.start) ? 'tool-use-btn active' : 'tool-use-btn'}
                  onClick={() => onApplyCandidate({ site: rec.site, node: rec.node, start: rec.start, mast: rec.mast })}
                >
                  {isCandActive(rec.site, rec.node, rec.start) ? 'Applied as Alt ✓' : 'Use Alt'}
                </button>
              </div>
              <div className="tool-cand-badges">
                <span className={robustnessLabel(rec.robustness.classification).className}>
                  {robustnessLabel(rec.robustness.classification).label}
                </span>
                <span className="tool-muted-note">
                  Passes the tested terrain extents, height margin, and power assumptions.
                </span>
              </div>
              <div className="tool-cand-metrics">
                <div><span>Dark</span><strong>{n(rec.longestDark)}h</strong></div>
                <div><span>Earth</span><strong>{n(rec.longestEarth)}h</strong></div>
                <div><span>Slope</span><strong>{n(rec.slope ?? 0)}°</strong></div>
                <div><span>Batt</span><strong>{n(rec.batteryKg, 1)} kg</strong></div>
              </div>
            </div>
          )}

          <div className="tool-meta-banner" role="status">
            <strong>
              {search.count
                ? `${search.count.toLocaleString()} geometry-passing pairs`
                : 'No passing alternative found'}
            </strong>
            <span>
              {search.recovery ? `${search.recovery.selection.feasibleCount} power+geometry feasible · ${search.recovery.selection.paretoFrontier.length} Pareto` : ''}
              {search.elapsedMs != null ? ` · ${search.elapsedMs} ms (${search.engine})` : ''}
            </span>
            {search.recovery?.certificate.searchCoverage && (
              <small>
                Fully evaluated {search.recovery.certificate.searchCoverage.detailedCandidates} of {search.recovery.certificate.searchCoverage.representativeCandidates} representative pad/start pairs.
              </small>
            )}
          </div>

          {previousRecord && (
            <div className="tool-meta-banner" role="status">
              <strong>Current alternative · {name(current.site)} Pad #{current.node + 1}</strong>
              <span>{!currentResult ? 'Recalculating the applied pad…' : !currentResult.complete ? 'Terrain coverage is incomplete.' : currentResult.viable && currentResult.feasible ? 'Passes current modeled geometry and power limits.' : currentResult.viable ? 'Passes geometry; power or mass is outside the limit.' : 'Does not meet all current modeled geometry limits.'}</span>
              <small>The decision record below describes the earlier search input. Search again to generate a record for the current comparison.</small>
            </div>
          )}

          {search.recovery && (
            <div className="tool-card">
              {searched && <p className="tool-muted-note">Search input: {name(searched.site)} Pad #{searched.node + 1} · {utc(start, searched.start)}</p>}
              <div className="tool-card-head">
                <strong>{previousRecord ? 'Previous search decision record' : 'Search decision record'}</strong>
                <span className={search.recovery.diff.revisedAllOk ? 'badge-meets' : 'badge-exceeds'}>
                  {search.recovery.diff.statusCategory.replace(/_/g, ' ')}
                </span>
              </div>
              <div className="tool-btn-row">
                <button type="button" onClick={onDownloadCertificate}>
                  <Download size={12} /> Download record JSON
                </button>
                <button type="button" onClick={() => setShowCertificate(v => !v)}>
                  {showCertificate ? 'Hide' : 'Inspect'} record
                </button>
              </div>
              {showCertificate && (
                <div className="tool-subcard">
                  <strong>Fingerprint {search.recovery.certificate.deterministicFingerprint}</strong>
                  <p>
                    Run settings: {recoveryScope === 'same-site' ? `1 site (${name(scenarios[1].site)})` : '3 polar sites'} · Window{' '}
                    {recoveryWindowFrom}–{Math.min(maxWin, recoveryWindowThrough)}h ·{' '}
                    {recoveryRobustness} ·{' '}
                    {search.recovery.certificate.searchCoverage?.detailedCandidates ?? 64} full evals
                  </p>
                  <p>
                    {search.recovery.certificate.calculationVersion} · Ephemeris {search.recovery.certificate.ephemerisCoverage.startUtc} ({search.recovery.certificate.ephemerisCoverage.totalHours}h @ {search.recovery.certificate.ephemerisCoverage.stepMinutes}m) · Terrain {search.recovery.certificate.terrainCoverage.comparisonRadiusKm}/{search.recovery.certificate.terrainCoverage.nominalRadiusKm} km
                  </p>
                  <p>{search.recovery.explanation.notModeledNote}</p>
                </div>
              )}
              <p className="tool-lead-text">{search.recovery.explanation.headline}</p>
              <div className="tool-summary-lines">
                <p>{search.recovery.explanation.whatChanged}</p>
                <p>{search.recovery.explanation.samePadFinding}</p>
                <p>{search.recovery.explanation.alternativeFinding}</p>
                <p>{search.recovery.explanation.sensitivityNote}</p>
              </div>
            </div>
          )}

          {search.recovery && search.recovery.selection.paretoFrontier.length > 0 && (
            <div className="tool-section">
              <div className="tool-section-head">
                <strong>Best trade-offs from the shortlist</strong>
                <span>{search.recovery.selection.paretoFrontier.length} non-dominated</span>
              </div>
              <div className="tool-card-list">
                {search.recovery.selection.paretoFrontier.map((cand: RecoveryCandidate) => {
                  const rob = robustnessLabel(cand.robustness.classification)
                  const activeCand = isCandActive(cand.site, cand.node, cand.start)
                  return (
                    <div className="tool-candidate-card" key={`${cand.site}:${cand.node}:${cand.start}`}>
                      <div className="tool-cand-top">
                        <div>
                          <strong>{name(cand.site)} · Pad #{cand.pad}</strong>
                          <span className="tool-cand-date">{utc(start, cand.start)}</span>
                        </div>
                        <button
                          type="button"
                          className={activeCand ? 'tool-use-btn active' : 'tool-use-btn'}
                          onClick={() => onApplyCandidate({ site: cand.site, node: cand.node, start: cand.start, mast: cand.mast })}
                        >
                          {activeCand ? 'Applied ✓' : 'Use Alt'}
                        </button>
                      </div>
                      <div className="tool-cand-badges">
                        <span className={rob.className}>{rob.label}</span>
                        {cand.archetypes?.slice(0, 2).map(a => (
                          <span key={a} className="tool-tag">{a}</span>
                        ))}
                      </div>
                      <div className="tool-cand-metrics">
                        <div><span>Dark</span><strong>{n(cand.longestDark)}h</strong></div>
                        <div><span>Earth</span><strong>{n(cand.longestEarth)}h</strong></div>
                        <div><span>Slope</span><strong>{n(cand.slope ?? 0)}°</strong></div>
                        <div><span>Batt</span><strong>{n(cand.batteryKg, 1)} kg</strong></div>
                      </div>
                      <div className="tool-cand-foot">
                        <span>+{n(cand.headroomKg, 1)} kg headroom · Δ{n(cand.displacementKm, 1)} km ({cand.scheduleShiftHours >= 0 ? '+' : ''}{cand.scheduleShiftHours}h)</span>
                        <span>{cand.coordinates[0].toFixed(4)}°, {cand.coordinates[1].toFixed(4)}°</span>
                      </div>
                    </div>
                  )
                })}
              </div>
            </div>
          )}

          {search.recovery && search.recovery.selection.feasibleCount === 0 && search.recovery.selection.nearMisses.length > 0 && (
            <div className="tool-section">
              <div className="tool-section-head">
                <strong>Infeasible Near-Misses</strong>
                <span>Closest options</span>
              </div>
              <div className="tool-card-list">
                {search.recovery.selection.nearMisses.map((cand: RecoveryCandidate) => (
                  <div className="tool-candidate-card" key={`nm:${cand.site}:${cand.node}:${cand.start}`}>
                    <div className="tool-cand-top">
                      <div>
                        <strong>{name(cand.site)} · Pad #{cand.pad}</strong>
                        <span className="tool-cand-date">{utc(start, cand.start)}</span>
                      </div>
                      <button
                        type="button"
                        className="tool-use-btn"
                        onClick={() => onApplyCandidate({ site: cand.site, node: cand.node, start: cand.start, mast: cand.mast })}
                      >
                        Inspect
                      </button>
                    </div>
                    <div className="tool-cand-metrics">
                      <div><span>Dark</span><strong>{n(cand.longestDark)}h</strong></div>
                      <div><span>Earth</span><strong>{n(cand.longestEarth)}h</strong></div>
                      <div><span>Slope</span><strong>{n(cand.slope ?? 0)}°</strong></div>
                      <div><span>Unmet</span><strong>{cand.unmetWh.toFixed(0)} Wh</strong></div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {!!sortedSearchOptions.length && (
            <div className="tool-section">
              <div className="tool-section-head">
                <strong>All Geometry-Passing Pads</strong>
                <span>Top {Math.min(12, sortedSearchOptions.length)}</span>
              </div>
              <div className="pareto-sorts" role="group" aria-label="Rank all geometry-passing pads">
                {([
                  ['target', 'Same date'],
                  ['dark', 'Shortest low light'],
                  ['earth', 'Shortest Earth obstruction'],
                  ['slope', 'Flattest'],
                  ['starts', 'Most passing starts'],
                ] as const).map(([key, label]) => (
                  <button key={key} type="button" aria-pressed={searchSort === key} onClick={() => setSearchSort(key)}>
                    {label}
                  </button>
                ))}
              </div>
              <div className="tool-card-list">
                {sortedSearchOptions.slice(0, 12).map(({ scenario: s, slope, starts, targetStartMatch, longestDark, longestEarth, solarPct }) => (
                  <div className="tool-candidate-card" key={s.site + s.node}>
                    <div className="tool-cand-top">
                      <div>
                        <strong>
                          {name(s.site)} · Pad #{s.node + 1}
                          {targetStartMatch ? ' · Same start' : ''}
                        </strong>
                        <span className="tool-cand-date">{utc(start, s.start)}</span>
                      </div>
                      <button
                        type="button"
                        className="tool-use-btn"
                        onClick={() => onApplyCandidate(s)}
                      >
                        Use Alt
                      </button>
                    </div>
                    <div className="tool-cand-metrics">
                      <div><span>Dark</span><strong>{longestDark != null ? `${n(longestDark)}h` : '—'}</strong></div>
                      <div><span>Earth</span><strong>{longestEarth != null ? `${n(longestEarth)}h` : '—'}</strong></div>
                      <div><span>Sun</span><strong>{solarPct != null ? `${solarPct}%` : '—'}</strong></div>
                      <div><span>Slope</span><strong>{n(slope)}° · {starts} hourly starts</strong></div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </>
      )}
    </div>
  )
}
