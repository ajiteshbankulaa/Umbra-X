import { useEffect, useRef, useState } from 'react'
import { names } from './data'
import { interpretStudy, studyExamples } from './studyRequest'
import type { StudyPlan } from './studyRequest'
import type { Limits, Power, Scenario } from './model'
import type { Request } from './planner.worker'

type Props = {
  scenarios: [Scenario, Scenario]
  active: number
  days: number
  limits: Limits
  power: Power
  epoch: string
  hours: number
  version?: string
  onCompare: (scenarios: [Scenario, Scenario], days: number, limits?: Limits) => void
  onTerrain: (scenario?: Scenario, days?: number) => void
}

type SearchOutput = {
  count: number
  options: { scenario: Scenario; starts: number; slope: number }[]
}

export function AskStudy(props: Props) {
  const [question, setQuestion] = useState('')
  const [draft, setDraft] = useState<StudyPlan>()
  const [message, setMessage] = useState('')
  const [busy, setBusy] = useState(false)
  const [output, setOutput] = useState<SearchOutput>()
  const [searchRun, setSearchRun] = useState<Extract<StudyPlan, { kind: 'search' }>>()
  const [service, setService] = useState<{ modelConfigured: boolean }>()
  const [runId, setRunId] = useState<string>()
  const [trace, setTrace] = useState<string[]>([])
  const worker = useRef<Worker | null>(null)
  const request = useRef<AbortController | null>(null)
  const runRef = useRef<string | null>(null)
  const stop = () => {
    worker.current?.terminate()
    worker.current = null
  }
  useEffect(() => {
    const controller = new AbortController()
    fetch('/api/study/coverage', { signal: controller.signal })
      .then(response => response.ok ? response.json() : null)
      .then(data => { if (typeof data?.modelConfigured === 'boolean') setService(data) })
      .catch(() => {})
    return () => { controller.abort(); request.current?.abort(); stop() }
  }, [])
  const utc = (hour: number) => new Date(Date.parse(props.epoch) + hour * 3600000).toISOString().slice(0, 16).replace('T', ' ') + ' UTC'
  const site = (scenario: Scenario) => names[scenario.site] ?? scenario.site
  const describe = (scenario: Scenario) => {
    const pad = ['shackleton-ridge', 'mons-mouton', 'malapert-massif'].includes(scenario.site) ? ` pad ${scenario.node + 1}` : ''
    return `${site(scenario)}${pad} · ${utc(scenario.start)} · ${[1.5, 3, 5, 10, 20][scenario.mast]} m mast`
  }

  async function api(path: string, signal: AbortSignal, body?: unknown) {
    const response = await fetch('/api/study/' + path, {
      signal, ...(body === undefined ? {} : {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      }),
    })
    const data = await response.json()
    if (!response.ok) throw new Error(data.error ?? 'Study service unavailable.')
    return data
  }

  async function prepare() {
    setDraft(undefined)
    setOutput(undefined)
    setTrace([])
    setRunId(undefined)
    let interpretation = interpretStudy(question, props)
    if (service?.modelConfigured && question.trim()) {
      const controller = new AbortController()
      request.current = controller
      setBusy(true)
      setMessage('Checking coverage and preparing a study…')
      try {
        const { scenarios, active, days, limits } = props
        const result = await api('interpret', controller.signal, { question, context: { scenarios, active, days, limits } })
        if (controller.signal.aborted) return
        interpretation = result
        setTrace(result.trace ?? [])
      } catch (error) {
        if (!controller.signal.aborted) setMessage(error instanceof Error ? error.message : 'Model request failed.')
        return
      } finally {
        if (!controller.signal.aborted) setBusy(false)
      }
    }
    if (interpretation.status === 'ready') {
      setDraft(interpretation.plan)
      setMessage('')
    } else {
      setMessage(interpretation.message)
    }
  }

  function showResult(plan: StudyPlan) {
    if (plan.kind === 'compare') props.onCompare(plan.scenarios, plan.days)
    if (plan.kind === 'terrain') props.onTerrain(plan.scenarios?.[0], plan.days)
  }

  async function run(plan: StudyPlan) {
    setDraft(undefined)
    setRunId(undefined)
    if (service && (plan.kind !== 'compare' || plan.scenarios.every(s => ['shackleton-ridge', 'mons-mouton', 'malapert-massif'].includes(s.site)))) {
      const controller = new AbortController()
      request.current = controller
      setBusy(true)
      setOutput(undefined)
      setMessage('Submitting study…')
      if (plan.kind === 'search') setSearchRun(plan)
      try {
        const payload = plan.kind === 'terrain' ? {
          kind: 'terrain', scenarios: plan.scenarios ?? [props.scenarios[props.active]], days: plan.days ?? props.days,
        } : plan
        let job = await api('runs', controller.signal, { plan: payload, sigma: props.power.sigma ?? 0 })
        runRef.current = job.id
        setRunId(job.id)
        while (job.state === 'queued' || job.state === 'running') {
          setMessage(job.progress ? `Searching ${names[job.progress.site]} · pad ${job.progress.node + 1} of 961` : 'Study ' + job.state + '…')
          await new Promise(resolve => setTimeout(resolve, 350))
          job = await api('runs/' + job.id, controller.signal)
        }
        if (job.state !== 'completed') {
          setMessage(job.error ?? 'Study ' + job.state + '.')
          return
        }
        if (plan.kind === 'search') {
          setOutput(job.result)
          setMessage(job.result.count ? `${job.result.count.toLocaleString()} pad/start pairs meet your geometry limits.` :
            'No evaluated pad/start pairs meet your geometry limits in this region and date range.')
        } else {
          showResult(plan)
          setMessage('Study completed. The matching diagram is open below.')
        }
      } catch (error) {
        if (!controller.signal.aborted) setMessage(error instanceof Error ? error.message : 'Study request failed.')
      } finally {
        if (!controller.signal.aborted) { setBusy(false); runRef.current = null }
      }
      return
    }
    if (plan.kind === 'compare') {
      props.onCompare(plan.scenarios, plan.days)
      setMessage('Comparison opened below. Use the diagram controls to change the view.')
      return
    }
    if (plan.kind === 'terrain') {
      props.onTerrain(plan.scenarios?.[0], plan.days)
      setMessage('Opened terrain sensitivity below. This compares horizon extent at the selected pad.')
      return
    }
    if (!props.version) {
      setMessage('The NASA study data is still loading or unavailable. Wait for the planner data before running a search.')
      return
    }
    stop()
    setOutput(undefined)
    setSearchRun(plan)
    setBusy(true)
    setMessage('Searching the compiled polar grids…')
    const instance = new Worker(new URL('./planner.worker.ts', import.meta.url), { type: 'module' })
    worker.current = instance
    const finish = (text: string) => {
      stop()
      setBusy(false)
      setMessage(text)
    }
    instance.onerror = () => finish('The study worker stopped. Try running the request again.')
    instance.onmessage = ({ data }) => {
      if (data.kind === 'progress') setMessage(`Searching ${names[data.site]} · pad ${data.node + 1} of 961`)
      if (data.kind === 'error') finish(`Study data unavailable. ${data.message}`)
      if (data.kind === 'search') {
        setOutput(data)
        finish(data.count ? `${data.count.toLocaleString()} pad/start pairs meet your geometry limits.` :
          'No evaluated pad/start pairs meet your geometry limits in this region and date range.')
      }
    }
    instance.postMessage({ id: 1, kind: 'search', days: plan.days, limits: plan.limits, mast: plan.mast,
      power: props.power, version: props.version, scope: { sites: plan.sites, from: plan.from, through: plan.through } } satisfies Request)
  }

  return <section className="ask-study" aria-label="Ask a lunar question">
    <form onSubmit={event => { event.preventDefault(); prepare() }}>
      <label htmlFor="lunar-study-question">Ask a lunar question</label>
      <div className="ask-study-input">
        <input id="lunar-study-question" value={question} maxLength={500} disabled={busy}
          placeholder="Compare Shackleton and Mons Mouton for 15 days"
          onChange={event => { setQuestion(event.target.value); setDraft(undefined) }} />
        <button type="submit" disabled={busy}>Review study</button>
        {busy && <button type="button" onClick={() => {
          request.current?.abort()
          stop()
          const id = runRef.current
          runRef.current = null
          setBusy(false)
          if (id) {
            setMessage('Canceling study…')
            fetch('/api/study/runs/' + id, { method: 'DELETE' })
              .then(async response => { if (!response.ok) throw new Error(); setMessage('Study ' + (await response.json()).state + '.') })
              .catch(() => setMessage('The server could not confirm cancellation. Check the saved run.'))
          } else setMessage('Request canceled.')
        }}>Cancel</button>}
      </div>
    </form>
    <div className="ask-examples" aria-label="Example requests">
      {studyExamples.map(example => <button type="button" key={example.label} disabled={busy}
        onClick={() => { setQuestion(example.question); setMessage(''); setDraft(undefined); setOutput(undefined) }}>{example.label}</button>)}
    </div>
    <p className="ask-coverage">{service?.modelConfigured ? 'Model tools connected' : service ? 'Study server connected · local request parser' : 'Local study tools'} · {utc(0)} to {utc(props.hours)}</p>
    {message && <p role="status">{message}</p>}
    {trace.length > 0 && <details><summary>Tools used</summary><ol>{trace.map((name, i) => <li key={i}>{name.replaceAll('_', ' ')}</li>)}</ol></details>}
    {runId && <p><a href={'/api/study/runs/' + runId} target="_blank" rel="noreferrer">Open saved study record</a></p>}
    {draft && <div className="ask-draft">
      <p>{draft.kind === 'search'
        ? `${draft.sites.map(id => names[id]).join(', ')} · ${draft.days} days · ${[1.5, 3, 5, 10, 20][draft.mast]} m mast`
        : draft.kind === 'compare' ? `Compare two ${draft.days}-day mission windows` : 'Inspect 48 km and 96 km terrain horizons at the selected pad'}</p>
      {draft.kind === 'search' && <>
        <p>Hourly starts · {utc(draft.from)} through {utc(draft.through)}</p>
        <p>Low light ≤ {draft.limits.dark} h · Earth obstruction ≤ {draft.limits.earth} h · Slope ≤ {draft.limits.slope}° · Local error ×{props.power.sigma ?? 0}</p>
      </>}
      {draft.kind === 'compare' && <ul>{draft.scenarios.map((scenario, i) => <li key={i}>{describe(scenario)}</li>)}</ul>}
      {draft.kind === 'terrain' && <p>{describe(draft.scenarios?.[0] ?? props.scenarios[props.active])} · {draft.days ?? props.days} days</p>}
      <button type="button" onClick={() => run(draft)}>{draft.kind === 'terrain' ? 'Open terrain evidence' : 'Run study'}</button>
    </div>}
    {!!output?.options.length && searchRun && <div className="ask-shortlist">
      <p>First passing start per pad, ordered by UTC and then slope. Open an alternative to inspect its sky and timeline.</p>
      <ul>{output.options.map(({ scenario, slope, starts }) => <li key={scenario.site + scenario.node}>
        <span>{describe(scenario)} · {slope.toFixed(1)}° slope · {starts} passing starts</span>
        <button type="button" onClick={() => props.onCompare([
          { ...props.scenarios[0], start: Math.min(props.scenarios[0].start, props.hours - searchRun.days * 24) },
          scenario,
        ], searchRun.days, searchRun.limits)}>Compare</button>
      </li>)}</ul>
    </div>}
  </section>
}
