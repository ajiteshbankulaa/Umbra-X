import { ArrowUpRight, Download } from 'lucide-react'
import { complementaryPower, costTradeoff, type ArrayMode, type Limits, type Power, type Report, type Scenario, type Sky } from './model'
import { coveredCount, money, n, name, requirement, sign, statusClass, utc, type Result } from './missionHelpers'
import { NumberField } from './TelemetryCharts'

interface PowerDrawerProps {
  two: Report[] | undefined
  delta: number | undefined
  power: Power
  setPower: (power: Power) => void
  arrayMode: ArrayMode
  rates: string[]
  setRates: (rates: string[]) => void
  equipment: number
  setEquipment: (val: number) => void
  canCompareTwin: boolean
  twin: ReturnType<typeof complementaryPower> | null
  transferW: number
  setTransferW: (w: number) => void
  transferPct: number
  setTransferPct: (pct: number) => void
  twinKg: number
  setTwinKg: (kg: number) => void
}

export function PowerDrawer({
  two,
  delta,
  power,
  setPower,
  arrayMode,
  rates,
  setRates,
  equipment,
  setEquipment,
  canCompareTwin,
  twin,
  transferW,
  setTransferW,
  transferPct,
  setTransferPct,
  twinKg,
  setTwinKg,
}: PowerDrawerProps) {
  return (
    <div className="side-dock-body">
      {!two ? (
        <div className="tool-card">
          <p className="tool-muted-note">Computing mission power and battery sizing…</p>
        </div>
      ) : (
        <>
          <div className="tool-card">
            <div className="mass-meter">
              <div className="mass-meter-head">
                <span>Baseline mass budget ({n(two[0].totalKg)} / {power.budgetKg} kg)</span>
                <strong>{n((two[0].totalKg / Math.max(1, power.budgetKg)) * 100, 0)}%</strong>
              </div>
              <div className="mass-track">
                <div style={{ width: `${Math.min(100, (power.hardwareKg / Math.max(1, power.budgetKg)) * 100)}%`, background: '#525760' }} title="Hardware mass" />
                <div style={{ width: `${Math.min(100, (two[0].batteryKg / Math.max(1, power.budgetKg)) * 100)}%`, background: two[0].feasible ? 'var(--accent)' : 'var(--danger-ink)' }} title="Battery mass" />
              </div>
            </div>
            <div className="tool-form-grid">
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
          </div>

          <div className="tool-card">
            <div className="tool-card-head">
              <strong>Storage &amp; Mass Ledger</strong>
              <span className={two.every(x => x.feasible) ? 'badge-meets' : 'badge-exceeds'}>
                {two.every(x => x.feasible) ? `Alt Δ ${sign(-delta!)} kg` : 'Budget exceeded'}
              </span>
            </div>
            <table className="tool-table">
              <thead>
                <tr>
                  <th>Metric</th>
                  <th>Base</th>
                  <th>Alt</th>
                </tr>
              </thead>
              <tbody>
                {(
                  [
                    ['usableWh', 'Usable storage (Wh)'],
                    ['batteryKg', 'Battery (kg)'],
                    ['totalKg', 'Installed mass (kg)'],
                    ['headroomKg', 'Headroom (kg)'],
                    ['unmetWh', 'Unmet load (Wh)'],
                  ] as const
                ).map(([key, label]) => (
                  <tr key={key}>
                    <th scope="row">{label}</th>
                    {two.map((x, i) => (
                      <td key={i}>{n(x[key])}</td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="tool-card">
            <div className="tool-card-head">
              <strong>Launch Delivery Trade-Off</strong>
            </div>
            <div className="tool-form-grid">
              {rates.map((r, i) => (
                <label key={i}>
                  {['Low', 'Central', 'High'][i]} ($/kg)
                  <input
                    type="text"
                    inputMode="numeric"
                    placeholder="Optional"
                    value={r}
                    onChange={e => {
                      const val = e.target.value
                      if (val === '' || (Number.isFinite(Number(val)) && Number(val) >= 0)) {
                        setRates(rates.map((v, j) => (i === j ? val : v)))
                      }
                    }}
                  />
                </label>
              ))}
              <NumberField label="Extra equipment ($)" min={-10000000} value={equipment} onChange={setEquipment} />
            </div>
            {two.every(x => x.feasible) && (
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
                  <p>Break-even rate {money.format(costTradeoff(delta!, equipment, null).breakEven!)} / kg</p>
                )}
              </div>
            )}
          </div>

          <div className="tool-card">
            <details className="tool-details" open={canCompareTwin}>
              <summary>Two-pad power grid sensitivity</summary>
              <p className="tool-muted-note">Set two distinct pads at the same site and UTC start to model shared PV beaming or tethered transfer.</p>
              {twin && (
                <>
                  <div className="tool-form-grid">
                    <NumberField label="Transfer cap (W)" value={transferW} onChange={setTransferW} />
                    <NumberField label="Transfer eff (%)" value={transferPct} max={100} onChange={setTransferPct} />
                    <NumberField label="Extra relay (kg)" value={twinKg} onChange={setTwinKg} />
                  </div>
                  <p className="tool-lead-text">
                    Unmet load avoided {sign(twin.avoidedUnmetWh)} Wh · mass Δ {sign(twin.installedMassDeltaKg)} kg
                  </p>
                </>
              )}
            </details>
          </div>
        </>
      )}
    </div>
  )
}

interface MethodsDrawerProps {
  result: Result | undefined
  sky: Sky | undefined
  scenarios: [Scenario, Scenario]
  active: number
  sigma: number
  limits: Limits
  onExportSamples: () => void
}

export function MethodsDrawer({
  result,
  sky,
  scenarios,
  active,
  sigma,
  limits,
  onExportSamples,
}: MethodsDrawerProps) {
  const sb = result?.meta.slopeBenchmark
  return (
    <div className="side-dock-body">
      {!result || !sky ? (
        <div className="tool-card">
          <p className="tool-muted-note">Loading terrain horizon &amp; ephemeris metadata…</p>
        </div>
      ) : (
        <>
          <div className="tool-card">
            <div className="tool-card-head">
              <strong>
                {result.terrain
                  ? result.meta.regional
                    ? 'Regional 96 km LOLA Horizon'
                    : 'Local 5.12 km LOLA Horizon'
                  : result.liveTerrain
                    ? `Live 80 m LOLA (${coveredCount(result.pad.coverage)}/360°)`
                    : `${name(scenarios[active].site)} Reference`}
              </strong>
            </div>
            <div className="tool-cand-metrics">
              <div><span>Lat</span><strong>{n(result.pad.coordinates[0], 3)}°</strong></div>
              <div><span>Lon</span><strong>{n(result.pad.coordinates[1], 3)}°</strong></div>
              <div><span>Mast</span><strong>{result.pad.mast} m</strong></div>
              <div><span>Error</span><strong>{sigma}σ</strong></div>
            </div>
            <table className="tool-table">
              <thead>
                <tr>
                  <th>Body</th>
                  <th>Azimuth</th>
                  <th>Elevation</th>
                  <th>Rim</th>
                </tr>
              </thead>
              <tbody>
                <tr>
                  <th scope="row">Sun</th>
                  <td>{n(sky.sun.az, 1)}°</td>
                  <td>{n(sky.sun.el, 2)}°</td>
                  <td>{n(sky.sunHorizon, 2)}°</td>
                </tr>
                <tr>
                  <th scope="row">Earth</th>
                  <td>{n(sky.earth.az, 1)}°</td>
                  <td>{n(sky.earth.el, 2)}°</td>
                  <td>{n(sky.earthHorizon, 2)}°</td>
                </tr>
              </tbody>
            </table>
            <p className="tool-muted-note">
              Model: {result.meta.ephemerisModel ?? 'DE440 apparent (LT+S)'} · Posting: 20 m local + 80 m regional LRO LOLA DEM.
            </p>
            <p className="tool-muted-note">
              {utc(result.meta.start, 0)} → {utc(result.meta.start, 720)} · SHA {result.meta.vectorHash.slice(0, 12)}
            </p>
            {sb && (
              <div className="tool-subcard">
                <strong>PGDA LOLA Slope Benchmark ({sb.sampleCount} pads)</strong>
                <p>
                  Median Δ {n(sb.medianAbsDiffDeg, 2)}° · p95 {n(sb.p95AbsDiffDeg, 2)}° · Pad #481: {n(sb.pad481DemDeg, 2)}° vs {n(sb.pad481LolaDeg, 2)}°
                </p>
              </div>
            )}
            {result.meta.regional && (result.terrain || result.liveTerrain) && (
              <div className="tool-subcard">
                <strong>48 km → 96 km Extent Sensitivity</strong>
                <p>
                  Darkness {n(result.report.referenceLongestDark)} → {n(result.report.longestDark)} h · Earth {n(result.report.referenceLongestEarth)} → {n(result.report.longestEarth)} h
                </p>
              </div>
            )}
            <button type="button" className="tool-cta-btn" onClick={onExportSamples}>
              <Download size={13} /> Download 5-minute Samples (CSV)
            </button>
          </div>

          {result.mastSensitivity.length > 0 && (
            <div className="tool-card">
              <div className="tool-card-head">
                <strong>Mast Height Sensitivity</strong>
              </div>
              <table className="tool-table">
                <thead>
                  <tr>
                    <th>Mast</th>
                    <th>Low light</th>
                    <th>Earth outage</th>
                  </tr>
                </thead>
                <tbody>
                  {result.mastSensitivity.map(x => (
                    <tr key={x.height}>
                      <th scope="row">{x.height} m</th>
                      <td>
                        {n(x.lowLight)} h <span className={statusClass(requirement(x.lowLight, limits.dark, x.complete))}>{requirement(x.lowLight, limits.dark, x.complete)}</span>
                      </td>
                      <td>
                        {n(x.earth)} h <span className={statusClass(requirement(x.earth, limits.earth, x.complete))}>{requirement(x.earth, limits.earth, x.complete)}</span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          <div className="tool-card">
            <div className="tool-card-head">
              <strong>JPL DE440 &amp; NAIF Provenance</strong>
            </div>
            <div className="agent-citations">
              <a href="https://pgda.gsfc.nasa.gov/products/90" target="_blank" rel="noreferrer">NASA LOLA terrain archive <ArrowUpRight size={10} /></a>
              <a href="https://ssd.jpl.nasa.gov/doc/de440_de441.html" target="_blank" rel="noreferrer">JPL DE440 ephemerides <ArrowUpRight size={10} /></a>
              <a href={result.meta.station.source} target="_blank" rel="noreferrer">NAIF DSS-14 ITRF position <ArrowUpRight size={10} /></a>
              <a href="https://www.nasa.gov/wp-content/uploads/2024/01/lunar-site-selection.pdf" target="_blank" rel="noreferrer">NASA lunar site selection &amp; constraints <ArrowUpRight size={10} /></a>
              <a href="https://ntrs.nasa.gov/citations/20080045536" target="_blank" rel="noreferrer">NASA polar illumination &amp; energy analysis <ArrowUpRight size={10} /></a>
              <a href="https://www.nasa.gov/wp-content/uploads/2024/01/lunar-communications-and-navigation-architecture.pdf" target="_blank" rel="noreferrer">NASA lunar communications architecture <ArrowUpRight size={10} /></a>
              {Object.entries(result.meta.kernels).map(([key, k]) => (
                <a key={key} href={k.url} target="_blank" rel="noreferrer">{key} <ArrowUpRight size={10} /></a>
              ))}
            </div>
          </div>
        </>
      )}
    </div>
  )
}
