import { useEffect, useMemo, useRef, useState } from 'react'
import { Compass, Globe2, Search, Share2, Sparkles, Zap } from 'lucide-react'
import { AgentDrawer } from './AgentDrawer'
import { DecisionBrief } from './DecisionBrief'
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
import { complementaryPower, MADRID_STATION, solarThreshold, type ArrayMode, type Power, type Scenario } from './model'
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
  const [active, setActive] = useState(() => new URLSearchParams(location.search).get('replay') === 'nearby' ? 1 : 0)
  const [index, setIndex] = useState(0)
  const [canRender3D] = useState(webglAvailable)
  const [view, setView] = useState<'orbit' | 'pad' | 'polar' | 'chart'>(canRender3D ? 'orbit' : 'chart')
  const [overlay, setOverlay] = useState<TerrainOverlay>('relief')
  const [compareOverlay, setCompareOverlay] = useState(true)
  const [look, setLook] = useState<'sun' | 'earth' | 'north'>('earth')
  const [hoverAz, setHoverAz] = useState<number | null>(null)
  const [experiment, setExperiment] = useState(() => {
    const query = new URLSearchParams(location.search)
    return query.has('comparison') ? (saved.scenarios.some(s => s.site === 'custom') ? 'custom' : 'modified')
      : query.get('replay') === 'nearby' ? 'recovery' : 'delay'
  })
  const [alignMode, setAlignMode] = useState<'met' | 'utc'>('met')
  const [showIntro, setShowIntro] = useState(() => new URLSearchParams(location.search).has('intro'))
  const entered = useRef(!showIntro)
  const introFocus: IntroFocus = 'system'
  const [playing, setPlaying] = useState(false)
  const [progress, setProgress] = useState('')
  const [search, setSearch] = useState<SearchResultState | null>(null)
  const [appliedAltKey, setAppliedAltKey] = useState<string | null>(null)
  const preserveSearchOnNextCompare = useRef(false)
  const [searchSort, setSearchSort] = useState<'target' | 'dark' | 'earth' | 'slope' | 'starts'>('target')
  const [recoveryScope, setRecoveryScope] = useState<'all-polar' | 'same-site'>('all-polar')
  const [recoveryRobustness, setRecoveryRobustness] = useState<RobustnessPreference>('dual-extent-and-sigma')
  const [recoveryWindowFrom, setRecoveryWindowFrom] = useState<number>(saved.scenarios[1].start)
  const [recoveryWindowThrough, setRecoveryWindowThrough] = useState<number>(720)
  const [showCertificate, setShowCertificate] = useState(false)
  const [activeDrawer, setActiveDrawer] = useState<'agent' | 'recover' | 'power' | 'methods' | null>(null)
  const drawerCloseRef = useRef<HTMLButtonElement | null>(null)
  const [verbosity, setVerbosity] = useState<'minimal' | 'moderate' | 'detailed'>('minimal')
  const [chatInput, setChatInput] = useState('')
  const [agentBusy, setAgentBusy] = useState(false)
  const [agentStatus, setAgentStatus] = useState('')
  const agentAbortRef = useRef<AbortController | null>(null)
  const agentThreadRef = useRef<HTMLDivElement | null>(null)
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([
    {
      id: 'welcome',
      sender: 'agent',
      headline: 'Umbra Agent ready',
      text: 'Ask about the selected pad, sunlight, Earth visibility, or modeled power. I can also switch the view. Any workspace changes will appear in the conversation.',
    },
  ])
  const [modules, setModules] = useState({
    compare: true,
    sky: true,
    metrics: true,
    timeline: true,
  })
  const worker = useRef<Worker | null>(null)
  const searchWorker = useRef<Worker | null>(null)
  const serial = useRef(0)
  const comparisonId = useRef(0)
  const searchId = useRef(0)
  const restoreVersion = useRef(saved.versions)

  useEffect(() => {
    if (!canRender3D) return
    const timer = window.setTimeout(() => {
      if (showIntro) void import('./IntroScene')
      else void import('./SkyScene')
    }, 60)
    return () => window.clearTimeout(timer)
  }, [canRender3D, showIntro])

  useEffect(() => {
    const compareInst = new Worker(new URL('./planner.worker.ts', import.meta.url), { type: 'module' })
    compareInst.onmessage = ({ data }) => {
      if (data.kind === 'compare' && data.id === comparisonId.current) {
        const version = restoreVersion.current
        restoreVersion.current = undefined
        if (version && data.items.some((x: Result, i: number) => fingerprint(x) !== version[i])) {
          setError('This shared comparison references a different data release.')
          setPending(false)
          return
        }
        setItems(data.items)
        setPending(false)
      } else if (data.kind === 'compare-details' && data.id === comparisonId.current) {
        setItems(previous => previous?.map((item, i) => ({ ...item, ...data.details[i] })) ?? null)
      } else if (data.kind === 'error' && data.id === comparisonId.current) {
        setPending(false)
        setError(data.message)
      }
    }
    compareInst.onerror = () => {
      setPending(false)
      setError('The analysis worker stopped. Reload to restart it.')
    }
    worker.current = compareInst

    const searchInst = new Worker(new URL('./planner.worker.ts', import.meta.url), { type: 'module' })
    searchInst.onmessage = ({ data }) => {
      if (data.id === searchId.current && data.kind === 'progress') {
        setProgress(data.stage ?? `${name(data.site)} · pad ${data.node + 1} of 961`)
      } else if (data.id === searchId.current && data.kind === 'search') {
        setProgress('')
        setSearch(data)
      } else if (data.kind === 'error' && data.id === searchId.current) {
        setProgress('')
        setNotice(data.message)
      }
    }
    searchInst.onerror = () => {
      setProgress('')
      setNotice('The recovery search worker stopped. Retry search or reload.')
    }
    searchWorker.current = searchInst

    return () => {
      compareInst.terminate()
      worker.current = null
      searchInst.terminate()
      searchWorker.current = null
    }
  }, [])

  useEffect(() => {
    setPending(true)
    setError('')
    setProgress('')
    if (preserveSearchOnNextCompare.current) {
      preserveSearchOnNextCompare.current = false
    } else {
      setSearch(null)
      setShowCertificate(false)
      setAppliedAltKey(null)
    }
    searchId.current = 0
    const id = (comparisonId.current = ++serial.current)
    worker.current?.postMessage({ id, kind: 'compare', scenarios, days, power, limits } satisfies Request)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scenarios, days, power, limits, retry])

  useEffect(() => {
    if (!activeDrawer) return
    const invoker = document.activeElement
    drawerCloseRef.current?.focus({ preventScroll: true })
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setActiveDrawer(null)
    }
    window.addEventListener('keydown', onKeyDown)
    return () => {
      window.removeEventListener('keydown', onKeyDown)
      if (invoker instanceof HTMLElement && invoker.isConnected) invoker.focus({ preventScroll: true })
    }
  }, [activeDrawer])

  useEffect(() => {
    if (!playing || !items) return
    const id = setInterval(() => setIndex(i => (i + 12) % items[0].report.sky.length), 160)
    return () => clearInterval(id)
  }, [playing, items])

  useEffect(() => {
    searchWorker.current?.postMessage({ kind: 'cancel' })
    searchId.current = 0
    setSearch(null)
    setProgress('')
    setShowCertificate(false)
  }, [recoveryScope, recoveryRobustness, recoveryWindowFrom, recoveryWindowThrough])

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

  const update = (i: number, patch: Partial<Scenario>, opts?: { preserveSearch?: boolean }) => {
    restoreVersion.current = undefined
    if (opts?.preserveSearch) preserveSearchOnNextCompare.current = true
    setScenarios(previous => {
      const next = previous.map((s, j) => (j === i ? { ...s, ...patch } : s)) as [Scenario, Scenario]
      const usesCustomCoords = next.some(s => s.site === 'custom')
      setExperiment(prev => (usesCustomCoords ? 'custom' : prev === 'delay' || prev === 'recovery' || prev === 'ridge' || prev === 'mast' || prev === 'sites' || prev === 'power' || prev === 'apollo' ? 'modified' : prev))
      return next
    })
  }

  const swapScenarios = () => {
    restoreVersion.current = undefined
    setExperiment(scenarios.some(s => s.site === 'custom') ? 'custom' : 'modified')
    setScenarios([scenarios[1], scenarios[0]])
    setActive(a => 1 - a)
  }

  const applyPreset = (
    nextScenarios: [Scenario, Scenario],
    options: { active?: number; tab?: TabId; arrayMode?: ArrayMode; view?: 'orbit' | 'pad' | 'polar' | 'chart'; overlay?: TerrainOverlay; presetId?: string } = {},
  ) => {
    restoreVersion.current = undefined
    setExperiment(options.presetId ?? (nextScenarios.some(s => s.site === 'custom') ? 'custom' : 'modified'))
    setDays(15)
    setLimits(defaults.limits)
    setScenarios(nextScenarios)
    setActive(options.active ?? 0)
    setIndex(0)
    setPlaying(false)
    setPower({ ...defaults.power, arrayMode: options.arrayMode ?? defaults.power.arrayMode })
    setRates(defaults.rates)
    setEquipment(defaults.equipment)
    setRecoveryWindowFrom(nextScenarios[1].start)
    setRecoveryWindowThrough(720)
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
  const searchReady = Boolean(items?.every(x => x.terrain && x.meta.regional) && scenarios.every(s => polarSites.includes(s.site)))
  const samePolarSite = polarSites.includes(scenarios[0].site) && scenarios[0].site === scenarios[1].site && scenarios[0].node !== scenarios[1].node
  const secondaryNode = samePolarSite ? scenarios[1 - active].node : null

  const runAlternativeSearch = () => {
    if (!result || !searchReady || progress || pending) return
    const id = (searchId.current = ++serial.current)
    const maxAllowedStart = Math.max(0, 720 - days * 24)
    const clampedFrom = Math.max(0, Math.min(maxAllowedStart, recoveryWindowFrom))
    const clampedThrough = Math.max(clampedFrom, Math.min(maxAllowedStart, recoveryWindowThrough))
    const scopeSites =
      recoveryScope === 'same-site' && polarSites.includes(scenarios[1].site) ? [scenarios[1].site] : polarSites
    setProgress('Running counterfactual mission recovery across LOLA terrain profiles…')
    setSearch(null)
    setShowCertificate(false)
    searchWorker.current?.postMessage({
      kind: 'search',
      id,
      days,
      power,
      limits,
      mast: scenarios[1].mast,
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
          requestAnimationFrame(() => document.querySelector('.sky-panel')?.scrollIntoView({ behavior: 'smooth', block: 'nearest' }))
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
          requestAnimationFrame(() => document.querySelector('.sky-panel')?.scrollIntoView({ behavior: 'smooth', block: 'nearest' }))
        }
      }
      if (act.mode === 'learner') {
        setModules({ compare: true, sky: true, metrics: true, timeline: true })
        setView(canRender3D ? 'pad' : 'chart')
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

  const cancelAgentPrompt = () => {
    if (!agentAbortRef.current) return
    agentAbortRef.current.abort()
    agentAbortRef.current = null
    setAgentBusy(false)
    setAgentStatus('')
    setChatMessages(prev => [...prev, { id: `c-${Date.now()}`, sender: 'agent', text: 'Request cancelled.' }])
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
    setAgentStatus('Connecting to Umbra Agent...')
    const ac = new AbortController()
    agentAbortRef.current = ac

    try {
      const response = await fetch('/api/research/ask', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream, application/json' },
        signal: ac.signal,
        body: JSON.stringify({
          question: q,
          history,
          context: {
            scenarios,
            days,
            limits,
            activeView: view,
            activeOverlay: overlay,
          },
        }),
      })
      if (!response.ok) throw new Error(`Study API returned HTTP ${response.status}`)

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      let data: any = null
      const ctype = response.headers.get('content-type') ?? ''
      if (ctype.includes('text/event-stream') && response.body) {
        const reader = response.body.getReader()
        const decoder = new TextDecoder()
        let buf = ''
        let currentEvent = 'message'
        while (true) {
          const { done, value } = await reader.read()
          if (done) break
          buf += decoder.decode(value, { stream: true })
          let nl = buf.indexOf('\n\n')
          while (nl !== -1) {
            const block = buf.slice(0, nl)
            buf = buf.slice(nl + 2)
            let evName = currentEvent
            const dataLines: string[] = []
            for (const line of block.split(/\r?\n/)) {
              if (line.startsWith('event:')) evName = line.slice(6).trim()
              else if (line.startsWith('data:')) dataLines.push(line.slice(5).trim())
            }
            const rawData = dataLines.join('\n')
            if (rawData) {
              const parsed = JSON.parse(rawData)
              if (evName === 'progress' && parsed?.detail) {
                setAgentStatus(parsed.detail)
              } else if (evName === 'result') {
                data = parsed
              } else if (evName === 'error') {
                throw new Error(parsed?.error ?? 'Agent stream failed')
              }
            }
            currentEvent = 'message'
            nl = buf.indexOf('\n\n')
          }
        }
      } else {
        data = await response.json()
      }

      if (!data) throw new Error('No response payload received')
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
      const certOutput = Array.isArray(data.toolOutputs)
        ? data.toolOutputs.find((r: { tool?: string; data?: { certificateSummary?: { deterministicFingerprint?: string } } }) =>
            (r.tool === 'get_decision_certificate' || r.tool === 'search_alternatives') && r.data?.certificateSummary?.deterministicFingerprint,
          )
        : null
      const certMeta = certOutput?.data?.certificateSummary
        ? {
            fingerprint: certOutput.data.certificateSummary.deterministicFingerprint,
            statusCategory: certOutput.data.certificateSummary.statusCategory,
            runSettings: certOutput.data.certificateSummary.runSettings ?? certOutput.data.runSettings,
          }
        : null

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
          certificate: certMeta,
        },
      ])
    } catch (err) {
      if ((err as { name?: string })?.name === 'AbortError' || ac.signal.aborted) {
        return
      }
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
      if (agentAbortRef.current === ac) agentAbortRef.current = null
      setAgentBusy(false)
      setAgentStatus('')
    }
  }

  const downloadCertificate = () => {
    if (!search?.recovery?.certificate) return
    download('umbra-x-decision-certificate.json', JSON.stringify(search.recovery.certificate, null, 2), 'application/json')
  }

  const exportData = (format: 'json' | 'csv' | 'samples') => {
    if (!items) return
    if (format === 'samples') {
      const rows = ['scenario,utc,sun_az_deg,sun_el_deg,sun_horizon_deg,sun_sigma_deg,earth_az_deg,earth_el_deg,earth_horizon_deg,solar_fraction,array_incidence_factor,pv_w,dss14_geometry,dss63_geometry,dss43_geometry,three_station_geometry']
      items.forEach((x, i) =>
        x.report.sky.forEach((s, j) =>
          rows.push([i ? 'alternative' : 'baseline', utc(x.meta.start, scenarios[i].start + j / 12), s.sun.az, s.sun.el, s.sunHorizon, s.sunSigma, s.earth.az, s.earth.el, s.earthHorizon, s.solar, s.incidenceFactor, x.report.generation[j], s.stationCovered ? s.stationAccess : 'unknown', s.dss63Covered ? s.dss63Access : 'unknown', s.dss43Covered ? s.dss43Access : 'unknown', s.dsnCovered ? s.dsnAccess : 'unknown'].join(',')),
        ),
      )
      download('umbra-x-samples.csv', rows.join('\n'), 'text/csv')
      return
    }
    if (format === 'json') {
      download('umbra-x-comparison.json', JSON.stringify({ schema: 2, stationModel: MADRID_STATION, scenarios, days, limits, power, rates, equipment, versions: items.map(fingerprint), comparisonRecord, solarThreshold, results: items.map(x => ({ report: x.report, metadata: x.meta })) }, null, 2), 'application/json')
      return
    }
    const rows = ['scenario,interval,start_utc,end_utc,duration_hours,already_underway,continues_at_end']
    items.forEach((x, i) => {
      for (const key of ['dark', 'earth', 'station', 'dsn', 'dsnBlackout', 'dsnUnknown'] as const) {
        for (const e of x.report[key]) {
          rows.push([i ? 'alternative' : 'baseline', key, utc(x.meta.start, scenarios[i].start + e.start / 12), utc(x.meta.start, scenarios[i].start + e.end / 12), e.hours, e.atStart, e.atEnd].join(','))
        }
      }
    })
    download('umbra-x-events.csv', rows.join('\n'), 'text/csv')
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
    if (id === 'apollo') applyPreset([{ ...initial[0], site: 'apollo-11', mast: 0 }, initial[0]], { arrayMode: 'horizontal', view: 'chart', presetId: 'apollo' })
    else if (alternative[id]) applyPreset([id === 'mast' ? { ...initial[0], mast: 0 } : id === 'recovery' ? initial[1] : initial[0], alternative[id]], { presetId: id, view: canRender3D ? 'orbit' : 'chart', active: id === 'recovery' ? 1 : 0 })
    if (id === 'power') setActiveDrawer('power')
    else setActiveDrawer(null)
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
        introFocus={introFocus}
        onEnter={() => {
          entered.current = true
          setShowIntro(false)
        }}
      />
    )
  }

  const replay = (variant: 'delay' | 'nearby') => {
    applyPreset(variant === 'nearby' ? [initial[1], delayedAlternative] : initial, {
      presetId: variant === 'nearby' ? 'recovery' : 'delay',
      active: variant === 'nearby' ? 1 : 0,
      view: canRender3D ? 'pad' : 'chart',
      overlay: 'relief',
    })
    setLook('earth')
    setAlignMode('met')
    setActiveDrawer(null)
    setModules({ compare: true, sky: true, metrics: true, timeline: true })
  }
  const isGuidedScenario = (a: Scenario, b: Scenario) =>
    a.site === b.site && a.node === b.node && a.mast === b.mast && a.start === b.start
  const guided = days === defaults.days &&
    limits.dark === defaults.limits.dark && limits.earth === defaults.limits.earth && limits.slope === defaults.limits.slope &&
    (power.sigma ?? 0) === 0
    ? isGuidedScenario(scenarios[0], initial[0]) && isGuidedScenario(scenarios[1], initial[1]) ? 'delay'
      : isGuidedScenario(scenarios[0], initial[1]) && isGuidedScenario(scenarios[1], delayedAlternative) ? 'nearby' : null
    : null

  const copilotOpen = activeDrawer === 'agent'

  return (
    <div className="mission">
      <a className="skip-link" href="#main-workspace">Skip to mission workspace</a>
      <header className="mission-header">
        <button type="button" className="mission-brand mission-brand-btn" title="Explore the interactive Moon globe" onClick={() => setShowIntro(true)}>
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
          <button type="button" className={activeDrawer === 'recover' ? 'mobile-chip active' : 'mobile-chip'} onClick={() => { setActiveDrawer(d => (d === 'recover' ? null : 'recover')); if (!search && searchReady && !progress) runAlternativeSearch() }}>Recover Pads</button>
          <button type="button" className={activeDrawer === 'power' ? 'mobile-chip active' : 'mobile-chip'} onClick={() => setActiveDrawer(d => (d === 'power' ? null : 'power'))}>Power &amp; Cost</button>
          <button type="button" className={activeDrawer === 'methods' ? 'mobile-chip active' : 'mobile-chip'} onClick={() => setActiveDrawer(d => (d === 'methods' ? null : 'methods'))}>Methods</button>
        </div>
      </div>

      <div className={activeDrawer ? 'mission-shell with-agent' : 'mission-shell'}>
        <aside className="workspace-rail" aria-label="Workspace panels">
          <span className="rail-heading">Study</span>
          <select className="rail-select" aria-label="Mission study preset" value={experiment} onChange={e => openExperiment(e.target.value)}>
            <option value="delay">48-hour landing delay</option>
            <option value="recovery">Nearby Pad #479</option>
            <option value="ridge">Shackleton Pads #481 and #482</option>
            <option value="mast">1.5m vs 20m Mast</option>
            <option value="sites">Shackleton vs Mons Mouton</option>
            <option value="power">Power, Mass &amp; $/kg</option>
            <option value="apollo">Apollo 11 vs South Pole</option>
            <option value="custom">Custom Lat/Lon</option>
            {experiment === 'modified' && (
              <option value="modified" hidden>{name(scenarios[1].site)} (Custom)</option>
            )}
          </select>
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
          <details className="rail-prefs">
            <summary className="rail-heading rail-prefs-summary">Display</summary>
            <div className="rail-prefs-body">
              {([{ id: 'metrics', label: 'KPIs', icon: <Sparkles size={13} /> }, { id: 'timeline', label: 'Timeline', icon: <Compass size={13} /> }] as const).map(m => (
                <button key={m.id} type="button" className={modules[m.id] ? 'rail-btn active' : 'rail-btn'} aria-pressed={modules[m.id]} onClick={() => setModules(prev => ({ ...prev, [m.id]: !prev[m.id] }))}>
                  {m.icon}<span>{m.label}</span>
                </button>
              ))}
              <div className="rail-verbosity" role="group" aria-label="Description verbosity">
                {(['minimal', 'moderate', 'detailed'] as const).map(v => (
                  <button key={v} type="button" className={verbosity === v ? 'rail-verb-btn active' : 'rail-verb-btn'} aria-pressed={verbosity === v} onClick={() => setVerbosity(v)}>
                    {v[0].toUpperCase() + v.slice(1)}
                  </button>
                ))}
              </div>
            </div>
          </details>
        </aside>

        <main
          id="main-workspace"
          className="mission-body"
          data-layout="hero"
          data-mode="planner"
          data-recovery={activeDrawer === 'recover' ? 'open' : 'closed'}
          data-verbosity={verbosity}
          data-mod-compare={modules.compare ? 'on' : 'off'}
          data-mod-sky={modules.sky ? 'on' : 'off'}
          data-mod-metrics={modules.metrics ? 'on' : 'off'}
          data-mod-timeline={modules.timeline ? 'on' : 'off'}
        >
          <p className="detailed-context-note">
            Counterfactual Lunar Mission Navigator: compare Baseline vs Alternative windows across 2,883 LRO LOLA (20 m local / 96 km regional) candidate pads and JPL DE440 ephemerides.
          </p>

          {notice && (
            <p className="mission-note" role="status">
              <span>{notice}</span> <button onClick={() => setNotice('')}>Dismiss</button>
            </p>
          )}

          <DecisionBrief
            guided={guided}
            ready={Boolean(comparisonRecord && !pending && !error)}
            onReplay={replay}
            onInspect={() => {
              setModules(prev => ({ ...prev, sky: true }))
              inspectWorstBlackout('earth')
              requestAnimationFrame(() => {
                const section = document.getElementById('lunar-sky')
                section?.focus({ preventScroll: true })
                section?.scrollIntoView({ block: 'nearest' })
              })
            }}
          />

          <ScenarioBar
            scenarios={scenarios}
            items={items}
            comparisonRecord={comparisonRecord}
            active={active}
            setActive={setActive}
            days={days}
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
              alignMode={alignMode}
              setAlignMode={setAlignMode}
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
              update={update}
              setScenarios={setScenarios}
              onClearSearch={() => setSearch(null)}
              onInspectWorstBlackout={inspectWorstBlackout}
              onExport={exportData}
            />
          )}

          <div className="evidence-only">
            <ReleaseCases />
          </div>
        </main>

        {activeDrawer && (
          <aside className={`umbra-agent-dock drawer-${activeDrawer}`} aria-label={activeDrawer === 'agent' ? 'Umbra Agent' : activeDrawer === 'recover' ? 'Pareto Pad Recovery' : activeDrawer === 'power' ? 'Power & Cost Sizing' : 'Methods & Data'}>
            <div className="umbra-agent-header">
              <div className="umbra-agent-title">
                {activeDrawer === 'agent' && <Sparkles size={14} />}
                {activeDrawer === 'recover' && <Search size={14} />}
                {activeDrawer === 'power' && <Zap size={14} />}
                {activeDrawer === 'methods' && <Globe2 size={14} />}
                <strong>{activeDrawer === 'agent' ? 'Umbra Agent' : activeDrawer === 'recover' ? 'Pareto Pad Recovery' : activeDrawer === 'power' ? 'Power & Cost Sizing' : 'Methods & Data'}</strong>
              </div>
              <button ref={drawerCloseRef} type="button" onClick={() => setActiveDrawer(null)} aria-label="Close side panel" title="Close (Esc)">✕</button>
            </div>
            {activeDrawer === 'agent' && (
              <AgentDrawer
                chatMessages={chatMessages}
                agentBusy={agentBusy}
                agentStatus={agentStatus}
                chatInput={chatInput}
                setChatInput={setChatInput}
                onSend={sendAgentPrompt}
                onCancel={cancelAgentPrompt}
                threadRef={agentThreadRef}
              />
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
                appliedAltKey={appliedAltKey}
                currentResult={pending ? null : comparisonRecord?.alternative ?? null}
                onRunSearch={runAlternativeSearch}
                onCancelSearch={() => { worker.current?.postMessage({ kind: 'cancel' }); searchId.current = 0; setProgress('') }}
                onDownloadCertificate={downloadCertificate}
                onApplyCandidate={patch => {
                  const key = `${patch.site ?? scenarios[1].site}:${patch.node ?? scenarios[1].node}:${patch.start ?? scenarios[1].start}`
                  setAppliedAltKey(key)
                  update(1, patch, { preserveSearch: true })
                  setActive(1)
                }}
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
              <MethodsDrawer result={result} sky={sky} scenarios={scenarios} active={active} cursor={cursor} sigma={sigma} limits={limits} onExportSamples={() => exportData('samples')} />
            )}
          </aside>
        )}
      </div>
    </div>
  )
}
