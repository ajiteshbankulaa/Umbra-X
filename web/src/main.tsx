import { useDeferredValue, useEffect, useMemo, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { Activity, ArrowUpRight, BookOpen, ChevronDown, CircleHelp, Crosshair, Globe2, Layers, Pause, Play, Radio, Route, Satellite, Sun, X, Zap } from 'lucide-react'
import { candidatePixel, loadSite } from './data'
import { TerrainViewport, type Mode, type Overlay } from './workstation/TerrainViewport'
import { HorizonRing, Tracks } from './workstation/Telemetry'
import { analyze, sites, type Analysis, type Settings, type SiteId } from './workstation/model'
import type { SiteData, SiteEphemeris } from './types/helios'
import './style.css'

const overlays: [Overlay, string, string][] = [
  ['slope', 'Survival & slope safety', 'Green <5° · red ≥5°'],
  ['complement', 'Shadow complementarity', 'Cyan marks hours recovered when A is dark'],
  ['psr', 'PSR cold traps & radiosity', 'Violet marks LOLA-mapped permanent shadow'],
  ['plasma', 'Terminator field & dust', 'Amber intensity indicates modeled V/m'],
]
const demos = [
  { label: '01  IM-2 Athena post-mortem', site: 'mons-mouton', mode: 'static', overlay: 'slope',
    summary: 'Explore slope, battery depletion and terminator exposure near Athena using the selected forecast window. The proposed 74-hour freeze is a demo premise.' },
  { label: '02  $28M Light-to-Ice scenario', site: 'shackleton-ridge', mode: 'grid', overlay: 'complement',
    summary: 'Compare complementary sunlight, direct-to-Earth access and a feasible PSR link. $28M is the demo premise. Savings below are calculated.' },
  { label: '03  4D Shadow-Surfing', site: 'malapert-massif', mode: 'rover', overlay: 'plasma',
    summary: 'Follow a one-cell-per-hour route as shadows move. Residual darkness and plasma exposure are measured along the route.' },
  { label: '04  ShadowCam & plasma wake', site: 'malapert-massif', mode: 'grid', overlay: 'psr',
    summary: 'Inspect mapped permanent shadow and any calculated passive light windows, then switch to the terminator layer.' },
] as const
const roleCopy = {
  Planner: 'Find overlapping sunlight and direct-to-Earth windows before selecting a landing date.',
  Scientist: 'Inspect mapped PSRs, terrain horizons, and sensitivity to LOLA uncertainty.',
  Educator: 'Compare a south-pole site with Apollo 11 to show how latitude changes the Sun and Earth tracks.',
  Public: 'Follow the Sun and Earth around the lunar horizon, then play the timeline to see the terrain change.',
}
type Role = keyof typeof roleCopy
const promises = new Map<string, Promise<SiteData>>()
function sitePack(id: string) {
  const existing = promises.get(id)
  if (existing) return existing
  const promise = loadSite(id).catch(error => { promises.delete(id); throw error })
  promises.set(id, promise)
  return promise
}
const minus = '—'
const currency = (number: number) => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', notation: 'compact', maximumFractionDigits: 2 }).format(number)
const angle = (number: number) => (number > 0 ? '+' : '') + number.toFixed(2) + '°'

function App() {
  const initial = new URLSearchParams(location.search).get('site')
  const [id, setId] = useState<SiteId>(sites.find(site => site[0] === initial)?.[0] ?? 'shackleton-ridge')
  const [settings, setSettings] = useState<Settings>({ delay: 0, mast: 4, sigma: 0, node: 480, inventory: 0 })
  const deferred = useDeferredValue(settings)
  const [site, setSite] = useState<SiteData>()
  const [apollo, setApollo] = useState<SiteEphemeris>()
  const [error, setError] = useState('')
  const [hour, setHour] = useState(0)
  const [playing, setPlaying] = useState(false)
  const [speed, setSpeed] = useState(1)
  const [mode, setMode] = useState<Mode>('grid')
  const [overlay, setOverlay] = useState<Overlay>('slope')
  const [role, setRole] = useState<Role>('Planner')
  const [demo, setDemo] = useState<number | null>(null)
  const [modal, setModal] = useState<'compare' | 'research' | null>(null)
  const [retry, setRetry] = useState(0)
  const change = <K extends keyof Settings>(key: K, value: Settings[K]) => setSettings(previous => ({ ...previous, [key]: value }))
  const current = site?.manifest.site_id === id ? site : undefined

  useEffect(() => {
    let live = true
    setError('')
    if (id === 'apollo-11') {
      void loadApollo().then(value => { if (live) setApollo(value) }, reason => { if (live) setError(reason.message) })
    } else {
      void sitePack(id).then(value => { if (live) setSite(value) }, reason => { if (live) setError(reason.message) })
    }
    return () => { live = false }
  }, [id, retry])
  useEffect(() => {
    if (!playing) return
    const interval = globalThis.setInterval(() => setHour(value => (value + 1) % 360), 550 / speed)
    return () => globalThis.clearInterval(interval)
  }, [playing, speed])
  useEffect(() => {
    const url = new URL(location.href)
    url.searchParams.set('site', id)
    history.replaceState(null, '', url)
  }, [id])

  const result = useMemo(() => current && analyze(current, deferred), [current, deferred])
  const ephem = current?.manifest.ephemeris ?? (id === 'apollo-11' ? apollo : undefined)
  const active = deferred.delay + hour
  const activeMode = mode === 'static' ? 0 : mode === 'grid' ? 1 : 2
  const focusNode = result && (mode === 'rover' ? result.route?.path[hour] ?? result.primary : result.primary)
  const sample = result && focusNode !== undefined ? hour * result.window.nodeCount + focusNode : undefined
  const untilChange = (values: ArrayLike<number>, threshold: number) => {
    const visible = values[hour] >= threshold
    for (let next = hour + 1; next < 360; next++) if ((values[next] >= threshold) !== visible) return next - hour
    return null
  }
  const sunChange = result && focusNode !== undefined && untilChange(
    Array.from({ length: 360 }, (_, t) => result.window.solarFraction[t * result.window.nodeCount + focusNode]), .1)
  const earthChange = result && focusNode !== undefined && untilChange(
    Array.from({ length: 360 }, (_, t) => result.window.earthVisible[t * result.window.nodeCount + focusNode]), .5)
  const displayName = sites.find(row => row[0] === id)![1]
  const moonTrek = current?.manifest.moon_trek_url ?? 'https://trek.nasa.gov/moon/'
  function select(next: SiteId, preserveHour = false) {
    setId(next); change('node', 480); if (!preserveHour) setHour(0)
    setPlaying(false); setDemo(null); setError('')
  }
  function audience(value: Role) {
    setRole(value)
    setDemo(null)
    if (value === 'Scientist') { setOverlay('psr'); setMode('grid') }
    if (value === 'Educator') { select('apollo-11'); setMode('static') }
    if (value === 'Public') { if (id === 'apollo-11') select('shackleton-ridge'); setMode('static'); setOverlay('slope') }
  }
  function guided(index: number) {
    const preset = demos[index]
    setRole('Planner')
    select(preset.site)
    setDemo(index); setMode(preset.mode); setOverlay(preset.overlay)
    setSettings({ delay: index === 0 ? 360 : index === 1 ? 180 : 0, mast: index === 0 ? 0 : 4,
      sigma: index === 0 ? 1 : 0, node: index === 1 ? 23 : index === 3 ? 4 : 480, inventory: index === 1 ? 142 : 0 })
    setHour(index === 0 ? 280 : 0)
  }
  return <main className="workstation" data-role={role.toLowerCase()}>
    <header className="command">
      <div className="identity"><div className="mark"><Satellite size={20} /></div><div><h1>UMBRA<span>–</span>X</h1><p>Lunar mission workstation</p></div></div>
      <label className="site-select"><Globe2 size={15} /><select aria-label="Landing site" value={id} onChange={e => select(e.target.value as SiteId)}>
        {sites.map(([slug, name, mission]) => <option key={slug} value={slug}>{name} [{mission}]</option>)}
      </select><ChevronDown size={13} /></label>
      <button className="compare-button" onClick={() => setModal('compare')}><Layers size={15} />Compare all sites</button>
      <div className="command-end">
        <button onClick={() => setModal('research')} title="Research Citations, Physics & VC Roadmap"><BookOpen size={15} /><span>Research & roadmap</span></button>
        <a href={moonTrek} target="_blank" rel="noreferrer">Open in NASA Moon Trek <ArrowUpRight size={14} /></a>
      </div>
    </header>
    <nav className="context-bar" aria-label="Workstation context">
      <div className="roles" aria-label="Audience view">{(Object.keys(roleCopy) as Role[]).map(value =>
        <button key={value} aria-pressed={role === value} onClick={() => audience(value)}>{value}</button>)}</div>
      <span className="provenance" title="NASA data provenance"><span />LRO LOLA PDS/PGDA · JPL Horizons DE440 · NSSDCA · Moon Trek · LRO Diviner/ShadowCam</span>
      <label className="demo-select"><Play size={13} /><select aria-label="Guided demo scenario" value={demo ?? ''} onChange={e => guided(Number(e.target.value))}>
        <option value="" disabled>Guided demos</option>{demos.map((option, i) => <option key={option.label} value={i}>{option.label}</option>)}
      </select><ChevronDown size={13} /></label>
    </nav>

    <div className="workspace">
      <section className="visual-column" aria-label="Terrain and mission timeline">
        <div className="viewport">
          {current && result && <TerrainViewport key={id} site={current} window={result.window} plasma={result.plasma}
            network={result.network} route={result.route} mode={mode} overlay={overlay} hour={hour}
            mast={result.window.mastHeightM} selected={settings.node} onSelect={node => change('node', node)} />}
          <div className="viewport-heading"><div className="viewport-label"><Crosshair size={14} />{id === 'apollo-11' ? 'Educator reference' : 'Lunar digital twin'}</div>
            <h2>{displayName}</h2>
            <p>{current ? current.manifest.center_lat.toFixed(3) + '° latitude / ' + current.manifest.center_lon.toFixed(3) + '° longitude' : id === 'apollo-11' ? '0.674° N / 23.473° E · Mare Tranquillitatis' : 'NASA lunar south pole terrain'}</p>
          </div>
          {current && result && role !== 'Public' && role !== 'Educator' && <label className="overlay-control"><Layers size={14} /><select aria-label="Terrain heatmap overlay" value={overlay}
            onChange={e => setOverlay(e.target.value as Overlay)}>{overlays.map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select><ChevronDown size={12} /></label>}
          {error && <div className="state-message" role="alert"><h3>Site data unavailable</h3><p>{error}</p>
            <p>Run the NASA fetcher and horizon compiler to populate the local data directory.</p><button onClick={() => setRetry(value => value + 1)}>Retry</button></div>}
          {!error && !ephem && <div className="state-message" role="status">Loading NASA site data…</div>}
          {id === 'apollo-11' && apollo && <div className="apollo-panel">
            <HorizonRing ephemeris={apollo} mast={0} hour={hour} delay={deferred.delay} />
            <p>Apollo 11 shows Sun and Earth angles relative to a level horizon. The polar sites also account for terrain obstructions.</p>
            <button onClick={() => setModal('compare')}><Layers size={14} />Compare with the south pole</button>
          </div>}
          {current && result && <div className="viewport-footer">
            <span>{overlays.find(([key]) => key === overlay)?.[2]}</span>
            <span>{role === 'Planner' || role === 'Scientist' ? 'Orbit · zoom · select a candidate' : 'Drag to orbit · scroll to zoom'}</span>
          </div>}
        </div>
        <section className="timeline" aria-label="360-hour mission timeline">
          <div className="section-bar"><h2><Activity size={15} />Mission timeline</h2><span>{ephem?.timestamps[active]?.replace('T', ' ').replace(':00Z', ' UTC') ?? minus}</span></div>
          <div className="transport">
            <button className="play" aria-label={playing ? 'Pause timeline' : 'Play timeline'} onClick={() => setPlaying(!playing)}
              disabled={!ephem}>{playing ? <Pause size={15} /> : <Play size={15} />}</button>
            <select aria-label="Playback speed" value={speed} onChange={e => setSpeed(+e.target.value)}><option value="1">1×</option><option value="10">10×</option></select>
            <input aria-label="Mission hour" type="range" min="0" max="359" value={hour} onChange={e => setHour(+e.target.value)} />
            <output>T+{String(hour).padStart(3, '0')} h</output>
          </div>
          <div className="timeline-delay"><label htmlFor="timeline-delay">Launch delay</label>
            <input id="timeline-delay" type="range" min="0" max="360" value={settings.delay} onChange={e => change('delay', +e.target.value)} />
            <output>Day +{(settings.delay / 24).toFixed(1)}</output></div>
          {result && role !== 'Educator' ? <Tracks tracks={result.tracks.filter(track =>
            role === 'Planner' || (role === 'Scientist' ? ['Pad A solar', 'Pad A electric field', 'PSR secondary light'].includes(track.label) : track.label === 'Pad A solar'))} hour={hour} />
            : ephem && <Tracks hour={hour} tracks={[
            { label: 'Sun above horizontal', color: '#e8c477', unit: '%', max: 100, values: ephem.sun_el_deg.slice(deferred.delay, deferred.delay + 360).map(v => v > 0 ? 100 : 0) },
            { label: 'Earth above horizontal', color: '#92c4ff', unit: '%', max: 100, values: ephem.earth_el_deg.slice(deferred.delay, deferred.delay + 360).map(v => v > 0 ? 100 : 0) },
          ]} />}
        </section>
      </section>

      <aside className="terminal">
        <div className="section-bar"><h2><Radio size={15} />Mission telemetry</h2><span className="ready"><i />{ephem ? 'DATA READY' : 'AWAITING DATA'}</span></div>
        <section className="terminal-section">
          <div className="terminal-title"><h3>Visibility at T+{String(hour).padStart(3, '0')} h</h3><button className="icon-button" onClick={() => setModal('research')} aria-label="Visibility model information"><CircleHelp size={15} /></button></div>
          <div className="metrics">
            <div><span><Sun size={13} /> Solar elevation</span><strong>{ephem ? angle(ephem.sun_el_deg[active]) : minus}</strong>
              <small>{sample !== undefined ? Math.round(result!.window.solarFraction[sample] * 100) + '% solar disk visible' : 'Site-center altitude'}</small>
              {typeof sunChange === 'number' && <small>Visibility changes in {sunChange} h</small>}</div>
            <div><span><Radio size={13} /> Earth elevation</span><strong>{ephem ? angle(ephem.earth_el_deg[active]) : minus}</strong>
              <small>{sample !== undefined ? result!.window.earthVisible[sample] ? 'Direct-to-Earth line open' : 'Earth below terrain horizon' : 'Local horizontal reference'}</small>
              {typeof earthChange === 'number' && <small>Visibility changes in {earthChange} h</small>}</div>
          </div>
          <p className="assist">{demo === null ? roleCopy[role] : demos[demo].summary}</p>
          {role === 'Scientist' && result && sample !== undefined && <p className="assist">
            Surface {result.window.surfaceTemperatureK[sample].toFixed(1)} K · heater {result.window.heaterW[sample].toFixed(1)} W · finite-disk mean error {(100 * result.window.pointSourceMeanAbsoluteError).toFixed(2)}%
          </p>}
          {role === 'Public' && <p className="assist">Earth above the terrain horizon means a lander can potentially talk directly to Earth. Sunlight supports solar power and warms the surface.</p>}
        </section>
        {role === 'Planner' && <section className="terminal-section controls">
          <div className="terminal-title"><h3>Architecture compiler</h3><span>{settings === deferred ? '15-day window' : 'Updating…'}</span></div>
          <div className="mode-buttons"><button aria-pressed={mode === 'static'} onClick={() => setMode('static')}>Standalone</button>
            <button aria-pressed={mode === 'grid'} onClick={() => { setMode('grid'); setOverlay('complement') }}><Zap size={14} />Compile 3-node grid</button>
            <button aria-pressed={mode === 'rover'} onClick={() => { setMode('rover'); setOverlay('plasma') }}><Route size={14} />Compile rover path</button></div>
          <Slider label="Launch date shift" value={settings.delay} max={360} readout={'Day +' + (settings.delay / 24).toFixed(1)} onChange={value => change('delay', value)} />
          <div className="paired-controls">
            <Slider label="VSAT mast height" value={settings.mast} max={4} readout={[1.5,3,5,10,20][settings.mast] + ' m'} disabled={id === 'apollo-11'} onChange={value => change('mast', value)} />
            <Slider label="LOLA uncertainty" value={settings.sigma} max={3} step={.25} readout={settings.sigma + 'σ'} disabled={id === 'apollo-11'} onChange={value => change('sigma', value)} />
          </div>
          {result && <p className="assist">{result.network ? <>Pad A slope {current!.dem_slope[candidatePixel(current!.manifest, Math.floor(result.primary / 31), result.primary % 31)].toFixed(1)}°
            {result.primary !== settings.node ? ' · snapped to safe candidate' : ''} · {result.network.twin == null ? 'No visible twin' : 'Rim twin acquired'} · {result.network.iceTarget == null ? 'No feasible PSR link' : 'PSR link acquired'}</> : 'No landing candidate meets the <5° slope limit.'}
            {mode === 'rover' && <> · {result.route ? (result.route.distanceM / 1000).toFixed(2) + ' km planned' : 'No safe route'}</>}</p>}
        </section>}
        {role === 'Scientist' && <section className="terminal-section controls">
          <div className="terminal-title"><h3>Surface & model sensitivity</h3></div>
          <div className="layer-options">{overlays.map(([key, label]) => <button key={key} aria-pressed={overlay === key}
            onClick={() => setOverlay(key)}>{label}</button>)}</div>
          <div className="paired-controls">
            <Slider label="Observer height" value={settings.mast} max={4} readout={[1.5,3,5,10,20][settings.mast] + ' m'} disabled={!current} onChange={value => change('mast', value)} />
            <Slider label="LOLA uncertainty" value={settings.sigma} max={3} step={.25} readout={settings.sigma + 'σ'} disabled={!current} onChange={value => change('sigma', value)} />
          </div>
          {result && sample !== undefined && <dl className="detail-list">
            <div><dt>Terminator field</dt><dd>{result.plasma.electricFieldVm[sample].toFixed(1)} V/m</dd></div>
            <div><dt>Dust power loss</dt><dd>{result.plasma.dustPowerLossPct[sample].toFixed(2)}%</dd></div>
            <div><dt>Secondary light at C</dt><dd>{result.network?.iceTarget == null ? minus : result.network.passiveRadiosityWm2[hour].toFixed(3) + ' W/m²'}</dd></div>
          </dl>}
        </section>}
        {role === 'Educator' && <section className="terminal-section learning">
          <h3>Why landing latitude matters</h3>
          <p>Start at Apollo 11, then switch to Shackleton. Scrub the same mission hour at both sites and compare how high the Sun and Earth appear.</p>
          <button onClick={() => select(id === 'apollo-11' ? 'shackleton-ridge' : 'apollo-11', true)}>
            Switch to {id === 'apollo-11' ? 'Shackleton' : 'Apollo 11'}</button>
          <p>For a classroom exercise, compare the start date with day +15. Which location has the longer direct-to-Earth window?</p>
          <button onClick={() => setModal('compare')}>Compare dates and sites</button>
        </section>}
        {role === 'Public' && <section className="terminal-section learning">
          <h3>Explore the landing site</h3>
          <p>Drag the terrain to orbit. Play the timeline to watch the Sun move and see when Earth drops below the horizon.</p>
          {result && <dl className="detail-list">
            <div><dt>Hours with usable sunlight</dt><dd>{360 - result.engineering[0].dark} / 360</dd></div>
            <div><dt>Hours with Earth in view</dt><dd>{360 - result.engineering[0].blackout} / 360</dd></div>
          </dl>}
          <button disabled={!ephem} onClick={() => setPlaying(!playing)}>{playing ? <Pause size={14} /> : <Play size={14} />}
            {playing ? 'Pause the timeline' : 'Watch the Sun move'}</button>
        </section>}
        {ephem && <section className="terminal-section horizon-section"><div className="terminal-title"><h3>Polar horizon</h3><span>360° azimuth</span></div>
          <HorizonRing ephemeris={ephem} site={current} analysis={result} mast={deferred.mast} hour={hour} delay={deferred.delay} />
        </section>}
        {result && role === 'Planner' && <Scorecard result={result} active={activeMode} inventory={settings.inventory} setInventory={value => change('inventory', value)} />}
      </aside>
    </div>
    {modal && <Modal title={modal === 'compare' ? 'Compare landing sites' : 'Research citations, physics & VC roadmap'} onClose={() => setModal(null)}>
      {modal === 'compare' ? <Compare settings={deferred} onSelect={next => { select(next); setModal(null) }} /> : <Research />}
    </Modal>}
  </main>
}

let apolloRequest: Promise<SiteEphemeris> | undefined
function loadApollo() {
  apolloRequest ??= fetch(import.meta.env.BASE_URL + 'data/apollo-11.json').then(async response => {
    if (!response.ok) throw new Error('Apollo 11 ephemeris file is unavailable.')
    const value: SiteEphemeris = await response.json()
    if (value.num_steps !== 720 || ![value.timestamps, value.sun_az_deg, value.sun_el_deg, value.earth_az_deg, value.earth_el_deg].every(series => series?.length === 720)) {
      throw new Error('Apollo 11 ephemeris does not match the 720-hour data contract.')
    }
    return value
  }).catch(error => { apolloRequest = undefined; throw error })
  return apolloRequest
}

function Slider({ label, value, max, readout, onChange, step = 1, disabled = false }:
  { label: string; value: number; max: number; readout: string; onChange: (value: number) => void; step?: number; disabled?: boolean }) {
  return <label className="slider"><span>{label}<output>{readout}</output></span>
    <input type="range" min="0" max={max} value={value} step={step} disabled={disabled} onChange={e => onChange(+e.target.value)} /></label>
}

function Scorecard({ result, active, inventory, setInventory }: { result: Analysis; active: number; inventory: number; setInventory: (value: number) => void }) {
  const finance = [result.finance?.standalone, result.network?.twin == null ? null : result.finance?.grid, result.finance?.mobile]
  const available = [true, result.network?.twin != null, !!result.route]
  const engineering = result.engineering
  const underwriting = result.finance?.actuarialUnderwriting
  const scoreRows = [
    ['Darkness', ...engineering.map((m, i) => available[i] ? m.dark + ' h' : minus)],
    ['Earth blackout', ...engineering.map((m, i) => available[i] ? m.blackout + ' h' : minus)],
    ['Peak field', ...engineering.map((m, i) => available[i] ? m.field.toFixed(1) + ' V/m' : minus)],
    ['ESD proxy / dust loss', ...engineering.map((m, i) => available[i] ? m.esd + ' h / ' + m.dust.toFixed(1) + '%' : minus)],
    ['Battery mass', ...finance.map(m => m ? m.requiredBatteryMassKg.toFixed(1) + ' kg' : minus)],
    ['CLPS capital saved', ...finance.map(m => m ? currency(m.netClpsCapitalSavedUSD) : minus)],
    ['Energy cost', ...finance.map(m => m?.lunaGridLcoeUSDPerKWh != null ? currency(m.lunaGridLcoeUSDPerKWh) + '/kWh' : minus)],
    ['Ice / propellant', ...finance.map(m => m ? m.psrIceExtractedKg.toFixed(2) + ' kg / ' + currency(m.cislunarPropellantValueUSD) : minus)],
    ['Reflection window', minus, result.network?.iceTarget == null ? minus : result.network.reflectedLightHours.length + ' h', minus],
    ['Underwriting', underwriting ? underwriting.insuranceTier : minus, minus, minus],
  ]
  return <section className="terminal-section score-section">
    <div className="terminal-title"><h3>Commercial & actuarial scorecard</h3><span>Scenario estimates</span></div>
    <table className="score"><thead><tr><th scope="col">Metric</th>{['Standalone', '3-node grid', '4D rover'].map((name, i) => <th scope="col" className={active === i ? 'active-cell' : ''} key={name}>{name}</th>)}</tr></thead>
      <tbody>{scoreRows.map(([label, ...cells]) => <tr key={label}><th scope="row">{label}</th>
        {cells.map((cell, i) => <td key={i} className={i === active ? 'active-cell' : undefined}>{cell}</td>)}</tr>)}</tbody></table>
    {underwriting && <p className="assist">Standalone landing ellipse · {underwriting.survivalProbPct.toFixed(1)}% modeled survival · {currency(underwriting.valueAtRisk95USD)} VaR95</p>}
    <label className="inventory">Assumed ice inventory (kg)<input type="number" min="0" value={inventory} onChange={e => setInventory(Math.max(0, +e.target.value))} /></label>
    <p className="assist">Timeline batteries start at 100 kg per architecture. Ice inventory is a scenario input.</p>
  </section>
}

function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) {
  const ref = useRef<HTMLDialogElement>(null)
  useEffect(() => { ref.current?.showModal() }, [])
  return <dialog ref={ref} onCancel={onClose} aria-label={title}>
    <div className="dialog-header"><h2>{title}</h2><button autoFocus onClick={onClose} aria-label="Close dialog"><X size={17} /></button></div>
    <div className="dialog-body">{children}</div>
  </dialog>
}

type Comparison = { id: SiteId; name: string; reference?: boolean; start?: string; sun?: number; earth?: number; latestSun?: number; latestEarth?: number; slope?: number; error?: string }
function Compare({ settings, onSelect }: { settings: Settings; onSelect: (id: SiteId) => void }) {
  const [data, setData] = useState<Comparison[]>([])
  useEffect(() => {
    let live = true
    void Promise.all(sites.map(async ([id, name]): Promise<Comparison> => {
      try {
        if (id === 'apollo-11') {
          const ephem = await loadApollo()
          const count = (v: number[], delay: number) => v.slice(delay, delay + 360).filter(x => x > 0).length
          return { id, name, reference: true, start: ephem.timestamps[settings.delay], sun: count(ephem.sun_el_deg, settings.delay), earth: count(ephem.earth_el_deg, settings.delay),
            latestSun: count(ephem.sun_el_deg, 360), latestEarth: count(ephem.earth_el_deg, 360) }
        }
        const site = await sitePack(id)
        const view = analyze(site, { ...settings, node: 480 })
        if (!view.network) return { id, name, error: 'No safe pad on the candidate grid' }
        const late = settings.delay === 360 ? view : analyze(site, { ...settings, node: 480, delay: 360 })
        return { id, name, start: view.window.timestamps[0], sun: 360 - view.engineering[0].dark, earth: 360 - view.engineering[0].blackout,
          latestSun: 360 - late.engineering[0].dark, latestEarth: 360 - late.engineering[0].blackout,
          slope: site.dem_slope[candidatePixel(site.manifest, Math.floor(view.primary / 31), view.primary % 31)] }
      } catch (error) {
        return { id, name, error: error instanceof Error ? error.message : 'Site unavailable' }
      }
    })).then(rows => { if (live) setData(rows) })
    return () => { live = false }
  }, [settings])
  return <>
    <p>Compare 15-day windows at day +{(settings.delay / 24).toFixed(1)} and day +15. Sun hours count samples with at least 10% of the solar disk visible at Pad A.</p>
    {!data.length ? <p role="status">Compiling site comparison…</p> : <div className="table-scroll"><table className="score compare-table">
      <thead><tr><th>Site</th><th>Launch (UTC)</th><th>Sun / Earth hours</th><th>Day +15 Sun / Earth</th><th>Slope</th></tr></thead>
      <tbody>{data.map(row => <tr key={row.id}><th><button onClick={() => onSelect(row.id)}>{row.name}</button>{row.reference && <small>Level horizon</small>}</th>
        {row.error ? <td colSpan={4}>{row.error}</td> : <><td>{row.start?.slice(0, 16).replace('T', ' ')}</td><td>{row.sun} / {row.earth}</td>
          <td>{row.latestSun} / {row.latestEarth}</td><td>{row.slope?.toFixed(1) ?? minus}{row.slope != null && '°'}</td></>}</tr>)}</tbody></table></div>}
  </>
}

function Research() {
  return <div className="research">
    <h3>Data provenance</h3>
    <p><a href="https://pgda.gsfc.nasa.gov/products/90" target="_blank" rel="noreferrer">NASA GSFC LOLA terrain and mapped PSRs</a> · <a href="https://ssd-api.jpl.nasa.gov/doc/horizons.html" target="_blank" rel="noreferrer">JPL Horizons API</a> · <a href="https://nssdc.gsfc.nasa.gov/planetary/lunar/lunar_sites.html" target="_blank" rel="noreferrer">NSSDCA Apollo coordinates</a></p>
    <h3>Power, communication and hazard models</h3>
    <p>Solar visibility uses a finite disk and the terrain horizon. Earth visibility is geometric line of sight. Link margins and eclipse events require separate models.</p>
    <p>Mapped PSR and thermal thresholds can identify a candidate for further study. Reflected light, plasma, dust and heater loads are simplified scenario outputs. Ice inventory is a user assumption.</p>
    <p><a href="https://doi.org/10.1126/science.1187726" target="_blank" rel="noreferrer">Diviner cold traps</a> · <a href="https://doi.org/10.1126/sciadv.aec8211" target="_blank" rel="noreferrer">ShadowCam ice study</a> · <a href="https://ntrs.nasa.gov/citations/20110013543" target="_blank" rel="noreferrer">Lunar plasma wake study</a> · <a href="https://www.nasa.gov/general/light-bender/" target="_blank" rel="noreferrer">NASA Light Bender</a></p>
    <h3>Engineering & investment roadmap</h3>
    <p>Calibrate thermal and dust models against observations, verify terrain and link margins at candidate sites, then model measured ice inventory and hardware lifetime. The underwriting panel estimates standalone mission loss under the stated scenario assumptions.</p>
  </div>
}

createRoot(document.getElementById('root')!).render(<App />)
