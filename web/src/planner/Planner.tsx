import { useEffect, useMemo, useRef, useState } from 'react'
import { Compass, Globe2, Search, Share2, Sparkles, Zap } from 'lucide-react'
import { AgentDrawer } from './AgentDrawer'
import { IntroOverlay } from './IntroOverlay'
import { PowerDrawer, MethodsDrawer } from './PowerMethodsDrawers'
import { RecoveryDrawer } from './RecoveryDrawer'
import { ScenarioBar } from './ScenarioBar'
import { ReleaseCases } from './TelemetryCharts'
import { TelemetryPanel } from './TelemetryPanel'
import { polarSites } from './data'
import { answerScenarioQuestion, buildComparisonRecord } from './explain'
import type { IntroFocus } from './IntroScene'
import {
  defaults,
  delayedAlternative,
  download,
  epoch,
  fingerprint,
  initial,
  n,
  name,
  restore,
  utc,
  webglAvailable,
  type ChatMessage,
  type Result,
  type SearchResultState,
  type TabId,
} from './missionHelpers'
import { complementaryPower, solarThreshold, type ArrayMode, type Power, type Scenario } from './model'
import type { Request } from './planner.worker'
import type { RobustnessPreference } from './recovery'
import type { TerrainOverlay } from './terrainOverlay'
import './planner.css'

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
  const [hoverAz, setHoverAz] = useState<number | null>(null)
  const [experiment, setExperiment] = useState(() => (new URLSearchParams(location.search).has('comparison') ? 'custom' : 'delay'))
  const [role, setRole] = useState<'Planner' | 'Scientist' | 'Educator' | 'Public'>('Planner')
  const [showIntro, setShowIntro] = useState(() => new URLSearchParams(location.search).has('intro'))
  const entered = useRef(!showIntro)
  const introFocus: IntroFocus = 'system'
  const [playing, setPlaying] = useState(false)
  const [progress, setProgress] = useState('')
  const [search, setSearch] = useState<SearchResultState | null>(null)
  const [searchSort, setSearchSort] = useState<'target' | 'dark' | 'earth' | 'slope' | 'starts'>('target')
  const [recoveryScope, setRecoveryScope] = useState<'all-polar' | 'same-site'>('all-polar')
  const [recoveryRobustness, setRecoveryRobustness] = useState<RobustnessPreference>('dual-extent-and-sigma')
  const [recoveryWindowFrom, setRecoveryWindowFrom] = useState<number>(0)
  const [recoveryWindowThrough, setRecoveryWindowThrough] = useState<number>(720)
  const [showCertificate, setShowCertificate] = useState(false)
  const [activeDrawer, setActiveDrawer] = useState<'agent' | 'recover' | 'power' | 'methods' | null>(null)
  const [verbosity, setVerbosity] = useState<'minimal' | 'moderate' | 'detailed'>('minimal')
  const [chatInput, setChatInput] = useState('')
  const [agentBusy, setAgentBusy] = useState(false)
  const agentThreadRef = useRef<HTMLDivElement | null>(null)
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([
    {
      id: 'welcome',
      sender: 'agent',
      headline: 'Umbra Agent ready',
      text: 'Ask anything about the active landing site, sunlight windows, Earth blackouts, or battery mass — or tell me to switch 3D views, overlays, sites, or generate comparison charts and mission reports.',
    },
  ])
  const [modules, setModules] = useState({
    compare: true,
    sky: true,
    metrics: true,
    timeline: true,
  })
  const worker = useRef<Worker | null>(null)
  const serial = useRef(0)
  const searchId = useRef(0)
  const restoreVersion = useRef(saved.versions)

  useEffect(() => {
    if (!canRender3D) return
    const timer = window.setTimeout(() => {
      void import('./SkyScene')
      void import('./IntroScene')
    }, 60)
    return () => window.clearTimeout(timer)
  }, [canRender3D])

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
        setProgress(data.stage ?? `${name(data.site)} · pad ${data.node + 1} of 961`)
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
    setShowCertificate(false)
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
    setShowCertificate(false)
  }, [limits, recoveryScope, recoveryRobustness, recoveryWindowFrom, recoveryWindowThrough])

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
  const searchReady = Boolean(items?.some(x => x.terrain && x.meta.regional))
  const samePolarSite = polarSites.includes(scenarios[0].site) && scenarios[0].site === scenarios[1].site && scenarios[0].node !== scenarios[1].node
  const secondaryNode = samePolarSite ? scenarios[1 - active].node : null

  const runAlternativeSearch = () => {
    if (!result || !searchReady || progress) return
    const id = (searchId.current = ++serial.current)
    const maxAllowedStart = Math.max(0, 720 - days * 24)
    const clampedFrom = Math.max(0, Math.min(maxAllowedStart, recoveryWindowFrom))
    const clampedThrough = Math.max(clampedFrom, Math.min(maxAllowedStart, recoveryWindowThrough))
    const scopeSites =
      recoveryScope === 'same-site' && polarSites.includes(scenarios[1].site) ? [scenarios[1].site] : polarSites
    setProgress('Running counterfactual mission recovery across LOLA terrain profiles…')
    setSearch(null)
    setShowCertificate(false)
    worker.current?.postMessage({
      kind: 'search',
      id,
      days,
      power,
      limits,
      mast: scenarios[active].mast,
      targetStart: scenarios[1].start,
      version: result.meta.vectorHash,
      baseline: scenarios[0],
      revised: scenarios[1],
      robustnessPreference: recoveryRobustness,
      scope: { sites: scopeSites, from: clampedFrom, through: clampedThrough },
    } satisfies Request)
  }

  useEffect(() => {
    if (agentThreadRef.current) {
      agentThreadRef.current.scrollTop = agentThreadRef.current.scrollHeight
    }
  }, [chatMessages, agentBusy, activeDrawer])

  const applyAgentActions = (
    actions: Array<{
      target?: string
      site?: string
      node?: number
      mast?: number
      start?: number
      days?: number
      view?: string
      overlay?: string
      mode?: string
      openPanel?: string
      runRecoverySearch?: boolean
    }>,
  ) => {
    const appliedLabels: string[] = []
    for (const act of actions) {
      const patch: Partial<Scenario> = {}
      if (act.site && (polarSites as readonly string[]).includes(act.site)) {
        patch.site = act.site as Scenario['site']
        appliedLabels.push(`Site: ${name(act.site)}`)
      }
      if (typeof act.node === 'number' && Number.isInteger(act.node) && act.node >= 0 && act.node <= 960) {
        patch.node = act.node
        appliedLabels.push(`Pad #${act.node + 1}`)
      }
      if (typeof act.mast === 'number' && Number.isInteger(act.mast) && act.mast >= 0 && act.mast <= 4) {
        patch.mast = act.mast
        appliedLabels.push(`Mast ${[1.5, 3, 5, 10, 20][act.mast]}m`)
      }
      if (typeof act.start === 'number' && Number.isInteger(act.start) && act.start >= 0 && act.start <= 720) {
        patch.start = act.start
        appliedLabels.push(`Start +${act.start}h`)
      }
      if (Object.keys(patch).length > 0) {
        if (act.target === 'alternative') update(1, patch)
        else if (act.target === 'both') {
          update(0, patch)
          update(1, patch)
        } else update(0, patch)
      }
      if (typeof act.days === 'number' && Number.isInteger(act.days) && act.days >= 1 && act.days <= 15) {
        setDays(act.days)
        appliedLabels.push(`${act.days}d window`)
      }
      if (act.view) {
        const viewMap: Record<string, 'orbit' | 'pad' | 'polar' | 'chart'> = {
          orbit3d: canRender3D ? 'orbit' : 'chart',
          observer: canRender3D ? 'pad' : 'chart',
          polar: canRender3D ? 'polar' : 'chart',
          chart: 'chart',
        }
        if (viewMap[act.view]) {
          setModules(prev => ({ ...prev, sky: true }))
          setView(viewMap[act.view])
          appliedLabels.push(`View: ${act.view}`)
        }
      }
      if (act.overlay) {
        const ovMap: Record<string, TerrainOverlay> = {
          slope: 'slope',
          psr: 'psr',
          viable: 'viable',
          illumination: 'illumination',
          earth: 'earth',
          solar_hours: 'solar_hours',
          none: 'relief',
        }
        if (ovMap[act.overlay]) {
          setModules(prev => ({ ...prev, sky: true }))
          setOverlay(ovMap[act.overlay])
          appliedLabels.push(`Overlay: ${act.overlay}`)
        }
      }
      if (act.mode === 'learner') {
        selectRole('Educator')
        setModules({ compare: true, sky: true, metrics: true, timeline: true })
        setView(canRender3D ? 'pad' : 'chart')
        appliedLabels.push('Mode: Learner')
      } else if (act.mode === 'planner') {
        selectRole('Planner')
        appliedLabels.push('Mode: Planner')
      }
      if (act.openPanel) {
        if (act.openPanel === 'methods') {
          setActiveDrawer('methods')
          appliedLabels.push('Opened Methods & Data')
        } else if (act.openPanel === 'recover') {
          setActiveDrawer('recover')
          appliedLabels.push('Opened Recover Pads')
        } else if (act.openPanel === 'power') {
          setActiveDrawer('power')
          appliedLabels.push('Opened Power & Cost')
        } else {
          const panelKey = { compare: 'compare', scene: 'sky', verdict: 'metrics', timeline: 'timeline' }[act.openPanel] as
            | 'compare'
            | 'sky'
            | 'metrics'
            | 'timeline'
            | undefined
          if (panelKey) {
            setModules(prev => ({ ...prev, [panelKey]: true }))
            appliedLabels.push(`Panel: ${act.openPanel}`)
          }
        }
      }
      if (act.runRecoverySearch) {
        setActiveDrawer('recover')
        if (!progress && searchReady) runAlternativeSearch()
        appliedLabels.push('Started Recovery Search')
      }
    }
    return [...new Set(appliedLabels)]
  }

  const sendAgentPrompt = async (rawQuery: string, displayLabel?: string) => {
    const q = rawQuery.trim()
    if (!q || agentBusy) return
    const history = chatMessages
      .filter(m => m.id !== 'welcome')
      .slice(-12)
      .map(m => ({ role: m.sender === 'agent' ? ('assistant' as const) : ('user' as const), content: m.text }))
    setChatInput('')
    setChatMessages(prev => [...prev, { id: `u-${Date.now()}`, sender: 'user', text: displayLabel ?? q }])
    setAgentBusy(true)
    try {
      const response = await fetch('/api/research/ask', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          question: q,
          history,
          context: {
            scenarios,
            days,
            limits,
            activeView: view,
            activeOverlay: overlay,
            activeMode: role === 'Educator' ? 'learner' : 'planner',
          },
        }),
      })
      if (!response.ok) throw new Error(`Study API returned HTTP ${response.status}`)
      const data = await response.json()
      const actionsApplied = Array.isArray(data.uiActions) && data.uiActions.length > 0 ? applyAgentActions(data.uiActions) : []
      const cites = Array.isArray(data.citations)
        ? data.citations
            .map((c: { passageId?: string; docId?: string; title?: string; citation?: string; sourceUrl?: string; url?: string }, idx: number) => ({
              id: c.passageId ?? c.docId ?? `cit-${idx}`,
              title: c.title ?? c.citation ?? c.docId ?? 'NASA / Umbra-X Source',
              url: c.sourceUrl ?? c.url ?? '',
            }))
            .filter((c: { url: string }) => Boolean(c.url))
        : []
      setChatMessages(prev => [
        ...prev,
        {
          id: `a-${Date.now()}`,
          sender: 'agent',
          text: data.answer || 'No response text returned.',
          actionsApplied,
          charts: Array.isArray(data.charts) ? data.charts : [],
          report: data.report ?? null,
          citations: cites,
        },
      ])
    } catch {
      const isGreeting = /^(hi|hey|hello|yo|sup|hola|good morning|good evening|help|what can you do)\b/.test(q.toLowerCase())
      if (isGreeting) {
        setChatMessages(prev => [
          ...prev,
          {
            id: `a-${Date.now()}`,
            sender: 'agent',
            headline: `Connected to ${name(scenarios[active].site)}`,
            text: `Hey! I'm Umbra Agent. Ask me about your active **${name(scenarios[active].site)}** (${days}d) scenario's sunlight, Earth blackouts, DSN coverage, slope, or battery mass.`,
          },
        ])
      } else {
        const ans = comparisonRecord ? answerScenarioQuestion(comparisonRecord, q) : null
        setChatMessages(prev => [
          ...prev,
          ans
            ? { id: `a-${Date.now()}`, sender: 'agent', headline: ans.headline, text: ans.explanation, facts: ans.factsUsed, citations: ans.citations }
            : { id: `a-${Date.now()}`, sender: 'agent', text: 'Waiting for mission simulation data to finish loading.' },
        ])
      }
    } finally {
      setAgentBusy(false)
    }
  }

  const downloadCertificate = () => {
    if (!search?.recovery?.certificate) return
    download('umbra-x-decision-certificate.json', JSON.stringify(search.recovery.certificate, null, 2), 'application/json')
  }

  const exportData = (format: 'json' | 'csv' | 'samples') => {
    if (!items) return
    if (format === 'samples') {
      const rows = ['scenario,utc,sun_az_deg,sun_el_deg,sun_horizon_deg,sun_sigma_deg,earth_az_deg,earth_el_deg,earth_horizon_deg,solar_fraction,array_incidence_factor,pv_w,station_geometry']
      items.forEach((x, i) =>
        x.report.sky.forEach((s, j) =>
          rows.push([i ? 'alternative' : 'baseline', utc(x.meta.start, scenarios[i].start + j / 12), s.sun.az, s.sun.el, s.sunHorizon, s.sunSigma, s.earth.az, s.earth.el, s.earthHorizon, s.solar, s.incidenceFactor, x.report.generation[j], s.stationCovered ? s.stationAccess : 'unknown'].join(',')),
        ),
      )
      download('umbra-x-samples.csv', rows.join('\n'), 'text/csv')
      return
    }
    if (format === 'json') {
      download('umbra-x-comparison.json', JSON.stringify({ schema: 1, scenarios, days, limits, power, rates, equipment, versions: items.map(fingerprint), comparisonRecord, solarThreshold, results: items.map(x => ({ report: x.report, metadata: x.meta })) }, null, 2), 'application/json')
      return
    }
    const rows = ['scenario,interval,start_utc,end_utc,duration_hours,already_underway,continues_at_end']
    items.forEach((x, i) => {
      for (const key of ['dark', 'earth', 'station'] as const) {
        for (const e of x.report[key]) {
          rows.push([i ? 'alternative' : 'baseline', key, utc(x.meta.start, scenarios[i].start + e.start / 12), utc(x.meta.start, scenarios[i].start + e.end / 12), e.hours, e.atStart, e.atEnd].join(','))
        }
      }
    })
    download('umbra-x-events.csv', rows.join('\n'), 'text/csv')
  }

  const selectRole = (r: 'Planner' | 'Scientist' | 'Educator' | 'Public') => {
    setRole(r)
    if (r === 'Educator' && !scenarios.some(s => s.site === 'apollo-11')) {
      applyPreset([{ site: 'apollo-11', node: 480, start: 0, mast: 0 }, { site: 'shackleton-ridge', node: 480, start: 0, mast: 2 }], { arrayMode: 'horizontal' })
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
    if (id === 'apollo') applyPreset([{ ...initial[0], site: 'apollo-11', mast: 0 }, initial[0]], { arrayMode: 'horizontal' })
    else if (alternative[id]) applyPreset([initial[0], alternative[id]])
    if (id === 'power') setActiveDrawer('power')
    else if (id === 'recovery') setActiveDrawer('recover')
    setExperiment(id)
  }

  const inspectWorstBlackout = (targetMetric: 'sun' | 'earth') => {
    if (!items) return
    const events = targetMetric === 'sun' ? items[active].report.dark : items[active].report.earth
    const longest = events.reduce<(typeof events)[number] | undefined>((best, event) => (!best || event.hours > best.hours ? event : best), undefined)
    if (longest) setIndex(longest.start)
    setPlaying(false)
    setLook(targetMetric === 'sun' ? 'sun' : 'earth')
    setView(canRender3D ? 'pad' : 'chart')
  }

  if (showIntro) {
    return (
      <IntroOverlay
        canRender3D={canRender3D}
        view={view}
        setView={setView}
        role={role}
        experiment={experiment}
        introFocus={introFocus}
        selectRole={selectRole}
        setExperiment={setExperiment}
        applyPreset={applyPreset}
        onEnter={() => {
          entered.current = true
          setShowIntro(false)
        }}
      />
    )
  }

  const copilotOpen = activeDrawer === 'agent'

  return (
    <div className="mission">
      <a className="skip-link" href="#main-workspace">Skip to mission workspace</a>
      <header className="mission-header">
        <button type="button" className="mission-brand mission-brand-btn" title="Back to Intro" onClick={() => setShowIntro(true)}>
          <span className="brand-mark" aria-hidden="true">
            <svg width="13" height="13" viewBox="0 0 16 16" fill="none">
              <circle cx="8" cy="7.5" r="5" stroke="currentColor" strokeWidth="1.4" />
              <path d="M9.5 3a4.6 4.6 0 0 0 0 9 4.5 4.5 0 1 1 0-9Z" fill="currentColor" opacity="0.85" />
              <line x1="1" y1="12.5" x2="15" y2="12.5" stroke="#00d4aa" strokeWidth="1.4" />
            </svg>
          </span>
          Umbra-X
        </button>
        <div className="mission-header-actions">
          <a href="https://github.com/ajiteshbankulaa/Umbra-X" target="_blank" rel="noreferrer" className="header-link-btn" aria-label="Umbra-X GitHub repository">
            <svg width="13" height="13" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
              <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27s1.36.09 2 .27c1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8Z" />
            </svg>
            GitHub
          </a>
          <button type="button" className={copilotOpen ? 'copilot-trigger active' : 'copilot-trigger'} aria-expanded={copilotOpen} onClick={() => setActiveDrawer(d => (d === 'agent' ? null : 'agent'))}>
            <Sparkles size={13} /> Umbra Agent
          </button>
          <button
            disabled={!items || pending || !!error}
            onClick={async () => {
              if (!items) return
              const url = new URL(location.href)
              url.search = ''
              url.searchParams.set('comparison', JSON.stringify({ schema: 1, scenarios, days, limits, power, rates, equipment, versions: items.map(fingerprint) }))
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
        </div>
      </header>

      <div className="mobile-bar" role="region" aria-label="Mobile quick controls">
        <div className="mobile-bar-top">
          <div className="mobile-switch">
            {([0, 1] as const).map(i => (
              <button key={i} type="button" aria-pressed={active === i} onClick={() => setActive(i)}>
                {i ? '02 Alt' : '01 Base'} · {name(scenarios[i].site).split(' ')[0]}
              </button>
            ))}
          </div>
        </div>
        <div className="mobile-rail-strip" aria-label="Workspace quick navigation">
          <button type="button" className={role !== 'Educator' ? 'mobile-chip active' : 'mobile-chip'} onClick={() => selectRole('Planner')}>Planner</button>
          <button type="button" className={role === 'Educator' ? 'mobile-chip active' : 'mobile-chip'} onClick={() => { selectRole('Educator'); setModules({ compare: true, sky: true, metrics: true, timeline: true }); setView(canRender3D ? 'pad' : 'chart') }}>Learner</button>
          <button type="button" className={activeDrawer === 'power' ? 'mobile-chip active' : 'mobile-chip'} onClick={() => setActiveDrawer(d => (d === 'power' ? null : 'power'))}>Power &amp; Cost</button>
          <button type="button" className={activeDrawer === 'recover' ? 'mobile-chip active' : 'mobile-chip'} onClick={() => { setActiveDrawer(d => (d === 'recover' ? null : 'recover')); if (!search && searchReady && !progress) runAlternativeSearch() }}>Recover Pads</button>
          <button type="button" className={activeDrawer === 'methods' ? 'mobile-chip active' : 'mobile-chip'} onClick={() => setActiveDrawer(d => (d === 'methods' ? null : 'methods'))}>Methods</button>
        </div>
      </div>

      <div className={activeDrawer ? 'mission-shell with-agent' : 'mission-shell'}>
        <aside className="workspace-rail" aria-label="Workspace panels">
          <span className="rail-heading">Mode</span>
          <div className="rail-mode-group" role="group" aria-label="Experience mode">
            <button type="button" className={role !== 'Educator' ? 'rail-btn active' : 'rail-btn'} aria-pressed={role !== 'Educator'} onClick={() => selectRole('Planner')}>
              <Compass size={14} /><span>Planner</span>
            </button>
            <button type="button" className={role === 'Educator' ? 'rail-btn active' : 'rail-btn'} aria-pressed={role === 'Educator'} onClick={() => { selectRole('Educator'); setModules({ compare: true, sky: true, metrics: true, timeline: true }); setView(canRender3D ? 'pad' : 'chart') }}>
              <Sparkles size={14} /><span>Learner</span>
            </button>
          </div>
          <div className="rail-divider" />
          <span className="rail-heading">Study</span>
          <select className="rail-select" aria-label="Mission study preset" value={experiment} onChange={e => openExperiment(e.target.value)}>
            <option value="delay">48h Launch Delay</option>
            <option value="recovery">Ridge Pad Recovery</option>
            <option value="ridge">Ridge vs Basin Pad</option>
            <option value="mast">1.5m vs 20m Mast</option>
            <option value="sites">Shackleton vs Mons Mouton</option>
            <option value="power">Power, Mass &amp; $/kg</option>
            <option value="apollo">Apollo 11 vs South Pole</option>
            <option value="custom">Custom Lat/Lon</option>
          </select>
          <div className="rail-divider" />
          <span className="rail-heading">Panels</span>
          {([{ id: 'metrics', label: 'KPIs', icon: <Sparkles size={14} /> }, { id: 'timeline', label: 'Timeline', icon: <Compass size={14} /> }] as const).map(m => (
            <button key={m.id} type="button" className={modules[m.id] ? 'rail-btn active' : 'rail-btn'} aria-pressed={modules[m.id]} onClick={() => setModules(prev => ({ ...prev, [m.id]: !prev[m.id] }))}>
              {m.icon}<span>{m.label}</span>
            </button>
          ))}
          <div className="rail-divider" />
          <span className="rail-heading">Tools</span>
          <button type="button" className={activeDrawer === 'recover' ? 'rail-btn active' : 'rail-btn'} aria-expanded={activeDrawer === 'recover'} onClick={() => { setActiveDrawer(d => (d === 'recover' ? null : 'recover')); if (!search && searchReady && !progress) runAlternativeSearch() }}>
            <Search size={14} /><span>Recover Pads</span>
          </button>
          <button type="button" className={activeDrawer === 'power' ? 'rail-btn active' : 'rail-btn'} aria-expanded={activeDrawer === 'power'} onClick={() => setActiveDrawer(d => (d === 'power' ? null : 'power'))}>
            <Zap size={14} /><span>Power &amp; Cost</span>
          </button>
          <button type="button" className={activeDrawer === 'methods' ? 'rail-btn active' : 'rail-btn'} aria-expanded={activeDrawer === 'methods'} onClick={() => setActiveDrawer(d => (d === 'methods' ? null : 'methods'))}>
            <Globe2 size={14} /><span>Methods &amp; Data</span>
          </button>
          <div className="rail-divider" />
          <span className="rail-heading">Detail</span>
          <div className="rail-verbosity" role="group" aria-label="Description verbosity">
            {(['minimal', 'moderate', 'detailed'] as const).map(v => (
              <button key={v} type="button" className={verbosity === v ? 'rail-verb-btn active' : 'rail-verb-btn'} aria-pressed={verbosity === v} onClick={() => setVerbosity(v)}>
                {v[0].toUpperCase() + v.slice(1)}
              </button>
            ))}
          </div>
        </aside>

        <main
          id="main-workspace"
          className="mission-body"
          data-layout="hero"
          data-mode={role === 'Educator' ? 'learner' : 'planner'}
          data-recovery={activeDrawer === 'recover' ? 'open' : 'closed'}
          data-verbosity={verbosity}
          data-mod-compare={modules.compare ? 'on' : 'off'}
          data-mod-sky={modules.sky ? 'on' : 'off'}
          data-mod-metrics={modules.metrics ? 'on' : 'off'}
          data-mod-timeline={modules.timeline ? 'on' : 'off'}
        >
          <p className="detailed-context-note">
            {role === 'Educator'
              ? 'Guided Learner Explorer: inspect polar grazing light, 3D crater silhouettes, and Earth libration blackouts across LRO LOLA & JPL DE440 geometry.'
              : 'Counterfactual Lunar Mission Navigator: compare Baseline vs Alternative windows across 2,883 LRO LOLA (20 m local / 96 km regional) candidate pads and JPL DE440 ephemerides.'}
          </p>

          {role === 'Public' && comparisonRecord && (
            <section className="public-guide" aria-label="Guided south-pole exploration">
              <div>
                <strong>The Lunar South Pole Paradox (1.54° Axial Tilt)</strong>
                <p>Unlike Earth’s 23.5° tilt, the Moon stays nearly upright relative to the Sun. Shifting launch timing changes Earth’s radio angle while moving just a few hundred meters onto a flat rim pad can eliminate multi-day darkness.</p>
              </div>
              <div className="public-guide-actions">
                <button type="button" className="btn-primary-action" onClick={() => { const isRecovered = scenarios[1].node === 478; update(1, isRecovered ? { site: 'shackleton-ridge', node: 480, start: 48, mast: 2 } : { site: 'shackleton-ridge', node: 478, start: 48, mast: 2 }); setActive(1) }}>
                  {scenarios[1].node === 478 ? 'Reset Alt to +48h Delay (Pad #481)' : 'Test Moving 280 m to Pad #479 (+48h)'}
                </button>
                <span className="public-guide-readout">
                  Current Alt: <strong>{n(comparisonRecord.alternative.longestDark)} h</strong> max darkness · <strong>{n(comparisonRecord.alternative.longestEarth)} h</strong> Earth outage
                </span>
              </div>
            </section>
          )}

          {notice && (
            <p className="mission-note" role="status">
              <span>{notice}</span> <button onClick={() => setNotice('')}>Dismiss</button>
            </p>
          )}

          <ScenarioBar
            scenarios={scenarios}
            items={items}
            comparisonRecord={comparisonRecord}
            active={active}
            setActive={setActive}
            role={role}
            days={days}
            power={power}
            limits={limits}
            pending={pending}
            error={error}
            start={start}
            update={update}
            swapScenarios={swapScenarios}
            setNotice={setNotice}
            onRetry={() => setRetry(x => x + 1)}
          />

          {result && sky && comparisonRecord && !pending && !error && (
            <TelemetryPanel
              items={items!}
              result={result}
              scenarios={scenarios}
              active={active}
              setActive={setActive}
              comparisonRecord={comparisonRecord}
              view={view}
              setView={setView}
              overlay={overlay}
              setOverlay={setOverlay}
              compareOverlay={compareOverlay}
              setCompareOverlay={setCompareOverlay}
              look={look}
              setLook={setLook}
              cursor={cursor}
              setIndex={setIndex}
              playing={playing}
              setPlaying={setPlaying}
              hoverAz={hoverAz}
              setHoverAz={setHoverAz}
              canRender3D={canRender3D}
              secondaryNode={secondaryNode}
              role={role}
              days={days}
              setDays={setDays}
              limits={limits}
              setLimits={setLimits}
              power={power}
              setPower={setPower}
              sigma={sigma}
              arrayMode={arrayMode}
              start={start}
              search={search}
              searchReady={searchReady}
              progress={progress}
              update={update}
              setScenarios={setScenarios}
              onClearSearch={() => setSearch(null)}
              onInspectWorstBlackout={inspectWorstBlackout}
              onOpenRecovery={() => {
                setActiveDrawer('recover')
                runAlternativeSearch()
              }}
              onOpenEvidence={() => {
                if (search?.recovery) {
                  setActiveDrawer('recover')
                  setShowCertificate(true)
                } else {
                  setActiveDrawer('methods')
                }
              }}
              onExport={exportData}
            />
          )}

          {role !== 'Public' && (
            <div className="evidence-only">
              <ReleaseCases />
            </div>
          )}
        </main>

        {activeDrawer && (
          <aside className="umbra-agent-dock" aria-label={activeDrawer === 'agent' ? 'Umbra Agent' : activeDrawer === 'recover' ? 'Pareto Pad Recovery' : activeDrawer === 'power' ? 'Power & Cost Sizing' : 'Methods & Data'}>
            <div className="umbra-agent-header">
              <div className="umbra-agent-title">
                {activeDrawer === 'agent' && <Sparkles size={14} />}
                {activeDrawer === 'recover' && <Search size={14} />}
                {activeDrawer === 'power' && <Zap size={14} />}
                {activeDrawer === 'methods' && <Globe2 size={14} />}
                <strong>{activeDrawer === 'agent' ? 'Umbra Agent' : activeDrawer === 'recover' ? 'Pareto Pad Recovery' : activeDrawer === 'power' ? 'Power & Cost Sizing' : 'Methods & Data'}</strong>
              </div>
              <button type="button" onClick={() => setActiveDrawer(null)} aria-label="Close side panel">✕</button>
            </div>
            {activeDrawer === 'agent' && (
              <AgentDrawer chatMessages={chatMessages} agentBusy={agentBusy} chatInput={chatInput} setChatInput={setChatInput} onSend={sendAgentPrompt} threadRef={agentThreadRef} />
            )}
            {activeDrawer === 'recover' && (
              <RecoveryDrawer
                recoveryScope={recoveryScope}
                setRecoveryScope={setRecoveryScope}
                recoveryRobustness={recoveryRobustness}
                setRecoveryRobustness={setRecoveryRobustness}
                recoveryWindowFrom={recoveryWindowFrom}
                setRecoveryWindowFrom={setRecoveryWindowFrom}
                recoveryWindowThrough={recoveryWindowThrough}
                setRecoveryWindowThrough={setRecoveryWindowThrough}
                days={days}
                start={start}
                scenarios={scenarios}
                searchReady={searchReady}
                progress={progress}
                search={search}
                sortedSearchOptions={sortedSearchOptions}
                searchSort={searchSort}
                setSearchSort={setSearchSort}
                showCertificate={showCertificate}
                setShowCertificate={setShowCertificate}
                onRunSearch={runAlternativeSearch}
                onCancelSearch={() => { worker.current?.postMessage({ kind: 'cancel' }); searchId.current = 0; setProgress('') }}
                onDownloadCertificate={downloadCertificate}
                onApplyCandidate={patch => { update(1, patch); setActive(1) }}
              />
            )}
            {activeDrawer === 'power' && (
              <PowerDrawer
                two={two}
                delta={delta}
                power={power}
                setPower={setPower}
                arrayMode={arrayMode}
                rates={rates}
                setRates={setRates}
                equipment={equipment}
                setEquipment={setEquipment}
                canCompareTwin={canCompareTwin}
                twin={twin}
                transferW={transferW}
                setTransferW={setTransferW}
                transferPct={transferPct}
                setTransferPct={setTransferPct}
                twinKg={twinKg}
                setTwinKg={setTwinKg}
              />
            )}
            {activeDrawer === 'methods' && (
              <MethodsDrawer result={result} sky={sky} scenarios={scenarios} active={active} sigma={sigma} limits={limits} onExportSamples={() => exportData('samples')} />
            )}
          </aside>
        )}
      </div>
    </div>
  )
}
